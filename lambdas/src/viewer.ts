// The viewer Lambda — the browser dashboard's server (DESIGN.md §7b).
//
// Serves two things on one Function URL:
//   GET  /            → the dashboard SPA (public HTML; it shows a login form)
//   GET  /api/...     → JSON reads, EVERY one gated on a verified Cognito JWT
//
// SECURITY MODEL, in one line: authorization is decided ONLY from verified token claims,
// never from anything the client sends. A viewer asking for a site they weren't granted gets
// 404 (not 403) so the dashboard cannot be used to enumerate which sites exist — the agency
// case in §7b requires that client A cannot learn client B is a customer.
//
// THE ONLINE DASHBOARD GATE (founder decision 2026-08-04): browser access is part of the
// paid tier — the free tier is desktop-only. A site is online-visible ONLY when its domain
// is covered by a deployed Online Dashboard edge, and the ONLY way an edge comes to exist
// is the app's entitlement-gated setup. Enforced HERE, server-side, from the edge records
// in the owner's own table — never by client-side filtering (the MailPoppy lesson), and
// never by calling the platform (no data, not even entitlement pings, leaves the owner's
// AWS — the §7c privacy line).
//
// The execution role is READ-ONLY on the table (GetItem/Query only), so even a total
// compromise of this function cannot alter or delete a single counter.

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { bearerToken, mayReadSite, verifyJwt, visibleSites, type Jwk, type ViewerClaims } from "./auth";
import { isFirstPartyFor } from "../../shared/src/first-party";
import { lastDays, reduceLive, reduceRange, type CounterRow } from "../../shared/src/range";
import { readGoals, type Goal } from "../../shared/src/goals";
import { dashboardHtml } from "./viewer-page";

const TABLE = process.env.TABLE_NAME ?? "";
const POOL_ID = process.env.USER_POOL_ID ?? "";
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? "";
const REGION = process.env.AWS_REGION ?? "";

const db = new DynamoDBClient({});

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
}
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Everything the router needs from the outside world — injected so routing is unit-testable. */
export interface ViewerDeps {
  listSites(): Promise<{ id: string; name: string; domain: string; goals?: Goal[] }[]>;
  dayRows(siteId: string, day: string): Promise<CounterRow[]>;
  recentRows(siteId: string): Promise<CounterRow[]>;
  /**
   * The Online Dashboard edge domains deployed in this account (from the truereach cert
   * rows). The paid gate: a site is served online only if one of these covers its domain.
   */
  edgeDomains(): Promise<string[]>;
  /** Verified claims, or undefined when the token is absent/invalid. Never throws. */
  authenticate(headers: Record<string, string | undefined>): Promise<ViewerClaims | undefined>;
  today(): string;
  now(): Date;
}

/** The paid gate's predicate: is this site covered by any deployed edge domain? */
const onlineEntitled = (site: { domain: string }, edgeDomains: string[]): boolean =>
  edgeDomains.some((edge) => isFirstPartyFor(site.domain, edge));

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const NOT_FOUND = () => json(404, { error: "not found" });

/**
 * Pure router. No AWS, no env, no clock — every dependency arrives in `deps`, so the whole
 * authorization surface can be tested exhaustively.
 */
