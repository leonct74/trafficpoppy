// The canonical reduction of raw counter rows → what a dashboard renders.
//
// WHY THIS EXISTS AS SHARED CODE: from P6 there are TWO readers of the same table — the
// desktop poppy (admin plane, via the sidecar) and the browser dashboard (viewer plane, via
// the viewer Lambda). If each reduced rows its own way, the same site would show different
// numbers depending on where you looked, and the drift would appear silently and slowly.
// One implementation, imported by both, makes that class of bug impossible.
//
// Everything here is PURE: rows in, stats out. No AWS SDK, no clock, no I/O — so it is
// exhaustively testable and safe to bundle into a Lambda.

/** One raw counter row as both readers fetch it: the sort key and its accumulated count. */
export interface CounterRow {
  sk: string;
  count: number;
}

/** The live-ticker read: views per minute over the last half hour, oldest first. */
export interface LiveStats {
  siteId: string;
  minutes: { minute: string; views: number }[];
  views: number;
}

/** What the dashboard renders for a picked range. Mirrored in frontend/src/types.ts. */
export interface RangeStats {
  siteId: string;
  from: string;
  to: string;
  /** Per-day series, oldest first — powers the daily bars strip. */
  days: { day: string; views: number; uniques: number }[];
  views: number;
  /** Sum of DAILY uniques — cross-day identity cannot exist (the salt is destroyed daily). */
  uniques: number;
  topPages: { key: string; count: number }[];
  topReferrers: { key: string; count: number }[];
  browsers: { key: string; count: number }[];
  os: { key: string; count: number }[];
  sizes: { key: string; count: number }[];
  /** The allowlisted utm params — the whole marketing-attribution surface (DESIGN.md §6). */
  utmSources: { key: string; count: number }[];
  utmCampaigns: { key: string; count: number }[];
  utmMediums: { key: string; count: number }[];
  /** Country-level geography (True Reach tier) — empty on the free Function-URL path. */
  countries: { key: string; count: number }[];
  /** Views per UTC hour-of-day, 24 buckets (index = hour). */
  hours: number[];
  /**
   * Of the range's daily uniques: first-seen-in-window vs seen-earlier-in-window (§6b).
   * Both zero (with uniques > 0) means the data predates the feature. On a 1-day window
   * returning is 0 by construction — the UI says why instead of showing a hollow zero.
   */
  newVisitors: number;
  returningVisitors: number;
  /**
   * Traffic flow (§7d), aggregate counts only. entries: source → landing path, where
   * source is a referrer hostname or "direct". edges: same-site path → path transitions.
   * Exits are DERIVED by the renderer (arrivals into a page minus departures from it).
   */
  entries: { source: string; path: string; count: number }[];
  edges: { from: string; to: string; count: number }[];
  /** The immediately-preceding window of the same length — for Δ% and top movers. */
  prev?: {
    views: number;
    uniques: number;
    topPages: { key: string; count: number }[];
    topReferrers: { key: string; count: number }[];
  };
  receiving: boolean;
}

/** Sum every row of every day into one sk → total map. */
function sumRows(perDay: CounterRow[][]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const rows of perDay) for (const r of rows) sums.set(r.sk, (sums.get(r.sk) ?? 0) + r.count);
  return sums;
}

/**
 * Rank one counter family (e.g. `page#`) by count, ties broken by key so the order is
 * deterministic — an unstable sort would make the two dashboards disagree on ties.
 */
