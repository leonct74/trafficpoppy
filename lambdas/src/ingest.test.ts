import { describe, expect, it, vi } from "vitest";
import { currentSalt, ingest, utcDay, visitorHash, type IngestDeps } from "./ingest";
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
    bumpCounters: async (keys: CounterKey[]) => {
      for (const k of keys) counters.set(`${k.pk}|${k.sk}`, (counters.get(`${k.pk}|${k.sk}`) ?? 0) + 1);
    },
    putUniqueIfNew: async (pk, hash) => {
      const key = `${pk}|${hash}`;
      if (uniques.has(key)) return false;
      uniques.add(key);
      return true;
    },
  };
  return { store, salts, uniques, counters, viewsNow: () => views };
}

const at = (iso: string) => () => new Date(iso);
const ev = normalize({ s: "s1", p: "/x", w: 400 }, { doNotTrack: false })!;

function deps(over: Partial<IngestDeps> & { store: Store }): IngestDeps {
  return { now: at("2026-07-18T09:00:00Z"), freshSalt: () => "SALT_A", dailyCap: 1000, ...over };
}

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

describe("currentSalt — rotates daily, destroyed after (DESIGN.md §4)", () => {
  it("mints and stores a fresh salt on the first hit of a new day", async () => {
    const f = fakeStore();
    const salt = await currentSalt(deps({ store: f.store }), "2026-07-18");
    expect(salt).toBe("SALT_A");
    expect(f.salts.get("2026-07-18")).toBe("SALT_A");
  });

  it("reuses the existing salt for the rest of the day", async () => {
    const f = fakeStore({ salt: { "2026-07-18": "EXISTING" } });
    const salt = await currentSalt(deps({ store: f.store, freshSalt: () => "SHOULD_NOT_BE_USED" }), "2026-07-18");
    expect(salt).toBe("EXISTING");
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
