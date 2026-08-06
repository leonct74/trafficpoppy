// Ingest orchestration: given a normalized event and a Store, apply the counter writes,
// the daily-unique conditional put, salt rotation, and the per-site daily write cap.
//
// Deps (clock, rng) are injected so this is unit-testable against a fake store — the salt
// rotation and the "unique only counts once per day" logic are exactly the privacy-
// critical behaviours we must be able to pin (DESIGN.md §4).

import { createHash } from "node:crypto";
import { counterKeys, dayPk, recentPk, uniqPk, type NormalizedEvent } from "./core";
import { goalSk, goalUniqPk, goalUniqueSk, type Goal } from "../../shared/src/goals";
import type { Store } from "./store";

const DAY_MS = 86_400_000;

/** The owner's per-site settings the hot path needs (one registry read, cached briefly). */
export interface SiteConfig {
  /** §6b salt window in days (1–7). Absent/invalid ⇒ 1. */
  saltDays?: number;
  /** §7e conversion goals the owner registered. Absent ⇒ nothing may be counted as a goal. */
  goals?: Goal[];
}

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
  /**
   * The owner's settings for a site: the §6b salt window and the §7e goals. ONE registry
   * read, short-cached by the handler; ingest clamps and re-checks whatever arrives.
   */
  getSiteConfig: (siteId: string) => Promise<SiteConfig>;
}

/** The UTC calendar day (YYYY-MM-DD) — the unit every counter partition is keyed by. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The §6b baseline bounds: the salt window is owner-chosen between 1 and 7 days, never more. */
export const MIN_SALT_DAYS = 1;
export const MAX_SALT_DAYS = 7;
export const DEFAULT_SALT_DAYS = 1;

/** Clamp an owner-supplied window to the §6b consent-free ceiling (1–7 days). */
export function clampSaltDays(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SALT_DAYS;
  return Math.min(MAX_SALT_DAYS, Math.max(MIN_SALT_DAYS, v));
}

/**
 * The salt window a moment belongs to (§6b): windows are fixed UTC epoch-day buckets of
 * `saltDays` length, so every Lambda derives the same window without coordination.
 * A 1-day window keeps the ORIGINAL per-day key (`YYYY-MM-DD`) byte-for-byte, so existing
 * deployments roll over a deploy without a salt reset.
 */
export function saltWindow(now: Date, saltDays: number): { key: string; endsAtSec: number } {
  const epochDay = Math.floor(now.getTime() / DAY_MS);
  if (saltDays <= 1) {
    return { key: utcDay(now), endsAtSec: ((epochDay + 1) * DAY_MS) / 1000 };
  }
  const index = Math.floor(epochDay / saltDays);
  return { key: `w#${saltDays}#${index}`, endsAtSec: ((index + 1) * saltDays * DAY_MS) / 1000 };
}

/**
 * The window's rotating salt: read it, or mint + conditionally store a fresh one (winning
 * any race by re-reading). Salt rows carry a short TTL so an expired window's salt is
 * DESTROYED within a couple of days — after which that window's visitor hashes are
 * permanently unlinkable, so tracking beyond the window is cryptographically dead
 * (DESIGN.md §4, §6b). The hash includes the salt, so a new window ⇒ a returning visitor
 * is uncorrelatable with the previous one.
 */
