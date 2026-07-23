// The site registry + the dashboard read — both talk to the owner's own DynamoDB table
// (the BYO-cloud design: the owner's config and data live in the owner's cloud, reachable
// from any machine they connect, not stuck in one sidecar's local files).
//
// Sites: pk="sites", sk="site#<id>" — a random, unguessable id (it rides in the public
// script tag, so it must not be sequential). Counters are read with a single Query per day
// partition (DESIGN.md §2). DynamoDB access is injected so this is unit-testable.

import {
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";

export interface Site {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
}

const SITES_PK = "sites";
const siteSk = (id: string) => `site#${id}`;

/** A random, URL-safe, non-sequential site id (it's public in the script tag). */
export function newSiteId(rng: () => Buffer = () => randomBytes(9)): string {
  return rng().toString("base64url");
}

/** Read the day's counter partition and split the metric rows the dashboard needs. */
export interface SiteStats {
  siteId: string;
  day: string;
  views: number;
  uniques: number;
  topPages: { key: string; count: number }[];
  topReferrers: { key: string; count: number }[];
  browsers: { key: string; count: number }[];
  /** True if any events have landed for the day — powers the "receiving data?" check. */
  receiving: boolean;
}

export class SiteRegistry {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly tableName: string,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  async list(): Promise<Site[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: SITES_PK } },
      }),
    );
    return (out.Items ?? [])
      .map((it) => ({
        id: it.siteId?.S ?? "",
        name: it.name?.S ?? "",
        domain: it.domain?.S ?? "",
        createdAt: it.createdAt?.S ?? "",
      }))
      .filter((s) => s.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(input: { name: string; domain: string }, id = newSiteId()): Promise<Site> {
    const name = input.name.trim();
    const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!name) throw new Error("Give the site a name so you can tell it apart from your others.");
    const site: Site = { id, name, domain, createdAt: this.nowIso() };
    await this.db.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          pk: { S: SITES_PK },
          sk: { S: siteSk(id) },
          siteId: { S: id },
          name: { S: name },
          domain: { S: domain },
          createdAt: { S: site.createdAt },
        },
        ConditionExpression: "attribute_not_exists(sk)", // never clobber an existing id
      }),
    );
    return site;
  }

  async remove(id: string): Promise<void> {
    await this.db.send(
      new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: SITES_PK }, sk: { S: siteSk(id) } } }),
    );
  }

  /** One Query over a single day partition → its raw counter rows. */
  private async dayRows(siteId: string, day: string): Promise<{ sk: string; count: number }[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: `site#${siteId}#day#${day}` } },
      }),
    );
    return (out.Items ?? []).map((it) => ({ sk: it.sk?.S ?? "", count: Number(it.count?.N ?? "0") }));
  }

  /** The dashboard read for one site + UTC day: one Query over the day partition. */
  async stats(siteId: string, day: string): Promise<SiteStats> {
    const rows = await this.dayRows(siteId, day);
    const pick = (prefix: string) =>
      rows
        .filter((r) => r.sk.startsWith(prefix))
        .map((r) => ({ key: r.sk.slice(prefix.length), count: r.count }))
        .sort((a, b) => b.count - a.count);
    const one = (sk: string) => rows.find((r) => r.sk === sk)?.count ?? 0;

    return {
      siteId,
      day,
      views: one("total#views"),
      uniques: one("total#uniques"),
      topPages: pick("page#").slice(0, 10),
      topReferrers: pick("ref#").slice(0, 10),
      browsers: pick("browser#"),
      receiving: rows.length > 0,
    };
  }

  /**
   * The range read behind the dashboard (DESIGN.md §7.2): one Query per day, in parallel,
   * merged in memory. Day partitions are small (one row per distinct counter), so even 30
   * days is 30 cheap reads against the owner's own table.
   *
   * "uniques" over a range is the SUM OF DAILY UNIQUES — the only thing our privacy model
   * can know: the daily salt is destroyed every 24 h, so cross-day identity cannot exist,
   * by design (DESIGN.md §4). The UI labels it accordingly.
   */
  async rangeStats(siteId: string, days: string[], prevDays: string[] = []): Promise<RangeStats> {
    const [perDay, perPrevDay] = await Promise.all([
      Promise.all(days.map((d) => this.dayRows(siteId, d))),
      Promise.all(prevDays.map((d) => this.dayRows(siteId, d))),
    ]);

    const series: { day: string; views: number; uniques: number }[] = [];
    const sums = new Map<string, number>();
    for (let i = 0; i < days.length; i++) {
      const rows = perDay[i]!;
      const one = (sk: string) => rows.find((r) => r.sk === sk)?.count ?? 0;
      series.push({ day: days[i]!, views: one("total#views"), uniques: one("total#uniques") });
      for (const r of rows) sums.set(r.sk, (sums.get(r.sk) ?? 0) + r.count);
    }

    const pick = (prefix: string, limit: number) =>
      [...sums.entries()]
        .filter(([sk]) => sk.startsWith(prefix))
        .map(([sk, count]) => ({ key: sk.slice(prefix.length), count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, limit);

    return {
      siteId,
      from: days[0] ?? "",
      to: days[days.length - 1] ?? "",
      days: series,
      views: sums.get("total#views") ?? 0,
      uniques: sums.get("total#uniques") ?? 0,
      topPages: pick("page#", 10),
      topReferrers: pick("ref#", 10),
      browsers: pick("browser#", 8),
      os: pick("os#", 8),
      sizes: pick("size#", 8),
      // The marketing view: the allowlisted utm params (exactly these three — DESIGN.md §6).
      utmSources: pick("utm_source#", 10),
      utmCampaigns: pick("utm_campaign#", 10),
      utmMediums: pick("utm_medium#", 10),
      // Geography (True Reach tier) — empty until CloudFront fronts the collector.
      countries: pick("country#", 12),
      // Hour-of-day distribution (UTC) — 24 buckets, from the collector's hour# counters.
      hours: Array.from({ length: 24 }, (_, h) => sums.get(`hour#${String(h).padStart(2, "0")}`) ?? 0),
      prev: prevDays.length > 0 ? this.prevWindow(perPrevDay) : undefined,
      receiving: sums.size > 0,
    };
  }

  /** The previous window's totals + breakdowns — what Δ% chips and top movers compare against. */
  private prevWindow(perDay: { sk: string; count: number }[][]): NonNullable<RangeStats["prev"]> {
    const sums = new Map<string, number>();
    for (const rows of perDay) for (const r of rows) sums.set(r.sk, (sums.get(r.sk) ?? 0) + r.count);
    const pick = (prefix: string) =>
      [...sums.entries()]
        .filter(([sk]) => sk.startsWith(prefix))
        .map(([sk, count]) => ({ key: sk.slice(prefix.length), count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return {
      views: sums.get("total#views") ?? 0,
      uniques: sums.get("total#uniques") ?? 0,
      topPages: pick("page#"),
      topReferrers: pick("ref#"),
    };
  }

  /**
   * The live "last 30 minutes" read: one Query over the site's rolling per-minute
   * partition (rows are TTL'd at 2 h, so it stays tiny), reduced to a 30-slot series.
   */
  async live(siteId: string, now: Date): Promise<LiveStats> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: `site#${siteId}#recent` } },
      }),
    );
    const byMinute = new Map<string, number>();
    for (const it of out.Items ?? []) {
      const sk = it.sk?.S ?? "";
      if (sk.startsWith("t#")) byMinute.set(sk.slice(2), Number(it.count?.N ?? "0"));
    }
    const minutes: { minute: string; views: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const m = new Date(now.getTime() - i * 60_000).toISOString().slice(0, 16);
      minutes.push({ minute: m, views: byMinute.get(m) ?? 0 });
    }
    return { siteId, minutes, views: minutes.reduce((a, b) => a + b.views, 0) };
  }
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
  /** The immediately-preceding window of the same length — for Δ% and top movers. */
  prev?: { views: number; uniques: number; topPages: { key: string; count: number }[]; topReferrers: { key: string; count: number }[] };
  receiving: boolean;
}

/** The last `n` UTC days ending today, oldest first (n=1 ⇒ just today). */
export function lastDays(n: number, today: string): string[] {
  const end = new Date(`${today}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}
