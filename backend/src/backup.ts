// Back up & restore the owner's statistics — the "teardown export" DESIGN.md §12 promises
// as part of the free core. Born 2026-08-05 for the certify run: certification is a real
// teardown, and teardown deletes the table, so the numbers must be able to leave first.
//
// WHAT A BACKUP KEEPS, AND WHAT IT NEVER CONTAINS (privacy invariants, DESIGN.md §2):
//   kept    — the site registry (ids intact, so existing snippets keep working after a
//             restore) and every aggregate day counter.
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
  PutItemCommand,
  ScanCommand,
  type DynamoDBClient,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

export interface BackupSummary {
  path: string;
  rows: number;
  /** Row count per family, so the UI can say what was kept in plain words. */
  sites: number;
  counters: number;
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

export async function createBackup(
  db: DynamoDBClient,
  tableName: string,
  opts?: { dir?: string; now?: Date },
): Promise<BackupSummary> {
  const rows: Row[] = [];
  let sites = 0;
  let counters = 0;
  let startKey: Row | undefined;
  do {
    const page = await db.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }),
    );
    for (const item of page.Items ?? []) {
      const kind = keepRow(item as Row);
      if (!kind) continue;
      if (kind === "site") sites += 1;
      else counters += 1;
      rows.push(item as Row);
    }
    startKey = page.LastEvaluatedKey as Row | undefined;
  } while (startKey);

  const now = opts?.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const path = backupPath(opts?.dir ?? defaultBackupDir(), today);
  const body = { version: 1, exportedAt: now.toISOString(), table: tableName, rows };
  await writeFile(path, JSON.stringify(body), "utf8");
  return { path, rows: rows.length, sites, counters };
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
): Promise<{ restored: number }> {
  // Only files that look like ours — this endpoint must never become a generic file reader.
  if (!FILE_RE.test(basename(path))) throw new Error("Not a TrafficPoppy backup file.");
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: number; rows?: Row[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.rows)) {
    throw new Error("This file is not a readable TrafficPoppy backup.");
  }
  let restored = 0;
  for (const row of parsed.rows) {
    // Re-apply the whitelist on the way IN too: an edited file cannot smuggle salt or
    // visitor-hash rows back into the table.
    if (!keepRow(row)) continue;
    await db.send(new PutItemCommand({ TableName: tableName, Item: row }));
    restored += 1;
  }
  return { restored };
}
