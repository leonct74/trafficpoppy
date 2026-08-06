import { describe, expect, it, vi } from "vitest";
import { clampSaltDays, currentSalt, ingest, saltWindow, utcDay, visitorHash, type IngestDeps } from "./ingest";
import { normalize } from "./core";
import type { Store } from "./store";
import type { CounterKey } from "./core";

/** An in-memory Store that records every write, for asserting exactly what got persisted. */
function fakeStore(seed?: { salt?: Record<string, string>; uniques?: Set<string> }) {
  const salts = new Map<string, string>(Object.entries(seed?.salt ?? {}));
  const uniques = new Set<string>(seed?.uniques ?? []);
  const counters = new Map<string, number>();
  let views = 0;
  const store: Store = {
    getSalt: async (day) => salts.get(day),
    putSaltIfAbsent: async (day, salt) => {
      if (!salts.has(day)) salts.set(day, salt);
    },
    bumpViews: async () => ++views,
    bumpCounter: async (pk, sk) => {
      const key = `${pk}|${sk}`;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    bumpCounters: async (keys: CounterKey[]) => {
      for (const k of keys) counters.set(`${k.pk}|${k.sk}`, (counters.get(`${k.pk}|${k.sk}`) ?? 0) + 1);
    },
    putUniqueIfNew: async (pk, hash) => {
      const key = `${pk}|${hash}`;
      if (uniques.has(key)) return false;
      uniques.add(key);
      return true;
    },
    getSiteConfig: async () => ({}),
  };
  return { store, salts, uniques, counters, viewsNow: () => views };
}

const at = (iso: string) => () => new Date(iso);
const ev = normalize({ s: "s1", p: "/x", w: 400 }, { doNotTrack: false })!;

function deps(over: Partial<IngestDeps> & { store: Store }): IngestDeps {
  return {
    now: at("2026-07-18T09:00:00Z"),
    freshSalt: () => "SALT_A",
    dailyCap: 1000,
    getSiteConfig: async () => ({ saltDays: 1 }),
    ...over,
  };
}

/** A 1-day window for the given day — what currentSalt sees on the default tier. */
const dayWindow = (day: string) => ({
  key: day,
  endsAtSec: (Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 1) * 86_400,
});

describe("utcDay", () => {
  it("is the UTC calendar day", () => {
    expect(utcDay(new Date("2026-07-18T23:59:59Z"))).toBe("2026-07-18");
  });
});

describe("visitorHash — the raw IP is an input only, never recoverable", () => {
  it("is a stable sha256 of salt+ip+ua+site", () => {
    const h = visitorHash("SALT_A", "1.2.3.4", "UA", "s1");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(visitorHash("SALT_A", "1.2.3.4", "UA", "s1")).toBe(h); // deterministic
  });

  it("a different day's salt makes the SAME visitor uncorrelatable (cross-day tracking dead)", () => {
    const today = visitorHash("SALT_A", "1.2.3.4", "UA", "s1");
    const tomorrow = visitorHash("SALT_B", "1.2.3.4", "UA", "s1");
    expect(today).not.toBe(tomorrow);
  });
});

describe("currentSalt — rotates with the window, destroyed after (DESIGN.md §4, §6b)", () => {
  it("mints and stores a fresh salt on the first hit of a new window", async () => {
    const f = fakeStore();
    const salt = await currentSalt(deps({ store: f.store }), dayWindow("2026-07-18"));
    expect(salt).toBe("SALT_A");
    expect(f.salts.get("2026-07-18")).toBe("SALT_A");
  });

  it("reuses the existing salt for the rest of the window", async () => {
    const f = fakeStore({ salt: { "2026-07-18": "EXISTING" } });
    const salt = await currentSalt(
      deps({ store: f.store, freshSalt: () => "SHOULD_NOT_BE_USED" }),
      dayWindow("2026-07-18"),
    );
    expect(salt).toBe("EXISTING");
  });
});

describe("saltWindow — §6b baseline windows are fixed UTC buckets, 1–7 days", () => {
  it("a 1-day window IS the UTC day — existing deployments roll over without a salt reset", () => {
    const w = saltWindow(new Date("2026-07-18T09:00:00Z"), 1);
    expect(w.key).toBe("2026-07-18");
    expect(w.endsAtSec).toBe(Date.parse("2026-07-19T00:00:00Z") / 1000);
  });

  it("a multi-day window buckets epoch days, so every Lambda agrees without coordination", () => {
    const a = saltWindow(new Date("2026-07-18T00:00:00Z"), 7);
    const b = saltWindow(new Date("2026-07-18T23:59:59Z"), 7);
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^w#7#\d+$/);
  });

  it("windows of different lengths never share a salt (distinct key namespaces)", () => {
    const d = new Date("2026-07-18T09:00:00Z");
    expect(saltWindow(d, 3).key).not.toBe(saltWindow(d, 7).key);
    expect(saltWindow(d, 3).key).not.toBe(saltWindow(d, 1).key);
  });

  it("clampSaltDays enforces the consent-free ceiling — nothing stored can exceed 7 days", () => {
    expect(clampSaltDays(365)).toBe(7); // the §6b hard cap, whatever an owner writes
    expect(clampSaltDays(0)).toBe(1);
    expect(clampSaltDays(-3)).toBe(1);
    expect(clampSaltDays("junk")).toBe(1);
    expect(clampSaltDays(undefined)).toBe(1);
    expect(clampSaltDays(4.9)).toBe(4);
  });
});

describe("new vs returning (§6b's free by-product) — no extra identity, one more TTL'd row", () => {
  const week = { getSiteConfig: async () => ({ saltDays: 7 }) };

  it("first-ever visit in a window counts as new", async () => {
    const f = fakeStore();
    await ingest(ev, "9.9.9.9", "UA", deps({ store: f.store, ...week }));
    expect(f.counters.get("site#s1#day#2026-07-18|total#new")).toBe(1);
    expect(f.counters.get("site#s1#day#2026-07-18|total#returning")).toBeUndefined();
  });

  it("the same visitor on a LATER DAY of the same window counts as returning", async () => {
    const f = fakeStore();
    const d1 = deps({ store: f.store, ...week, now: at("2026-07-16T09:00:00Z") });
    const d2 = deps({ store: f.store, ...week, now: at("2026-07-17T09:00:00Z") });
    await ingest(ev, "9.9.9.9", "UA", d1);
    await ingest(ev, "9.9.9.9", "UA", d2);
    // Day 2 is a fresh daily unique, but the window row already held the hash.
    expect(f.counters.get("site#s1#day#2026-07-17|total#returning")).toBe(1);
    expect(f.counters.get("site#s1#day#2026-07-17|total#new")).toBeUndefined();
    // Both days still count the visitor as that day's unique — daily uniques are untouched.
    expect(f.counters.get("site#s1#day#2026-07-16|total#uniques")).toBe(1);
    expect(f.counters.get("site#s1#day#2026-07-17|total#uniques")).toBe(1);
  });

  it("a 1-day window counts every unique as new — returns are unknowable by construction", async () => {
    const f = fakeStore();
    await ingest(ev, "9.9.9.9", "UA", deps({ store: f.store, getSiteConfig: async () => ({ saltDays: 1 }) }));
    expect(f.counters.get("site#s1#day#2026-07-18|total#new")).toBe(1);
    // And no window row beyond the daily one was written.
    for (const u of f.uniques) expect(u).not.toContain("uniq#w#");
  });

  it("hash rows age out with the window, never a fixed 40 days", async () => {
    const f = fakeStore();
    const ttls: number[] = [];
    const orig = f.store.putUniqueIfNew;
    f.store.putUniqueIfNew = async (pk, hash, expiresAt) => {
      ttls.push(expiresAt);
      return orig(pk, hash, expiresAt);
    };
    await ingest(ev, "9.9.9.9", "UA", deps({ store: f.store, ...week, now: at("2026-07-16T09:00:00Z") }));
    const windowEnd = saltWindow(new Date("2026-07-16T09:00:00Z"), 7).endsAtSec;
    for (const t of ttls) expect(t).toBe(windowEnd + 2 * 86_400);
  });
});

describe("ingest — one pageview", () => {
  it("counts total, detail, and a first-seen unique", async () => {
    const f = fakeStore();
    const r = await ingest(ev, "9.9.9.9", "UA", deps({ store: f.store }));
    expect(r).toEqual({ counted: true, capped: false, newVisitor: true });
    // total#views via bumpViews; detail + total#uniques via bumpCounters.
    expect(f.counters.get("site#s1#day#2026-07-18|total#uniques")).toBe(1);
    expect(f.counters.get("site#s1#day#2026-07-18|page#/x")).toBe(1);
    expect(f.viewsNow()).toBe(1);
  });

  it("counts a repeat visitor's view but not a second unique (same day, same salt)", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store });
    await ingest(ev, "9.9.9.9", "UA", d);
    const second = await ingest(ev, "9.9.9.9", "UA", d);
    expect(second.newVisitor).toBe(false);
    expect(f.counters.get("site#s1#day#2026-07-18|total#uniques")).toBe(1); // still 1
    expect(f.counters.get("site#s1#day#2026-07-18|page#/x")).toBe(2); // both views counted
  });

  it("stops writing detail rows once the daily cap is exceeded (protects the bill)", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store, dailyCap: 2 });
    await ingest(ev, "a", "UA", d); // views→1
    await ingest(ev, "b", "UA", d); // views→2
    const third = await ingest(ev, "c", "UA", d); // views→3 > cap
    expect(third).toEqual({ counted: false, capped: true, newVisitor: false });
    // page#/x counted only for the two under-cap hits, not the third.
    expect(f.counters.get("site#s1#day#2026-07-18|page#/x")).toBe(2);
  });

  it("buckets time of arrival: hour-of-day counter + a TTL'd minute row for the live ticker", async () => {
    const f = fakeStore();
    let ttlSeen: number | undefined;
    const orig = f.store.bumpCounters;
    f.store.bumpCounters = async (keys: CounterKey[]) => {
      for (const k of keys) if (k.expiresAt) ttlSeen = k.expiresAt;
      return orig(keys);
    };
    await ingest(ev, "1.2.3.4", "UA", deps({ store: f.store, now: at("2026-07-18T09:07:33Z") }));

    // Server-derived only — the visitor sent no time field.
    expect(f.counters.get("site#s1#day#2026-07-18|hour#09")).toBe(1);
    expect(f.counters.get("site#s1#recent|t#2026-07-18T09:07")).toBe(1);
    // The minute row self-destructs (2h TTL) — it must never accumulate forever.
    expect(ttlSeen).toBe(Math.floor(Date.parse("2026-07-18T09:07:33Z") / 1000) + 7200);
  });

  it("never stores the raw IP anywhere in the counters", async () => {
    const f = fakeStore();
    await ingest(ev, "203.0.113.7", "UA", deps({ store: f.store }));
    for (const key of f.counters.keys()) expect(key).not.toContain("203.0.113.7");
    for (const u of f.uniques) expect(u).not.toContain("203.0.113.7");
  });
});

