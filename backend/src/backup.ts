// Back up & restore the owner's statistics. Born 2026-08-05 for the certify run:
// certification is a real teardown, and teardown deletes the table, so the numbers must
// be able to leave first.
//
// PAID, PER SITE (founder decision 2026-08-05, same shape as Advanced Stats): a backup
// covers only sites whose own domain is unlocked. The gate is derived HERE, server-side,
// from the deployed edge domains — the same source the viewer Lambda's online gate reads
// — never from anything the frontend sends (MailPoppy lesson: isolation comes from
// verified state). Excluded sites are REPORTED back so the UI can name them: a backup
// that silently skipped sites would be a data-loss surprise at teardown time.
//
// WHAT A BACKUP KEEPS, AND WHAT IT NEVER CONTAINS (privacy invariants, DESIGN.md §2):
//   kept    — the unlocked sites' registry rows (ids intact, so existing snippets keep
//             working after a restore) and their aggregate day counters.
//   skipped — the salt (regenerated fresh), the salted visitor-hash rows (they die with
//             the table BY DESIGN; after a restore, returning visitors count as new once
//             per window — the honest price), the 30-minute live ticker, and the True
//             Reach cert rows (a fresh edge setup recreates them; stale ones would point
//             at torn-down stacks).
// The whitelist is deliberate: an unknown future row family drops out of backups until
// it is classified here, which fails SAFE for privacy.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type DynamoDBClient,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { isFirstPartyFor } from "../../shared/src/first-party";

export interface BackupSummary {
  path: string;
  rows: number;
  /** Row count per family, so the UI can say what was kept in plain words. */
  sites: number;
  counters: number;
  /** Sites left out because their domain has no Advanced Stats — named in the UI. */
  skippedSites: string[];
}

export interface BackupFileInfo {
  path: string;
  /** The YYYY-MM-DD the filename carries. */
  date: string;
  bytes: number;
}

type Row = Record<string, AttributeValue>;

const FILE_PREFIX = "TrafficPoppy-backup-";
const FILE_RE = /^TrafficPoppy-backup-(\d{4}-\d{2}-\d{2})\.json$/;

/** One backup file per day, deterministic name — re-running overwrites, never multiplies. */
export function backupPath(dir: string, today: string): string {
  return join(dir, `${FILE_PREFIX}${today}.json`);
}

export function defaultBackupDir(): string {
  return join(homedir(), "Documents");
}

/** The keep/skip decision — the whole privacy contract of a backup lives here. */
export function keepRow(row: Row): "site" | "counter" | null {
  const pk = row.pk?.S ?? "";
  const sk = row.sk?.S ?? "";
  if (pk === "sites" && sk.startsWith("site#")) return "site";
  if (pk.startsWith("site#") && pk.includes("#day#")) return "counter";
  return null; // salt, uniq#, recent, truereach/cert#, and anything not yet classified
}

/** The site id a counter row belongs to: pk is `site#<id>#day#<YYYY-MM-DD>`. */
export function counterSiteId(pk: string): string {
  return pk.slice("site#".length, pk.indexOf("#day#"));
}

/**
 * @param onlineDomains the deployed edge domains (the paid gate) — a site is included
 *        only when one of them is, or is under, the site's own domain.
 * @param opts.siteIds the owner's explicit pick (from the checkboxes). Omit for "all
 *        unlocked". It can only ever NARROW the gate, never widen it.
 */
