import { describe, expect, it, vi } from "vitest";
import {
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { newSiteId, SiteRegistry } from "./sites";

/** A DynamoDB whose Query returns the given items; records writes. */
function fakeDb(queryItems: Record<string, { S?: string; N?: string }>[] = []) {
  const sent: { name: string; input: any }[] = [];
  const client = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: any }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof QueryCommand) return { Items: queryItems };
      return {};
    }),
  } as unknown as DynamoDBClient;
  return { client, sent };
}

const reg = (db: DynamoDBClient) => new SiteRegistry(db, "TrafficPoppyData", () => "2026-07-18T00:00:00.000Z");

describe("newSiteId — public in the script tag, so unguessable and URL-safe", () => {
  it("is URL-safe and non-trivially long", () => {
    const id = newSiteId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeGreaterThanOrEqual(10);
  });

  it("does not collide across many draws", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSiteId()));
    expect(ids.size).toBe(500);
  });
});

describe("SiteRegistry.create", () => {
  it("stores a site with a normalized domain and refuses to clobber an existing id", async () => {
    const { client, sent } = fakeDb();
    const site = await reg(client).create({ name: "  Olly Digital ", domain: "HTTPS://ollydigital.com/blog" }, "ID1");
    expect(site).toEqual({ id: "ID1", name: "Olly Digital", domain: "ollydigital.com", createdAt: "2026-07-18T00:00:00.000Z" });
    const put = sent.find((c) => c.name === "PutItemCommand")!;
    expect(put.input.ConditionExpression).toMatch(/attribute_not_exists/);
    expect(put.input.Item.sk.S).toBe("site#ID1");
  });

  it("rejects a site with no name", async () => {
    const { client } = fakeDb();
    await expect(reg(client).create({ name: "  ", domain: "x.com" })).rejects.toThrow(/name/i);
  });
});

describe("SiteRegistry.list", () => {
  it("maps + sorts sites by creation time", async () => {
    const { client } = fakeDb([
      { pk: { S: "sites" }, sk: { S: "site#b" }, siteId: { S: "b" }, name: { S: "B" }, domain: { S: "b.com" }, createdAt: { S: "2026-07-02" } },
      { pk: { S: "sites" }, sk: { S: "site#a" }, siteId: { S: "a" }, name: { S: "A" }, domain: { S: "a.com" }, createdAt: { S: "2026-07-01" } },
    ]);
    const sites = await reg(client).list();
    expect(sites.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("SiteRegistry.stats — the dashboard read (one Query per day)", () => {
  it("splits the day partition into views, uniques, and ranked breakdowns", async () => {
    const { client, sent } = fakeDb([
      { sk: { S: "total#views" }, count: { N: "42" } },
      { sk: { S: "total#uniques" }, count: { N: "10" } },
      { sk: { S: "page#/" }, count: { N: "30" } },
      { sk: { S: "page#/pricing" }, count: { N: "12" } },
      { sk: { S: "ref#news.ycombinator.com" }, count: { N: "5" } },
      { sk: { S: "browser#Firefox" }, count: { N: "20" } },
    ]);
    const s = await reg(client).stats("site1", "2026-07-18");
    expect(s.views).toBe(42);
    expect(s.uniques).toBe(10);
    expect(s.topPages).toEqual([
      { key: "/", count: 30 },
      { key: "/pricing", count: 12 },
    ]);
    expect(s.topReferrers[0]).toEqual({ key: "news.ycombinator.com", count: 5 });
    expect(s.receiving).toBe(true);
    // The Query is scoped to exactly this site+day partition.
    const q = sent.find((c) => c.name === "QueryCommand")!;
    expect(q.input.ExpressionAttributeValues[":p"].S).toBe("site#site1#day#2026-07-18");
  });

  it("reports not-receiving when the partition is empty", async () => {
    const { client } = fakeDb([]);
    const s = await reg(client).stats("site1", "2026-07-18");
    expect(s.receiving).toBe(false);
    expect(s.views).toBe(0);
  });
});

describe("SiteRegistry.remove", () => {
  it("deletes the site's registry row", async () => {
    const { client, sent } = fakeDb();
    await reg(client).remove("ID1");
    const del = sent.find((c) => c.name === "DeleteItemCommand")!;
    expect(del.input.Key.sk.S).toBe("site#ID1");
  });
});