/**
 * Conversion goals (§7e). The two properties that matter: an unregistered name writes
 * NOTHING (the endpoint is public — anyone can post any name), and a goal event is never
 * a page view, so conversions can't inflate traffic.
 */
describe("ingest — conversion goals", () => {
  const goalEv = normalize({ s: "s1", p: "/x", g: "download" }, { doNotTrack: false })!;
  const withGoals = (goals: { name: string; kind: "page" | "event"; path?: string }[]) => ({
    getSiteConfig: async () => ({ saltDays: 1, goals }),
  });

  it("counts a registered button goal and the visitor behind it — once per window", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store, ...withGoals([{ name: "download", kind: "event" }]) });
    await ingest(goalEv, "9.9.9.9", "UA", d);
    await ingest(goalEv, "9.9.9.9", "UA", d); // same person presses twice
    expect(f.counters.get("site#s1#day#2026-07-18|goal#download")).toBe(2);
    expect(f.counters.get("site#s1#day#2026-07-18|goalu#download")).toBe(1);
    // …and a different visitor is a second converter.
    await ingest(goalEv, "8.8.8.8", "UA", d);
    expect(f.counters.get("site#s1#day#2026-07-18|goalu#download")).toBe(2);
  });

  it("writes NOTHING for a name the owner never registered", async () => {
    const f = fakeStore();
    const r = await ingest(goalEv, "9.9.9.9", "UA", deps({ store: f.store, ...withGoals([]) }));
    expect(r.counted).toBe(false);
    expect([...f.counters.keys()].filter((k) => k.includes("goal"))).toEqual([]);
  });

  it("a goal is never a page view — views, pages and uniques are untouched", async () => {
    const f = fakeStore();
    await ingest(goalEv, "9.9.9.9", "UA", deps({ store: f.store, ...withGoals([{ name: "download", kind: "event" }]) }));
    expect(f.viewsNow()).toBe(0);
    expect(f.counters.get("site#s1#day#2026-07-18|page#/x")).toBeUndefined();
    expect(f.counters.get("site#s1#day#2026-07-18|total#uniques")).toBeUndefined();
  });

  it("a page goal converts on the pageview itself — no second request from the browser", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store, ...withGoals([{ name: "thanks", kind: "page", path: "/x" }]) });
    await ingest(ev, "9.9.9.9", "UA", d);
    expect(f.counters.get("site#s1#day#2026-07-18|goalu#thanks")).toBe(1);
    expect(f.counters.get("site#s1#day#2026-07-18|page#/x")).toBe(1); // still a normal view
  });

  it("a page goal for another path stays at zero", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store, ...withGoals([{ name: "thanks", kind: "page", path: "/other" }]) });
    await ingest(ev, "9.9.9.9", "UA", d);
    expect(f.counters.get("site#s1#day#2026-07-18|goalu#thanks")).toBeUndefined();
  });

  it("goal beacons have their own flood cap, so they can never run up the bill", async () => {
    const f = fakeStore();
    const d = deps({ store: f.store, dailyCap: 1, ...withGoals([{ name: "download", kind: "event" }]) });
    await ingest(goalEv, "a", "UA", d);
    const second = await ingest(goalEv, "b", "UA", d);
    expect(second).toEqual({ counted: false, capped: true, newVisitor: false });
    expect(f.counters.get("site#s1#day#2026-07-18|goal#download")).toBe(1);
  });

  it("the converter row dies with the window's salt — the hash outlives nothing", async () => {
    const f = fakeStore();
    await ingest(goalEv, "9.9.9.9", "UA", deps({ store: f.store, ...withGoals([{ name: "download", kind: "event" }]) }));
    const row = [...f.uniques].find((k) => k.includes("uniqg"));
    expect(row).toMatch(/^site#s1#uniqg#2026-07-18\|download\|[a-f0-9]{64}$/);
  });
});
