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
  UpdateItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { reduceLive, reduceRange, type LiveStats, type RangeStats } from "../../shared/src/range";
import { MAX_GOALS, parseGoals, readGoals, type Goal } from "../../shared/src/goals";

export interface Site {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
  /** The §6b baseline salt window in days (1–7). Absent ⇒ 1 (today's behavior). */
  saltDays?: number;
  /** The site's conversion goals (§7e). Empty until the owner creates one. */
  goals?: Goal[];
}

/** The §6b consent-free ceiling — mirrors lambdas/src/ingest.ts, which also clamps. */
export const MAX_SALT_DAYS = 7;

/** Clamp an owner-supplied salt window to 1–7 whole days. */
export function clampSaltDays(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_SALT_DAYS, Math.max(1, v));
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
        saltDays: it.saltDays?.N ? clampSaltDays(it.saltDays.N) : undefined,
        goals: readGoals(it.goals?.S),
      }))
      .filter((s) => s.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Set the site's salt window (§6b baseline). Clamped to 1–7 days HERE as well as in the
   * collector — no stored value may ever exceed the consent-free ceiling. Setting 1 removes
   * the attribute (1 is the default; an absent attribute keeps old rows byte-identical).
   */
  async setSaltDays(id: string, saltDays: unknown): Promise<number> {
    const days = clampSaltDays(saltDays);
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: SITES_PK }, sk: { S: siteSk(id) } },
        ConditionExpression: "attribute_exists(sk)", // no ghost rows for deleted sites
        ...(days === 1
          ? { UpdateExpression: "REMOVE saltDays" }
          : {
              UpdateExpression: "SET saltDays = :d",
              ExpressionAttributeValues: { ":d": { N: String(days) } },
            }),
      }),
    );
    return days;
  }

  /**
   * Replace a site's conversion goals (§7e). Validated HERE, on the trusted side: the
   * collector refuses any name that isn't on this list, so this write is the whole
   * registration surface. Stored as one JSON attribute on the site row, which means goals
   * ride along in backups and survive a restore with the site they belong to.
   */
  async setGoals(id: string, goals: unknown): Promise<Goal[]> {
    const parsed = parseGoals(goals).map((g) => ({ ...g, createdAt: g.createdAt ?? this.nowIso().slice(0, 10) }));
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: SITES_PK }, sk: { S: siteSk(id) } },
        ConditionExpression: "attribute_exists(sk)", // never resurrect a deleted site
        ...(parsed.length === 0
          ? { UpdateExpression: "REMOVE goals" }
          : {
              UpdateExpression: "SET goals = :g",
              ExpressionAttributeValues: { ":g": { S: JSON.stringify(parsed) } },
            }),
      }),
    );
    return parsed;
  }

  /** One site's registered goals — what the range read needs to name its counters. */
  async goals(id: string): Promise<Goal[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p AND sk = :s",
        ExpressionAttributeValues: { ":p": { S: SITES_PK }, ":s": { S: siteSk(id) } },
      }),
    );
    return readGoals(out.Items?.[0]?.goals?.S);
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
    const [perDay, perPrevDay, goals] = await Promise.all([
      Promise.all(days.map((d) => this.dayRows(siteId, d))),
      Promise.all(prevDays.map((d) => this.dayRows(siteId, d))),
      this.goals(siteId),
    ]);
    // The reduction itself lives in shared/ so the viewer Lambda (browser dashboard, §7b)
    // computes byte-identical numbers from the same rows. Two implementations would drift.
    return reduceRange(siteId, days, perDay, perPrevDay, goals);
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
export { MAX_GOALS };
export type { Goal };
export { lastDays } from "../../shared/src/range";
