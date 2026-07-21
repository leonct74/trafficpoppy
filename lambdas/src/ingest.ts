// Ingest orchestration: given a normalized event and a Store, apply the counter writes,
// the daily-unique conditional put, salt rotation, and the per-site daily write cap.
//
// Deps (clock, rng) are injected so this is unit-testable against a fake store — the salt
// rotation and the "unique only counts once per day" logic are exactly the privacy-
// critical behaviours we must be able to pin (DESIGN.md §4).

import { createHash } from "node:crypto";
import { counterKeys, dayPk, recentPk, uniqPk, type NormalizedEvent } from "./core";
import type { Store } from "./store";

const DAY_MS = 86_400_000;

export interface IngestDeps {
  store: Store;
  /** Current time. Injected so tests are deterministic and the UTC day is derivable. */
  now: () => Date;
  /** Fresh random salt (hex). Injected so the salt is deterministic in tests. */
  freshSalt: () => string;
  /**
   * Per-site, per-day write cap (protects the owner's bill against a spammed public
   * endpoint — DESIGN.md §11). Once total views for the day exceed it, we stop writing the
   * detail rows. Generous by default; overridable via env in the handler.
   */
  dailyCap: number;
}

/** The UTC calendar day (YYYY-MM-DD) — the unit every counter partition is keyed by. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The day's rotating salt: read it, or mint + conditionally store a fresh one (winning any
 * race by re-reading). Salt rows carry a short TTL so yesterday's salt is DESTROYED within
 * a couple of days — after which that day's visitor hashes are permanently unlinkable, so
 * cross-day tracking is cryptographically dead (DESIGN.md §4). The daily hash itself
 * includes the salt, so a new day ⇒ new salt ⇒ a returning visitor is uncorrelatable.
 */
export async function currentSalt(deps: IngestDeps, day: string): Promise<string> {
  const existing = await deps.store.getSalt(day);
  if (existing) return existing;
  const fresh = deps.freshSalt();
  // Salt outlives its day only long enough to avoid a midnight-boundary gap, then dies.
  const expiresAt = Math.floor(deps.now().getTime() / 1000) + (2 * DAY_MS) / 1000;
  await deps.store.putSaltIfAbsent(day, fresh, expiresAt);
  // Re-read: if a concurrent Lambda's salt landed first, everyone must agree on one value.
  return (await deps.store.getSalt(day)) ?? fresh;
}

/**
 * The once-per-day visitor hash: sha256(salt + ip + ua + siteId). The IP and UA are inputs
 * only — this function returns a hash, and the raw IP is NEVER stored or returned anywhere
 * (DESIGN.md §4). A new day's salt makes this value uncorrelatable with any prior day.
 */
export function visitorHash(salt: string, ip: string, ua: string, siteId: string): string {
  return createHash("sha256").update(`${salt}|${ip}|${ua}|${siteId}`).digest("hex");
}

export interface IngestResult {
  counted: boolean;
  /** True when the per-site daily cap was hit and detail writes were skipped. */
  capped: boolean;
  /** True when this visitor was seen for the first time today. */
  newVisitor: boolean;
}

/**
 * Apply one pageview. `ip` and `ua` are used only to compute the daily hash and are not
 * persisted. Returns what happened, for the handler's response + logging (never the hash).
 */
export async function ingest(
  ev: NormalizedEvent,
  ip: string,
  ua: string,
  deps: IngestDeps,
): Promise<IngestResult> {
  const day = utcDay(deps.now());
  const pk = dayPk(ev.siteId, day);

  // Bump the day's total first — its returned value is our cap gauge. One write even when
  // capped, so an abusive flood costs ~1 write/hit instead of the full ~8-row fan-out.
  const views = await deps.store.bumpViews(pk);
  if (views > deps.dailyCap) {
    return { counted: false, capped: true, newVisitor: false };
  }

  // Detail counters (page, referrer, browser, os, size, utm). total#views is already done.
  const detail = counterKeys(ev, day).filter((k) => k.sk !== "total#views");
  // Time-of-arrival buckets (P3 reports). SERVER-derived — nothing new is collected from
  // the visitor. hour#HH powers the hour-of-day strip; the per-minute row powers the live
  // "last 30 minutes" ticker and self-destructs via TTL (it's traffic volume, not detail).
  const nowMs = deps.now().getTime();
  const hh = String(deps.now().getUTCHours()).padStart(2, "0");
  const minute = new Date(nowMs).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  detail.push({ pk, sk: `hour#${hh}` });
  detail.push({ pk: recentPk(ev.siteId), sk: `t#${minute}`, expiresAt: Math.floor(nowMs / 1000) + 7200 });
  await deps.store.bumpCounters(detail);

  // Daily unique: conditional put of the salted hash; only the first hit of the day counts.
  const salt = await currentSalt(deps, day);
  const hash = visitorHash(salt, ip, ua, ev.siteId);
  const expiresAt = Math.floor(deps.now().getTime() / 1000) + (40 * DAY_MS) / 1000;
  const newVisitor = await deps.store.putUniqueIfNew(uniqPk(ev.siteId, day), hash, expiresAt);
  if (newVisitor) {
    await deps.store.bumpCounters([{ pk, sk: "total#uniques" }]);
  }

  return { counted: true, capped: false, newVisitor };
}
