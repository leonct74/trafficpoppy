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
import { reduceLive, reduceRange, type LiveStats, type RangeStats } from "../../shared/src/range";

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
    // The reduction itself lives in shared/ so the viewer Lambda (browser dashboard, §7b)
    // computes byte-identical numbers from the same rows. Two implementations would drift.
    return reduceRange(siteId, days, perDay, perPrevDay);
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
    const rows = (out.Items ?? []).map((it) => ({ sk: it.sk?.S ?? "", count: Number(it.count?.N ?? "0") }));
    return reduceLive(siteId, rows, now);
  }
}

/**
 * The read-model types and the day-window helper now live in shared/ — imported by BOTH the
 * sidecar (desktop poppy) and the viewer Lambda (browser dashboard, §7b). Re-exported here so
 * every existing importer of ./sites keeps working unchanged.
 */
export type { LiveStats, RangeStats } from "../../shared/src/range";
export { lastDays } from "../../shared/src/range";