export async function route(req: HttpRequest, deps: ViewerDeps): Promise<HttpResponse> {
  const path = req.path.replace(/\/+$/, "") || "/";

  // The SPA itself is public: it has to load before anyone can log in. It contains no data.
  //
  // EVERY non-/api GET serves it, not just "/" — the page has real URLs now (/site/<id>),
  // so a refresh, a bookmark or a shared link must land on the page it names instead of
  // 404ing. The edge already routes everything except /t.js and /e here, so this is the
  // only place that decision lives. (Founder ask 2026-08-07: "if a user refreshes the
  // stats of one website, he lands on the home page with the list of domains".)
  if (req.method === "GET" && !path.startsWith("/api/") && path !== "/favicon.ico") {
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The dashboard is a private view of a company's traffic — never let a shared cache
        // hold it, and never let it be framed (clickjacking a logout/settings control).
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
      body: dashboardHtml({ region: REGION, userPoolClientId: CLIENT_ID }),
    };
  }

  if (!path.startsWith("/api/")) return NOT_FOUND();

  // ── everything below this line requires a verified token ──────────────────────────
  const claims = await deps.authenticate(req.headers);
  if (!claims) return json(401, { error: "sign in to continue" });

  if (req.method === "GET" && path === "/api/sites") {
    const [all, edges] = await Promise.all([deps.listSites(), deps.edgeDomains()]);
    // Two server-side filters, both here and never in the client: the viewer's grants
    // (ungranted sites never leave the server) and the Online Dashboard gate (sites on
    // unsubscribed domains are desktop-only). `gated` lets the page explain the empty
    // state honestly instead of pretending nothing was shared.
    const online = all.filter((s) => onlineEntitled(s, edges));
    return json(200, {
      sites: visibleSites(claims, online),
      viewer: { email: claims.email },
      gated: edges.length === 0 || undefined,
    });
  }

  const m = /^\/api\/sites\/([^/]+)\/(range|live)$/.exec(path);
  if (req.method === "GET" && m) {
    const siteId = decodeURIComponent(m[1]!);
    // 404 rather than 403: a 403 would confirm the site exists (§7b enumeration guard).
    if (!mayReadSite(claims, siteId)) return NOT_FOUND();
    // The paid gate holds on direct reads too — knowing a site id must not bypass it.
    const [all, edges] = await Promise.all([deps.listSites(), deps.edgeDomains()]);
    const site = all.find((s) => s.id === siteId);
    if (!site || !onlineEntitled(site, edges)) return NOT_FOUND();

    if (m[2] === "live") {
      return json(200, { live: reduceLive(siteId, await deps.recentRows(siteId), deps.now()) });
    }

    // Either a rolling `days=N` ending today, or an explicit `from`/`to` (both inclusive,
    // YYYY-MM-DD). Both clamp to 90 days — an unbounded window is a free way to make the
    // owner's account do 10k queries — and `to` never exceeds today (nothing to read there).
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const { from, to } = req.query;
    let window: string[];
    if (from && to && DATE.test(from) && DATE.test(to) && from <= to) {
      const end = to < deps.today() ? to : deps.today();
      const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
      window = lastDays(Math.min(Math.max(span, 1), 90), end);
    } else {
      const requested = Number(req.query.days ?? "7");
      const days = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 90) : 7;
      window = lastDays(days, deps.today());
    }
    const prevEnd = new Date(`${window[0]}T00:00:00Z`).getTime() - 86_400_000;
    const prevWindow = lastDays(window.length, new Date(prevEnd).toISOString().slice(0, 10));

    const [perDay, perPrevDay] = await Promise.all([
      Promise.all(window.map((d) => deps.dayRows(siteId, d))),
      Promise.all(prevWindow.map((d) => deps.dayRows(siteId, d))),
    ]);
    // The site's goals name its counters (§7e) — same reduction as the desktop app, so
    // both dashboards report the same conversions from the same rows.
    return json(200, { range: reduceRange(siteId, window, perDay, perPrevDay, site.goals ?? []) });
  }

  return NOT_FOUND();
}

// ── real-world wiring ───────────────────────────────────────────────────────────────

let jwksCache: Jwk[] | undefined;
const issuer = () => `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;

/** Fetch and cache the pool's public keys. Cached per container; refetched if a kid misses. */
async function jwks(force = false): Promise<Jwk[]> {
  if (jwksCache && !force) return jwksCache;
  const res = await fetch(`${issuer()}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = body.keys ?? [];
  return jwksCache;
}

async function authenticate(headers: Record<string, string | undefined>): Promise<ViewerClaims | undefined> {
  const token = bearerToken(headers);
  if (!token) return undefined;
  const opts = { issuer: issuer(), clientId: CLIENT_ID, now: Math.floor(Date.now() / 1000) };
  try {
    return verifyJwt(token, { ...opts, jwks: await jwks() });
  } catch {
    // A miss may just mean Cognito rotated its signing keys — refetch once before giving up.
    try {
      return verifyJwt(token, { ...opts, jwks: await jwks(true) });
    } catch {
      return undefined;
    }
  }
}

async function queryRows(pk: string): Promise<CounterRow[]> {
  const out = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": { S: pk } },
    }),
  );
  return (out.Items ?? []).map((it) => ({ sk: it.sk?.S ?? "", count: Number(it.count?.N ?? "0") }));
}

const liveDeps: ViewerDeps = {
  authenticate,
  today: () => new Date().toISOString().slice(0, 10),
  now: () => new Date(),
  dayRows: (siteId, day) => queryRows(`site#${siteId}#day#${day}`),
  recentRows: (siteId) => queryRows(`site#${siteId}#recent`),
  // The deployed edge domains, straight from the sidecar's cert registry rows in this
  // same table. Value format `domain|arn[|stackName]` — reading the FIRST part works for
  // both the v1 single-domain row and v2 per-domain rows, so the gate is correct even
  // before the sidecar's migration has run.
  async edgeDomains() {
    const out = await db.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":p": { S: "truereach" }, ":s": { S: "cert#" } },
      }),
    );
    return (out.Items ?? [])
      .map((it) => (it.value?.S ?? "").split("|")[0] ?? "")
      .filter(Boolean);
  },
  async listSites() {
    const out = await db.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: "sites" } },
      }),
    );
    return (out.Items ?? [])
      .map((it) => ({
        id: it.siteId?.S ?? "",
        name: it.name?.S ?? "",
        domain: it.domain?.S ?? "",
        goals: readGoals(it.goals?.S),
      }))
      .filter((s) => s.id);
  },
};

/** Lambda Function URL entrypoint. */
export async function handler(event: {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
}): Promise<HttpResponse> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const query = Object.fromEntries(new URLSearchParams(event.rawQueryString ?? "").entries());
  try {
    return await route({ method, path, query, headers: event.headers ?? {} }, liveDeps);
  } catch (e) {
    // Never leak a stack trace or a table name to a browser.
    console.error("viewer error", e);
    return json(500, { error: "something went wrong" });
  }
}