export async function createBackup(
  db: DynamoDBClient,
  tableName: string,
  onlineDomains: string[],
  opts?: { dir?: string; now?: Date; siteIds?: string[] },
): Promise<BackupSummary> {
  // Pass 1: read everything the whitelist allows, remembering which site each row is for.
  const siteRows: { row: Row; id: string; domain: string }[] = [];
  const counterRows: { row: Row; siteId: string }[] = [];
  let startKey: Row | undefined;
  do {
    const page = await db.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }),
    );
    for (const item of page.Items ?? []) {
      const row = item as Row;
      const kind = keepRow(row);
      if (kind === "site") {
        siteRows.push({
          row,
          id: (row.sk?.S ?? "").slice("site#".length),
          domain: row.domain?.S ?? "",
        });
      } else if (kind === "counter") {
        counterRows.push({ row, siteId: counterSiteId(row.pk?.S ?? "") });
      }
    }
    startKey = page.LastEvaluatedKey as Row | undefined;
  } while (startKey);

  // Pass 2: the paid gate first (never negotiable), then the owner's own selection.
  const unlocked = siteRows.filter((s) => onlineDomains.some((d) => isFirstPartyFor(s.domain, d)));
  const unlockedIds = new Set(unlocked.map((s) => s.id));
  const skippedSites = siteRows.filter((s) => !unlockedIds.has(s.id)).map((s) => s.domain || s.id);
  const pick = opts?.siteIds;
  const included = pick ? unlocked.filter((s) => pick.includes(s.id)) : unlocked;
  const includedIds = new Set(included.map((s) => s.id));
  const counters = counterRows.filter((c) => includedIds.has(c.siteId));
  const rows: Row[] = [...included.map((s) => s.row), ...counters.map((c) => c.row)];

  const now = opts?.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const path = backupPath(opts?.dir ?? defaultBackupDir(), today);
  const body = { version: 1, exportedAt: now.toISOString(), table: tableName, rows };
  await writeFile(path, JSON.stringify(body), "utf8");
  return { path, rows: rows.length, sites: included.length, counters: counters.length, skippedSites };
}

export async function listBackups(dir = defaultBackupDir()): Promise<BackupFileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupFileInfo[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      out.push({ path: join(dir, name), date: m[1]!, bytes: Buffer.byteLength(raw) });
    } catch {
      /* unreadable file — not a backup we can offer */
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)); // newest first
}

/**
 * Restore a backup file into the (typically fresh) table. PutItem per row — same keys
 * overwrite, so restoring twice is idempotent, and restoring an OLD backup over NEWER
 * data replaces those rows (the UI confirms before calling).
 */
export async function restoreBackup(
  db: DynamoDBClient,
  tableName: string,
  path: string,
): Promise<{ restored: number; mergedSites: string[]; conflicts: string[] }> {
  // Only files that look like ours — this endpoint must never become a generic file reader.
  if (!FILE_RE.test(basename(path))) throw new Error("Not a TrafficPoppy backup file.");
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: number; rows?: Row[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.rows)) {
    throw new Error("This file is not a readable TrafficPoppy backup.");
  }

  // Which sites already exist, by domain — a restore after a rebuild lands next to sites
  // the owner re-created in the meantime (founder 2026-08-05: "it created a duplication
  // of the website records, instead of merging with the current deployment").
  const existing = new Map<string, { id: string }[]>();
  let startKey: Row | undefined;
  do {
    const page = await db.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }));
    for (const item of page.Items ?? []) {
      const row = item as Row;
      if (keepRow(row) !== "site") continue;
      const domain = normalizeDomain(row.domain?.S ?? "");
      if (!domain) continue;
      const id = (row.sk?.S ?? "").slice("site#".length);
      existing.set(domain, [...(existing.get(domain) ?? []), { id }]);
    }
    startKey = page.LastEvaluatedKey as Row | undefined;
  } while (startKey);

  let restored = 0;
  const restoredSiteIds = new Map<string, string>(); // domain → restored id
  for (const row of parsed.rows) {
    // Re-apply the whitelist on the way IN too: an edited file cannot smuggle salt or
    // visitor-hash rows back into the table.
    const kind = keepRow(row);
    if (!kind) continue;
    if (kind === "site") {
      const domain = normalizeDomain(row.domain?.S ?? "");
      if (domain) restoredSiteIds.set(domain, (row.sk?.S ?? "").slice("site#".length));
    }
    await db.send(new PutItemCommand({ TableName: tableName, Item: row }));
    restored += 1;
  }

  // MERGE, NEVER DUPLICATE (founder rule 2026-08-06: "confirm restore doesn't create
  // duplicates any more, otherwise we need to remove it"). For every domain the restore
  // brought back, the other site record for that same domain is absorbed — always, with
  // no leftover for the owner to reconcile:
  //   · twin holds no counters → it was a placeholder re-created while the history sat in
  //     the file; delete the row and keep the restored id.
  //   · twin holds data → it is the record the live snippet reports into, so the RESTORED
  //     history moves onto it (arithmetic, nothing overwritten) and the restored row goes.
  // Either way exactly one record per domain survives, and it's the one already receiving
  // traffic — so no website ever needs its tag edited.
  const mergedSites: string[] = [];
  for (const [domain, restoredId] of restoredSiteIds) {
    for (const twin of existing.get(domain) ?? []) {
      if (twin.id === restoredId) continue;
      if (await siteHasCounters(db, tableName, twin.id)) {
        await mergeSites(db, tableName, restoredId, twin.id);
      } else {
        await db.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: { pk: { S: "sites" }, sk: { S: `site#${twin.id}` } },
          }),
        );
      }
      mergedSites.push(domain);
    }
  }

  return { restored, mergedSites, conflicts: [] as string[] };
}