export async function currentSalt(deps: IngestDeps, window: { key: string; endsAtSec: number }): Promise<string> {
  const existing = await deps.store.getSalt(window.key);
  if (existing) return existing;
  const fresh = deps.freshSalt();
  // Salt outlives its window only long enough to avoid a boundary gap, then dies.
  const expiresAt = window.endsAtSec + (2 * DAY_MS) / 1000;
  await deps.store.putSaltIfAbsent(window.key, fresh, expiresAt);
  // Re-read: if a concurrent Lambda's salt landed first, everyone must agree on one value.
  return (await deps.store.getSalt(window.key)) ?? fresh;
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
 * One conversion (§7e): the goal's count, plus a once-per-window converter check that
 * reuses the SAME salted hash the daily-unique check uses — so "12 presses from 5 people"
 * costs one extra conditional put and adds no new knowledge about anyone. The hash rows
 * die with the window's salt, exactly like the visitor rows.
 */
async function countConversion(
  deps: IngestDeps,
  siteId: string,
  day: string,
  goal: string,
  hash: string,
  expiresAt: number,
): Promise<void> {
  const pk = dayPk(siteId, day);
  const firstForVisitor = await deps.store.putUniqueIfNew(
    goalUniqPk(siteId, day),
    `${goal}|${hash}`,
    expiresAt,
  );
  const keys = [{ pk, sk: goalSk(goal) }];
  if (firstForVisitor) keys.push({ pk, sk: goalUniqueSk(goal) });
  await deps.store.bumpCounters(keys);
}

/**
 * Apply one pageview. `ip` and `ua` are used only to compute the window hash and are not
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
  // The owner's settings (§6b window + §7e goals): ONE registry read, cached by the caller.
  const config = await deps.getSiteConfig(ev.siteId);
  const saltDays = clampSaltDays(config.saltDays);
  const window = saltWindow(deps.now(), saltDays);
  const expiresAt = window.endsAtSec + (2 * DAY_MS) / 1000;
  const goals = config.goals ?? [];

  // ── a conversion-goal event (§7e) — never a pageview ──────────────────────────────
  if (ev.goal) {
    // REGISTERED GOALS ONLY. The endpoint is public, so anyone can post any name; only
    // names the owner created in the app may write a row. Unknown ⇒ silently nothing.
    if (!goals.some((g) => g.kind === "event" && g.name === ev.goal)) {
      return { counted: false, capped: false, newVisitor: false };
    }
    // Its own cheap cap gauge, so a flood of goal beacons costs ~1 write each and can
    // never inflate page views.
    const hits = await deps.store.bumpCounter(pk, "total#events");
    if (hits > deps.dailyCap) return { counted: false, capped: true, newVisitor: false };
    const salt = await currentSalt(deps, window);
    await countConversion(deps, ev.siteId, day, ev.goal, visitorHash(salt, ip, ua, ev.siteId), expiresAt);
    return { counted: true, capped: false, newVisitor: false };
  }

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
  // Hash rows age out with the window (+2d grace), NOT a fixed 40 days — while the salt is
  // shared inside a window, the rows are the only place the hash exists at rest.
  // (The window itself was derived above, from the same single settings read.)
  const salt = await currentSalt(deps, window);
  const hash = visitorHash(salt, ip, ua, ev.siteId);

  // Page goals (§7e): a registered path counts as a conversion on the pageview itself —
  // no second request from the browser, and nothing extra is collected. Their totals are
  // ALSO derivable from the page counters, which is what makes page goals retroactive;
  // these rows exist so "how many different people" is answerable too.
  for (const g of goals) {
    if (g.kind === "page" && g.path === ev.path) {
      await countConversion(deps, ev.siteId, day, g.name, hash, expiresAt);
    }
  }

  const newVisitor = await deps.store.putUniqueIfNew(uniqPk(ev.siteId, day), hash, expiresAt);
  if (newVisitor) {
    const bumps = [{ pk, sk: "total#uniques" }];
    // New vs returning (§6b's free by-product): with a multi-day window, the window-scoped
    // dedup row tells us whether today's first visit is the visitor's first in the WINDOW.
    // No extra identity is kept — it's the same hash, in one more TTL'd row. A 1-day window
    // can't see returns by construction, so every unique is "new" (the UI says why).
    if (saltDays > 1) {
      const firstInWindow = await deps.store.putUniqueIfNew(
        `site#${ev.siteId}#uniq#${window.key}`,
        hash,
        expiresAt,
      );
      bumps.push({ pk, sk: firstInWindow ? "total#new" : "total#returning" });
    } else {
      bumps.push({ pk, sk: "total#new" });
    }
    await deps.store.bumpCounters(bumps);
  }

  return { counted: true, capped: false, newVisitor };
}
