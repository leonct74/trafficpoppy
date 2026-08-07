import { describe, expect, it, vi } from "vitest";
import { route, type ViewerDeps } from "./viewer";
import { ALL_SITES_GROUP, siteGroup, type ViewerClaims } from "./auth";
import type { CounterRow } from "../../shared/src/range";

const claimsFor = (groups: string[]): ViewerClaims => ({
  sub: "u1",
  email: "viewer@example.com",
  groups,
  exp: 0,
  tokenUse: "id",
});

const SITES = [
  { id: "aaa", name: "Client A", domain: "a.com" },
  { id: "bbb", name: "Client B", domain: "b.com" },
];

const ROWS: CounterRow[] = [
  { sk: "total#views", count: 10 },
  { sk: "total#uniques", count: 4 },
  { sk: "page#/", count: 7 },
  { sk: "country#GB", count: 3 },
];

function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
  return {
    listSites: async () => SITES,
    dayRows: async () => ROWS,
    recentRows: async () => [{ sk: "t#2026-07-25T09:05", count: 2 }],
    // Default: every test site's domain is covered — the paid gate is asserted separately.
    edgeDomains: async () => SITES.map((s) => `stats.${s.domain}`),
    authenticate: async (h) => (h.authorization === "Bearer good" ? claimsFor([siteGroup("aaa")]) : undefined),
    today: () => "2026-07-25",
    now: () => new Date("2026-07-25T09:30:00Z"),
    ...over,
  };
}

const get = (path: string, headers: Record<string, string | undefined> = {}, query = {}) =>
  route({ method: "GET", path, query, headers }, deps());

const AUTH = { authorization: "Bearer good" };