/**
 * Move one site's whole history onto another site id, adding where both hold the same
 * day (counters are `count` numbers keyed by (pk, sk), so a merge is arithmetic — no row
 * is overwritten and nothing is lost). Born 2026-08-05: a rebuild + restore leaves the
 * history under the OLD id while the website's tag already reports into a NEW one, and
 * deleting either side would throw away real numbers. Merging into the id the tag uses
 * means the owner never has to edit their website again.
 *
 * Idempotent it is NOT — running it twice would double the moved counts — so the source
 * rows are deleted as they are applied, and the source site row last. A crash mid-merge
 * leaves the remainder in place, and re-running finishes the job.
 */
export async function mergeSites(
  db: DynamoDBClient,
  tableName: string,
  fromSiteId: string,
  intoSiteId: string,
): Promise<{ movedRows: number; days: number }> {
  if (!fromSiteId || !intoSiteId) throw new Error("Both sites are needed to merge.");
  if (fromSiteId === intoSiteId) throw new Error("That is the same site.");

  let movedRows = 0;
  const days = new Set<string>();
  // Rows are deleted as they're applied, so paging with ExclusiveStartKey would resume
  // from keys that no longer exist. Rescan from the top until the source is drained.
  for (let pass = 0; pass < 10_000; pass++) {
    const page = await db.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": { S: `site#${fromSiteId}#day#` } },
      }),
    );
    if ((page.Items ?? []).length === 0) break;
    for (const item of page.Items ?? []) {
      const row = item as Row;
      const pk = row.pk?.S ?? "";
      const sk = row.sk?.S ?? "";
      const count = Number(row.count?.N ?? "0");
      const day = pk.slice(pk.indexOf("#day#") + "#day#".length);
      if (!sk || !Number.isFinite(count) || count === 0) continue;
      days.add(day);
      await db.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: { S: `site#${intoSiteId}#day#${day}` }, sk: { S: sk } },
          UpdateExpression: "ADD #c :n",
          ExpressionAttributeNames: { "#c": "count" },
          ExpressionAttributeValues: { ":n": { N: String(count) } },
        }),
      );
      await db.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: pk }, sk: { S: sk } } }));
      movedRows += 1;
    }
  }

  // The now-empty site row goes last: if anything above failed, the site is still listed
  // and the merge can be re-run.
  await db.send(
    new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: "sites" }, sk: { S: `site#${fromSiteId}` } } }),
  );
  return { movedRows, days: days.size };
}

/** A site's address reduced to the form two rows can be compared on. */
function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/:].*$/, "");
}

/** Does this site hold any day counters? Cheap existence check — one row is enough. */
async function siteHasCounters(db: DynamoDBClient, tableName: string, siteId: string): Promise<boolean> {
  const out = await db.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": { S: `site#${siteId}#day#${new Date().toISOString().slice(0, 10)}` } },
      Limit: 1,
    }),
  );
  if ((out.Items ?? []).length > 0) return true;
  // Days are separate partitions, so "today" alone can miss data. Fall back to a bounded
  // scan for any counter row of this site.
  const scan = await db.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": { S: `site#${siteId}#day#` } },
      Limit: 200,
    }),
  );
  return (scan.Items ?? []).length > 0;
}
