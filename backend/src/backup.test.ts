import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBackup, keepRow, listBackups, restoreBackup } from "./backup";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const row = (pk: string, sk: string, extra: Record<string, unknown> = {}) =>
  ({ pk: { S: pk }, sk: { S: sk }, ...extra }) as never;

/**
 * The whitelist IS the privacy contract of a backup (DESIGN.md §2): sites and aggregate
 * counters leave the table; anything touching individual visits never does.
 */
describe("keepRow — what a backup may contain", () => {
  it("keeps site registry rows and aggregate day counters", () => {
    expect(keepRow(row("sites", "site#abc123"))).toBe("site");
    expect(keepRow(row("site#abc123#day#2026-08-05", "total#views"))).toBe("counter");
    expect(keepRow(row("site#abc123#day#2026-08-05", "page#/pricing"))).toBe("counter");
    expect(keepRow(row("site#abc123#day#2026-08-05", "edge#/a#/b"))).toBe("counter");
  });

  it("NEVER keeps the salt, visitor-hash rows, the live ticker, or cert rows", () => {
    expect(keepRow(row("salt", "2026-08-05"))).toBeNull();
    expect(keepRow(row("site#abc123#uniq#2026-08-05", "somesaltedhash"))).toBeNull();
    expect(keepRow(row("site#abc123#recent", "2026-08-05T10:05"))).toBeNull();
    expect(keepRow(row("truereach", "cert#stats.example.com"))).toBeNull();
  });

  it("fails safe: an unclassified future row family stays OUT until classified here", () => {
    expect(keepRow(row("site#abc123#somethingnew", "x"))).toBeNull();
    expect(keepRow(row("mystery", "y"))).toBeNull();
  });
});

describe("createBackup", () => {
  const site = (id: string, domain: string) => row("sites", `site#${id}`, { domain: { S: domain } });

  it("scans every page, filters through the whitelist, and writes one deterministic file per day", async () => {
    const pages = [
      { Items: [site("a", "ollydigital.com"), row("salt", "2026-08-05")], LastEvaluatedKey: { pk: { S: "x" } } },
      { Items: [row("site#a#day#2026-08-04", "total#views", { views: { N: "12" } }), row("site#a#uniq#2026-08-04", "h1")] },
    ];
    let call = 0;
    const db = { send: vi.fn().mockImplementation(() => Promise.resolve(pages[call++])) } as unknown as DynamoDBClient;

    const dir = mkdtempSync(join(tmpdir(), "tp-backup-"));
    const now = new Date("2026-08-05T10:00:00Z");
    const summary = await createBackup(db, "TrafficPoppyTable", ["stats.ollydigital.com"], { dir, now });

    expect(summary).toMatchObject({ rows: 2, sites: 1, counters: 1, skippedSites: [] });
    expect(summary.path).toBe(join(dir, "TrafficPoppy-backup-2026-08-05.json"));
    const body = JSON.parse(await readFile(summary.path, "utf8"));
    expect(body.version).toBe(1);
    expect(body.rows).toHaveLength(2);
    // The counter's attribute values ride along losslessly.
    expect(body.rows[1].views).toEqual({ N: "12" });
    // And nothing sensitive slipped in.
    expect(JSON.stringify(body)).not.toContain("uniq");
    expect(JSON.stringify(body)).not.toContain('"salt"');
  });

  /**
   * PAID PER SITE (founder decision 2026-08-05): a backup covers only unlocked sites —
   * same rule as the online dashboard. The gate is these onlineDomains, derived
   * server-side from the cert registry; nothing the frontend says can widen it.
   */
  it("includes ONLY sites whose domain is unlocked — counters follow their site", async () => {
    const db = {
      send: vi.fn().mockResolvedValue({
        Items: [
          site("a", "ollydigital.com"), // unlocked
          site("b", "other-site.com"), // free tier
          row("site#a#day#2026-08-04", "total#views", { views: { N: "12" } }),
          row("site#b#day#2026-08-04", "total#views", { views: { N: "99" } }),
        ],
      }),
    } as unknown as DynamoDBClient;

    const dir = mkdtempSync(join(tmpdir(), "tp-gate-"));
    const summary = await createBackup(db, "T", ["stats.ollydigital.com"], {
      dir,
      now: new Date("2026-08-05T10:00:00Z"),
    });

    expect(summary).toMatchObject({ sites: 1, counters: 1 });
    // The excluded site is NAMED so the UI can warn — never a silent omission.
    expect(summary.skippedSites).toEqual(["other-site.com"]);
    const body = await readFile(summary.path, "utf8");
    expect(body).toContain("ollydigital.com");
    expect(body).not.toContain("other-site.com");
    expect(body).not.toContain('"99"'); // the free site's numbers never leave the table
  });

  it("with nothing unlocked, backs up nothing and says which sites were skipped", async () => {
    const db = {
      send: vi.fn().mockResolvedValue({ Items: [site("a", "ollydigital.com"), row("site#a#day#2026-08-04", "total#views")] }),
    } as unknown as DynamoDBClient;
    const dir = mkdtempSync(join(tmpdir(), "tp-none-"));
    const summary = await createBackup(db, "T", [], { dir, now: new Date("2026-08-05T10:00:00Z") });
    expect(summary).toMatchObject({ rows: 0, sites: 0, counters: 0, skippedSites: ["ollydigital.com"] });
  });
});