describe("the dashboard page", () => {
  it("is public — the login form must load before anyone can sign in", async () => {
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/Sign in/);
  });

  /**
   * The page has real urls (/site/<id>), so every non-/api GET must serve it — otherwise a
   * refresh or a shared link 404s (founder 2026-08-07). The API keeps its own 404s.
   */
  it("serves the app for any page url, so a refresh or a shared link lands", async () => {
    for (const path of ["/site/abc", "/site/abc?days=30", "/anything/we/add/later"]) {
      const res = await get(path);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    }
    // …but never for the API, and never as a reply to a write.
    expect((await get("/api/secret", AUTH)).statusCode).toBe(404);
    expect((await route({ method: "POST", path: "/site/abc", query: {}, headers: {} }, deps())).statusCode).toBe(404);
  });

  it("carries the hardening headers a private dashboard needs", async () => {
    const res = await get("/dash");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("ships no data in the markup — numbers only arrive authenticated", async () => {
    const res = await get("/");
    expect(res.body).not.toMatch(/Client A|a\.com/);
  });
});

describe("authentication", () => {
  it("refuses every /api route without a token", async () => {
    for (const p of ["/api/sites", "/api/sites/aaa/range", "/api/sites/aaa/live"]) {
      expect((await get(p)).statusCode).toBe(401);
    }
  });

  it("refuses an invalid token", async () => {
    expect((await get("/api/sites", { authorization: "Bearer forged" })).statusCode).toBe(401);
  });
});

describe("per-site authorization (the agency case)", () => {
  it("returns only granted sites", async () => {
    const res = await get("/api/sites", AUTH);
    expect(JSON.parse(res.body).sites).toEqual([SITES[0]]);
  });

  it("never lets an ungranted site's data leave the server", async () => {
    const res = await get("/api/sites/bbb/range", AUTH);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/total#views|Client B/);
  });

  it("uses 404 (not 403) so the API cannot be used to enumerate sites", async () => {
    // Identical responses for "exists but not yours" and "does not exist at all".
    const mine = await get("/api/sites/bbb/range", AUTH);
    const nothing = await get("/api/sites/does-not-exist/range", AUTH);
    expect(mine.statusCode).toBe(404);
    expect(nothing.statusCode).toBe(404);
    expect(mine.body).toBe(nothing.body);
  });

  it("all-sites staff can read any site", async () => {
    const res = await route(
      { method: "GET", path: "/api/sites/bbb/range", query: {}, headers: AUTH },
      deps({ authenticate: async () => claimsFor([ALL_SITES_GROUP]) }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("a viewer with no groups gets nothing", async () => {
    const d = deps({ authenticate: async () => claimsFor([]) });
    expect(JSON.parse((await route({ method: "GET", path: "/api/sites", query: {}, headers: AUTH }, d)).body).sites)
      .toEqual([]);
    expect((await route({ method: "GET", path: "/api/sites/aaa/range", query: {}, headers: AUTH }, d)).statusCode)
      .toBe(404);
  });
});

describe("reads", () => {
  it("returns range stats reduced by the SHARED reducer (same numbers as the desktop poppy)", async () => {
    const res = await get("/api/sites/aaa/range", AUTH);
    const { range } = JSON.parse(res.body);
    expect(range.siteId).toBe("aaa");
    expect(range.days).toHaveLength(7);
    expect(range.views).toBe(70); // 10 per day × 7 days
    expect(range.countries).toEqual([{ key: "GB", count: 21 }]);
    expect(range.prev).toBeDefined(); // deltas need the preceding window
  });

  it("clamps `days` so nobody can bill the owner for 10k queries", async () => {
    const seen: string[] = [];
    const d = deps({
      authenticate: async () => claimsFor([ALL_SITES_GROUP]),
      dayRows: async (_s, day) => {
        seen.push(day);
        return [];
      },
    });
    await route({ method: "GET", path: "/api/sites/aaa/range", query: { days: "9999" }, headers: AUTH }, d);
    // 90 max, plus the equally-sized previous window for deltas.
    expect(seen.length).toBe(180);
  });

  it("falls back to a sane window when days is nonsense", async () => {
    const res = await route(
      { method: "GET", path: "/api/sites/aaa/range", query: { days: "abc" }, headers: AUTH },
      deps(),
    );
    expect(JSON.parse(res.body).range.days).toHaveLength(7);
  });

  it("accepts an explicit from/to range, inclusive on both ends", async () => {
    const res = await route(
      { method: "GET", path: "/api/sites/aaa/range", query: { from: "2026-07-01", to: "2026-07-03" }, headers: AUTH },
      deps({ authenticate: async () => claimsFor([ALL_SITES_GROUP]) }),
    );
    const { range } = JSON.parse(res.body);
    expect(range.from).toBe("2026-07-01");
    expect(range.to).toBe("2026-07-03");
    expect(range.days).toHaveLength(3);
  });

  it("clamps from/to at 90 days and never reads past today", async () => {
    const seen: string[] = [];
    const d = deps({
      authenticate: async () => claimsFor([ALL_SITES_GROUP]),
      dayRows: async (_s, day) => {
        seen.push(day);
        return [];
      },
    });
    await route(
      { method: "GET", path: "/api/sites/aaa/range", query: { from: "2020-01-01", to: "2030-01-01" }, headers: AUTH },
      d,
    );
    // 90 max ending TODAY (2026-07-25), plus the same-length previous window.
    expect(seen.length).toBe(180);
    expect(seen.every((day) => day <= "2026-07-25")).toBe(true);
  });

  it("junk from/to falls back to the rolling default instead of erroring", async () => {
    const res = await route(
      { method: "GET", path: "/api/sites/aaa/range", query: { from: "07/01/2026", to: "yesterday" }, headers: AUTH },
      deps(),
    );
    expect(JSON.parse(res.body).range.days).toHaveLength(7);
  });

  it("serves the live ticker", async () => {
    const res = await get("/api/sites/aaa/live", AUTH);
    const { live } = JSON.parse(res.body);
    expect(live.minutes).toHaveLength(30);
    expect(live.views).toBe(2);
  });

  it("enforces the Online Dashboard gate: sites on unsubscribed domains are desktop-only", async () => {
    // Only a.com is covered by a deployed edge; b.com's owner never bought the tier.
    const d = deps({
      authenticate: async () => claimsFor([ALL_SITES_GROUP]),
      edgeDomains: async () => ["stats.a.com"],
    });
    const list = JSON.parse((await route({ method: "GET", path: "/api/sites", query: {}, headers: AUTH }, d)).body);
    expect(list.sites.map((s: { id: string }) => s.id)).toEqual(["aaa"]);
    expect(list.gated).toBeUndefined(); // an edge exists — not the gated-empty state
    // Knowing b's site id must not bypass the gate — and 404, never 403 (enumeration guard).
    const direct = await route({ method: "GET", path: "/api/sites/bbb/range", query: {}, headers: AUTH }, d);
    expect(direct.statusCode).toBe(404);
  });

  it("reports the gated state when NO edge exists, so the page can explain the upgrade", async () => {
    const d = deps({
      authenticate: async () => claimsFor([ALL_SITES_GROUP]),
      edgeDomains: async () => [],
    });
    const list = JSON.parse((await route({ method: "GET", path: "/api/sites", query: {}, headers: AUTH }, d)).body);
    expect(list.sites).toEqual([]);
    expect(list.gated).toBe(true);
    // Every data read is equally closed.
    const r = await route({ method: "GET", path: "/api/sites/aaa/range", query: {}, headers: AUTH }, d);
    expect(r.statusCode).toBe(404);
    const l = await route({ method: "GET", path: "/api/sites/aaa/live", query: {}, headers: AUTH }, d);
    expect(l.statusCode).toBe(404);
  });

  it("404s unknown routes without touching the database", async () => {
    const dayRows = vi.fn();
    const res = await route(
      { method: "GET", path: "/api/secret", query: {}, headers: AUTH },
      deps({ dayRows: dayRows as unknown as ViewerDeps["dayRows"] }),
    );
    expect(res.statusCode).toBe(404);
    expect(dayRows).not.toHaveBeenCalled();
  });
});
