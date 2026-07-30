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

  it("serves the live ticker", async () => {
    const res = await get("/api/sites/aaa/live", AUTH);
    const { live } = JSON.parse(res.body);
    expect(live.minutes).toHaveLength(30);
    expect(live.views).toBe(2);
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
