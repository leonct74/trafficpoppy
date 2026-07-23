// The collector's pure core: raw request → the exact set of counter increments to apply.
//
// Everything here is a pure function of its inputs — no AWS, no clock, no randomness — so
// the privacy rules (DESIGN.md §6) are enforced in code the tests can pin exactly. The
// Lambda handler (collector.ts) wires these to DynamoDB and supplies the day + salt.
//
// PRIVACY INVARIANTS enforced below (never relax without updating DESIGN.md §6):
//   - referrer reduced to HOSTNAME only (query strings can carry emails/tokens);
//   - the page URL reduced to its PATH only, then utm allowlisted to exactly
//     utm_source / utm_medium / utm_campaign;
//   - UA reduced to a COARSE browser + OS family before it is ever stored;
//   - GPC/DNT ⇒ count nothing at all (not even anonymously);
//   - the raw IP is only an input to the daily hash (computed in the handler) and is
//     never part of anything returned here.

/** The exactly-three utm keys we keep. Everything else in the query string is dropped. */
export const UTM_ALLOWLIST = ["utm_source", "utm_medium", "utm_campaign"] as const;

/** What t.js sends in the POST /e body (kept terse to keep the script ~1 KB). */
export interface RawEvent {
  /** site id (from data-site) */ s?: unknown;
  /** page path (location.pathname) */ p?: unknown;
  /** page query string (location.search) — server extracts allowlisted utm, drops the rest */ q?: unknown;
  /** referrer (document.referrer) — server reduces to hostname */ r?: unknown;
  /** viewport width in CSS px */ w?: unknown;
}

/** Request context the handler pulls from headers (not from the body). */
export interface RequestContext {
  userAgent?: string;
  /** True when GPC or DNT asked us not to track. */
  doNotTrack: boolean;
  /**
   * ISO 3166-1 alpha-2 country, from `CloudFront-Viewer-Country` — present only on the
   * True Reach (custom-domain) tier, where CloudFront derives it at the edge (DESIGN.md
   * §12). The free Function-URL path carries no geo header and we NEVER look up the IP.
   */
  country?: string;
}

/** A normalized, privacy-reduced event ready to be turned into counter increments. */
export interface NormalizedEvent {
  siteId: string;
  path: string;
  referrerHost?: string;
  browser: string;
  os: string;
  size: string;
  utm: Partial<Record<(typeof UTM_ALLOWLIST)[number], string>>;
  /** Two-letter country code (True Reach tier only) — country-level, never finer. */
  country?: string;
}

const MAX_SITE_ID = 64;
const MAX_PATH = 512;
const MAX_UTM = 128;

/** Trim + cap a string; undefined if empty. Guards every value we store against abuse. */
function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Reduce a referrer to its bare hostname, or undefined (same-origin / direct / junk). */
export function referrerHost(referrer: unknown, ownHost?: string): string | undefined {
  const raw = clean(referrer, 2048);
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  // A referral from the site to itself is not a referrer — it's internal navigation.
  if (ownHost && host === ownHost.toLowerCase()) return undefined;
  return host.replace(/^www\./, "");
}