function rank(sums: Map<string, number>, prefix: string, limit?: number): { key: string; count: number }[] {
  const out = [...sums.entries()]
    .filter(([sk]) => sk.startsWith(prefix))
    .map(([sk, count]) => ({ key: sk.slice(prefix.length), count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return limit === undefined ? out : out.slice(0, limit);
}

/**
 * Split a two-part flow key (`<a>#<b>`) at its FIRST '#'. Unambiguous: a referrer hostname
 * cannot contain '#', and normalizePath strips '?'/'#' from paths — so the one '#' present
 * is always the separator the collector wrote. Deterministically ranked and capped so a
 * large site can't balloon the payload.
 */
function rankPairs(
  sums: Map<string, number>,
  prefix: string,
  limit: number,
): { a: string; b: string; count: number }[] {
  return [...sums.entries()]
    .filter(([sk]) => sk.startsWith(prefix))
    .map(([sk, count]) => {
      const rest = sk.slice(prefix.length);
      const cut = rest.indexOf("#");
      return { a: cut < 0 ? rest : rest.slice(0, cut), b: cut < 0 ? "" : rest.slice(cut + 1), count };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .slice(0, limit);
}

/** The previous window's totals + breakdowns — what Δ% chips and top movers compare against. */
export function reducePrevWindow(perDay: CounterRow[][]): NonNullable<RangeStats["prev"]> {
  const sums = sumRows(perDay);
  return {
    views: sums.get("total#views") ?? 0,
    uniques: sums.get("total#uniques") ?? 0,
    topPages: rank(sums, "page#"),
    topReferrers: rank(sums, "ref#"),
  };
}

/**
 * Reduce a range: one row-set per day (oldest first), plus the preceding window for deltas.
 * `days` and `perDay` must be the same length and in the same order.
 */
export function reduceRange(
  siteId: string,
  days: string[],
  perDay: CounterRow[][],
  perPrevDay: CounterRow[][] = [],
): RangeStats {
  const series: RangeStats["days"] = [];
  for (let i = 0; i < days.length; i++) {
    const rows = perDay[i] ?? [];
    const one = (sk: string) => rows.find((r) => r.sk === sk)?.count ?? 0;
    series.push({ day: days[i]!, views: one("total#views"), uniques: one("total#uniques") });
  }
  const sums = sumRows(perDay);

  return {
    siteId,
    from: days[0] ?? "",
    to: days[days.length - 1] ?? "",
    days: series,
    views: sums.get("total#views") ?? 0,
    uniques: sums.get("total#uniques") ?? 0,
    topPages: rank(sums, "page#", 10),
    topReferrers: rank(sums, "ref#", 10),
    browsers: rank(sums, "browser#", 8),
    os: rank(sums, "os#", 8),
    sizes: rank(sums, "size#", 8),
    utmSources: rank(sums, "utm_source#", 10),
    utmCampaigns: rank(sums, "utm_campaign#", 10),
    utmMediums: rank(sums, "utm_medium#", 10),
    countries: rank(sums, "country#", 12),
    hours: Array.from({ length: 24 }, (_, h) => sums.get(`hour#${String(h).padStart(2, "0")}`) ?? 0),
    newVisitors: sums.get("total#new") ?? 0,
    returningVisitors: sums.get("total#returning") ?? 0,
    entries: rankPairs(sums, "entry#", 30).map(({ a, b, count }) => ({ source: a, path: b, count })),
    edges: rankPairs(sums, "edge#", 60).map(({ a, b, count }) => ({ from: a, to: b, count })),
    prev: perPrevDay.length > 0 ? reducePrevWindow(perPrevDay) : undefined,
    receiving: sums.size > 0,
  };
}

/** Reduce the rolling per-minute partition to the last 30 minutes, oldest first. */
export function reduceLive(siteId: string, rows: CounterRow[], now: Date): LiveStats {
  const byMinute = new Map<string, number>();
  for (const r of rows) if (r.sk.startsWith("t#")) byMinute.set(r.sk.slice(2), r.count);
  const minutes: LiveStats["minutes"] = [];
  for (let i = 29; i >= 0; i--) {
    const m = new Date(now.getTime() - i * 60_000).toISOString().slice(0, 16);
    minutes.push({ minute: m, views: byMinute.get(m) ?? 0 });
  }
  return { siteId, minutes, views: minutes.reduce((a, b) => a + b.views, 0) };
}

/** The last `n` UTC days ending today, oldest first (n=1 ⇒ just today). */
export function lastDays(n: number, today: string): string[] {
  const end = new Date(`${today}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}