describe("restoreBackup", () => {
  const dirOf = () => mkdtempSync(join(tmpdir(), "tp-restore-"));

  it("puts every whitelisted row back and re-filters on the way in", async () => {
    const dir = dirOf();
    const path = join(dir, "TrafficPoppy-backup-2026-08-05.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rows: [
          row("sites", "site#a", { domain: { S: "ollydigital.com" } }),
          row("site#a#day#2026-08-04", "total#views", { views: { N: "12" } }),
          row("salt", "2026-08-05"), // an edited file cannot smuggle this back in
        ],
      }),
    );
    // Empty table: the opening scan finds no existing sites, so nothing to merge.
    const db = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBClient;
    const r = await restoreBackup(db, "TrafficPoppyTable", path);
    expect(r).toMatchObject({ restored: 2, mergedSites: [], conflicts: [] });
    // One scan + two puts; the salt row never became a third put.
    expect((db.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  /**
   * Founder 2026-08-05: restoring after a rebuild "created a duplication of the website
   * records, instead of merging with the current deployment" — every site appeared twice,
   * once with the history and once with the fresh (empty) collection. Restoring MERGES:
   * the empty twin the owner re-created is removed; a twin holding real data is never
   * deleted silently, only reported.
   */
  describe("merging a restore into a rebuilt deployment", () => {
    const fileWith = (dir: string) => {
      const path = join(dir, "TrafficPoppy-backup-2026-08-05.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          rows: [
            row("sites", "site#old", { domain: { S: "ollydigital.com" } }),
            row("site#old#day#2026-08-04", "total#views", { views: { N: "12" } }),
          ],
        }),
      );
      return path;
    };

    it("removes the EMPTY twin the owner re-created, keeping the restored site", async () => {
      const path = fileWith(dirOf());
      const calls: unknown[] = [];
      const db = {
        send: vi.fn().mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          calls.push(cmd);
          const name = cmd.constructor.name;
          // Opening scan: the rebuilt table already has a re-created ollydigital.com.
          if (name === "ScanCommand" && !cmd.input.FilterExpression) {
            return Promise.resolve({ Items: [row("sites", "site#new", { domain: { S: "ollydigital.com" } })] });
          }
          return Promise.resolve({ Items: [] }); // the twin holds no counters
        }),
      } as unknown as DynamoDBClient;

      const r = await restoreBackup(db, "T", path);
      expect(r.mergedSites).toEqual(["ollydigital.com"]);
      expect(r.conflicts).toEqual([]);
      const del = calls.find((c) => (c as { constructor: { name: string } }).constructor.name === "DeleteItemCommand");
      expect((del as { input: { Key: { sk: { S: string } } } }).input.Key.sk.S).toBe("site#new"); // the EMPTY one
    });

    it("never deletes a twin that holds data — it reports the clash instead", async () => {
      const path = fileWith(dirOf());
      const db = {
        send: vi.fn().mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "ScanCommand" && !cmd.input.FilterExpression) {
            return Promise.resolve({ Items: [row("sites", "site#new", { domain: { S: "ollydigital.com" } })] });
          }
          if (name === "DeleteItemCommand") throw new Error("must not delete a site holding data");
          return Promise.resolve({ Items: [row("site#new#day#2026-08-05", "total#views")] }); // twin HAS data
        }),
      } as unknown as DynamoDBClient;

      const r = await restoreBackup(db, "T", path);
      expect(r.conflicts).toEqual(["ollydigital.com"]);
      expect(r.mergedSites).toEqual([]);
    });
  });

  it("refuses files that are not TrafficPoppy backups — never a generic file reader", async () => {
    const db = { send: vi.fn() } as unknown as DynamoDBClient;
    await expect(restoreBackup(db, "T", "/etc/passwd")).rejects.toThrow(/not a TrafficPoppy backup/i);
    const dir = dirOf();
    const bad = join(dir, "TrafficPoppy-backup-2026-08-05.json");
    writeFileSync(bad, JSON.stringify({ nonsense: true }));
    await expect(restoreBackup(db, "T", bad)).rejects.toThrow(/not a readable/i);
    expect(db.send).not.toHaveBeenCalled();
  });
});

describe("listBackups", () => {
  it("lists only our files, newest first, and survives a missing folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-list-"));
    writeFileSync(join(dir, "TrafficPoppy-backup-2026-08-01.json"), "{}");
    writeFileSync(join(dir, "TrafficPoppy-backup-2026-08-05.json"), "{}");
    writeFileSync(join(dir, "unrelated.json"), "{}");
    const found = await listBackups(dir);
    expect(found.map((b) => b.date)).toEqual(["2026-08-05", "2026-08-01"]);
    expect(await listBackups(join(dir, "nope"))).toEqual([]);
  });
});