/** Extract exactly the allowlisted utm params from a query string; drop everything else. */
export function allowlistedUtm(query: unknown): NormalizedEvent["utm"] {
  const out: NormalizedEvent["utm"] = {};
  const raw = clean(query, 2048);
  if (!raw) return out;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  } catch {
    return out;
  }
  for (const key of UTM_ALLOWLIST) {
    const v = clean(params.get(key), MAX_UTM);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Reduce a User-Agent string to a COARSE browser family — the most specific bucket we
 * ever store. Order matters (Edge/Brave/Opera masquerade as Chrome; Chrome's UA contains
 * "Safari"). Unknown ⇒ "Other", never the raw string.
 */
export function browserFamily(ua: unknown): string {
  const s = typeof ua === "string" ? ua : "";
  if (/\bEdg(e|A|iOS)?\//.test(s)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(s)) return "Opera";
  if (/\bSamsungBrowser\//.test(s)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//.test(s)) return "Firefox";
  if (/\bChrome\/|\bCriOS\//.test(s)) return "Chrome";
  if (/\bSafari\//.test(s) && /\bVersion\//.test(s)) return "Safari";
  return "Other";
}

/** Reduce a User-Agent string to a COARSE OS family. Unknown ⇒ "Other". */
export function osFamily(ua: unknown): string {
  const s = typeof ua === "string" ? ua : "";
  if (/\bWindows NT\b/.test(s)) return "Windows";
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(s)) return "iOS";
  if (/\bAndroid\b/.test(s)) return "Android";
  if (/\bMac OS X\b|\bMacintosh\b/.test(s)) return "macOS";
  if (/\bLinux\b/.test(s)) return "Linux";
  return "Other";
}

/** Bucket a viewport width into a coarse device band (never the exact px). */
export function sizeBucket(width: unknown): string {
  const w = typeof width === "number" ? width : Number(width);
  if (!Number.isFinite(w) || w <= 0) return "unknown";
  if (w < 640) return "mobile";
  if (w < 1024) return "tablet";
  if (w < 1600) return "laptop";
  return "desktop";
}

/** A normalized path: keep the pathname, drop any embedded query/hash, cap the length. */
export function normalizePath(path: unknown): string | undefined {
  const raw = clean(path, MAX_PATH);
  if (!raw) return undefined;
  // Defence in depth: even if a query slips into `p`, strip it — utm comes via `q` only.
  const p = raw.split(/[?#]/)[0] || "/";
  return p.startsWith("/") ? p : `/${p}`;
}

/**
 * Turn a raw event + request context into a normalized, privacy-reduced event — or null
 * when it must not be counted (missing site/path, or the visitor opted out via GPC/DNT).
 */
export function normalize(raw: RawEvent, ctx: RequestContext, ownHost?: string): NormalizedEvent | null {
  // Honor the opt-out signal above everything else: count nothing, not even anonymously.
  if (ctx.doNotTrack) return null;

  const siteId = clean(raw.s, MAX_SITE_ID);
  const path = normalizePath(raw.p);
  if (!siteId || !path) return null;
  // Site ids are opaque short tokens we mint; reject anything that isn't [A-Za-z0-9_-].
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) return null;

  // Strictly a two-letter code (CloudFront sends "ZZ"/unknown junk sometimes; drop it).
  const country =
    typeof ctx.country === "string" && /^[A-Z]{2}$/.test(ctx.country) && ctx.country !== "ZZ"
      ? ctx.country
      : undefined;

  return {
    siteId,
    path,
    referrerHost: referrerHost(raw.r, ownHost),
    browser: browserFamily(ctx.userAgent),
    os: osFamily(ctx.userAgent),
    size: sizeBucket(raw.w),
    utm: allowlistedUtm(raw.q),
    country,
  };
}

/** True when GPC (`Sec-GPC: 1`) or DNT (`DNT: 1`) asks us not to track. */
export function isDoNotTrack(headers: Record<string, string | undefined>): boolean {
  const h = (name: string) => headers[name] ?? headers[name.toLowerCase()];
  return h("Sec-GPC") === "1" || h("DNT") === "1";
}

/** One counter row to increment: (pk, sk) get `ADD count :1` (+ TTL when it should age out). */
export interface CounterKey {
  pk: string;
  sk: string;
  /** Epoch-seconds TTL for short-lived rows (the last-30-minutes ticker); absent = keep. */
  expiresAt?: number;
}

export const dayPk = (siteId: string, day: string) => `site#${siteId}#day#${day}`;
export const uniqPk = (siteId: string, day: string) => `site#${siteId}#uniq#${day}`;
/** The rolling per-minute partition behind the live "last 30 minutes" ticker (P3). */
export const recentPk = (siteId: string) => `site#${siteId}#recent`;

/**
 * The full set of counter rows a single pageview increments (DESIGN.md §2 single-table
 * design). All same-partition, so the dashboard reads a day with one Query.
 */
export function counterKeys(ev: NormalizedEvent, day: string): CounterKey[] {
  const pk = dayPk(ev.siteId, day);
  const keys: CounterKey[] = [
    { pk, sk: "total#views" },
    { pk, sk: `page#${ev.path}` },
    { pk, sk: `browser#${ev.browser}` },
    { pk, sk: `os#${ev.os}` },
    { pk, sk: `size#${ev.size}` },
  ];
  if (ev.referrerHost) keys.push({ pk, sk: `ref#${ev.referrerHost}` });
  if (ev.country) keys.push({ pk, sk: `country#${ev.country}` });
  for (const key of UTM_ALLOWLIST) {
    const v = ev.utm[key];
    if (v) keys.push({ pk, sk: `${key}#${v}` });
  }
  return keys;
}
