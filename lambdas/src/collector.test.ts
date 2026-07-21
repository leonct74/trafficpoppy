import { describe, expect, it, vi } from "vitest";
import { handleEvent, type HandlerDeps } from "./collector";
import type { Store } from "./store";

function fakeDeps(): HandlerDeps & { calls: { views: number; counters: number; uniques: string[] } } {
  const calls = { views: 0, counters: 0, uniques: [] as string[] };
  const store: Store = {
    getSalt: async () => "SALT",
    putSaltIfAbsent: async () => {},
    bumpViews: async () => ++calls.views,
    bumpCounters: async () => {
      calls.counters++;
    },
    putUniqueIfNew: async (_pk, hash) => {
      calls.uniques.push(hash);
      return true;
    },
  };
  return { store, now: () => new Date("2026-07-18T00:00:00Z"), freshSalt: () => "SALT", dailyCap: 1000, calls };
}

const req = (over: Record<string, unknown>) => ({
  requestContext: { http: { method: "GET", sourceIp: "1.2.3.4", userAgent: "UA" } },
  headers: { host: "abc.lambda-url.eu-west-1.on.aws", "x-forwarded-proto": "https" },
  ...over,
});

describe("GET /t.js", () => {
  it("serves the script with the request's own origin baked in", async () => {
    const res = await handleEvent(req({ rawPath: "/t.js" }) as never, fakeDeps());
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toMatch(/javascript/);
    expect(res.body).toContain('"https://abc.lambda-url.eu-west-1.on.aws/e"');
  });
});

describe("POST /e", () => {
  it("ingests a valid event and answers a bare 204 (leaks nothing)", async () => {
    const deps = fakeDeps();
    const res = await handleEvent(
      req({
        rawPath: "/e",
        requestContext: { http: { method: "POST", sourceIp: "9.9.9.9", userAgent: "UA" } },
        body: JSON.stringify({ s: "site1", p: "/home", w: 1440 }),
      }) as never,
      deps,
    );
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(deps.calls.views).toBe(1);
    expect(deps.calls.uniques).toHaveLength(1);
  });

  it("counts nothing when the visitor sent GPC, but still answers 204", async () => {
    const deps = fakeDeps();
    const res = await handleEvent(
      req({
        rawPath: "/e",
        requestContext: { http: { method: "POST", sourceIp: "9.9.9.9", userAgent: "UA" } },
        headers: { "sec-gpc": "1" },
        body: JSON.stringify({ s: "site1", p: "/home" }),
      }) as never,
      deps,
    );
    expect(res.statusCode).toBe(204);
    expect(deps.calls.views).toBe(0); // nothing written
  });

  it("swallows a malformed body to 204 — never a console error on the visitor's page", async () => {
    const deps = fakeDeps();
    const res = await handleEvent(
      req({
        rawPath: "/e",
        requestContext: { http: { method: "POST", sourceIp: "9.9.9.9", userAgent: "UA" } },
        body: "}{ not json",
      }) as never,
      deps,
    );
    expect(res.statusCode).toBe(204);
    expect(deps.calls.views).toBe(0);
  });

  it("never lets a store failure surface to the page", async () => {
    const deps = fakeDeps();
    deps.store.bumpViews = async () => {
      throw new Error("DynamoDB is down");
    };
    const res = await handleEvent(
      req({
        rawPath: "/e",
        requestContext: { http: { method: "POST", sourceIp: "9.9.9.9", userAgent: "UA" } },
        body: JSON.stringify({ s: "site1", p: "/home" }),
      }) as never,
      deps,
    );
    expect(res.statusCode).toBe(204);
  });
});

describe("CORS + routing", () => {
  it("NEVER emits its own CORS headers — the Function URL's Cors config owns them", async () => {
    // Live lesson from the first real install: when both the handler and the URL config
    // add Access-Control-Allow-Origin, the response carries it TWICE, and browsers
    // hard-reject the duplicated header. curl works; every real visitor's beacon dies
    // silently. So the handler must stay CORS-silent on every route.
    for (const r of [
      req({ rawPath: "/e", requestContext: { http: { method: "OPTIONS" } } }),
      req({ rawPath: "/e", requestContext: { http: { method: "POST" } }, body: JSON.stringify({ s: "s", p: "/" }) }),
      req({ rawPath: "/t.js" }),
      req({ rawPath: "/nope" }),
    ]) {
      const res = await handleEvent(r as never, fakeDeps());
      for (const h of Object.keys(res.headers ?? {})) {
        expect(h.toLowerCase()).not.toMatch(/^access-control-/);
      }
    }
  });

  it("answers preflight with a bare 204 (the URL layer decorates it)", async () => {
    const res = await handleEvent(
      req({ rawPath: "/e", requestContext: { http: { method: "OPTIONS" } } }) as never,
      fakeDeps(),
    );
    expect(res.statusCode).toBe(204);
  });

  it("404s an unknown route", async () => {
    const res = await handleEvent(req({ rawPath: "/nope" }) as never, fakeDeps());
    expect(res.statusCode).toBe(404);
  });
});
