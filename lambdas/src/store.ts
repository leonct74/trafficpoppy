// The collector's DynamoDB access, behind a small interface so the ingest orchestration
// (ingest.ts) is unit-testable against a fake. All keys follow the single-table design in
// DESIGN.md §2. This module is the ONLY place in the collector that talks to AWS.

import {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { CounterKey } from "./core";

export interface Store {
  /** The rotating salt for a window key (a day, or w#<days>#<n>), or undefined if unset. */
  getSalt(windowKey: string): Promise<string | undefined>;
  /** Set a window's salt only if absent (so concurrent Lambdas don't clobber). */
  putSaltIfAbsent(windowKey: string, salt: string, expiresAt: number): Promise<void>;
  /** Atomic ADD 1 to total#views; returns the new count (for the daily cap). */
  bumpViews(pk: string): Promise<number>;
  /** Atomic ADD 1 to each counter row. */
  bumpCounters(keys: CounterKey[]): Promise<void>;
  /** Conditional put of a unique's daily-hash row; true iff newly inserted (first seen today). */
  putUniqueIfNew(pk: string, hash: string, expiresAt: number): Promise<boolean>;
  /**
   * The owner's salt-window choice for a site (§6b baseline), read off the site's registry
   * row. Undefined when unset or the site doesn't exist — the caller defaults to 1 day.
   */
  getSiteSaltDays(siteId: string): Promise<number | undefined>;
}

/** Thrown-name DynamoDB uses when a conditional write's condition isn't met. */
const CONDITION_FAILED = "ConditionalCheckFailedException";

export class DynamoStore implements Store {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly tableName: string,
  ) {}

  async getSalt(windowKey: string): Promise<string | undefined> {
    const out = await this.db.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: "salt" }, sk: { S: windowKey } },
        ProjectionExpression: "saltValue",
      }),
    );
    return out.Item?.saltValue?.S;
  }

  async putSaltIfAbsent(windowKey: string, salt: string, expiresAt: number): Promise<void> {
    try {
      await this.db.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            pk: { S: "salt" },
            sk: { S: windowKey },
            saltValue: { S: salt },
            expiresAt: { N: String(expiresAt) },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (e) {
      // Another Lambda set it first — fine, we'll read theirs.
      if ((e as { name?: string }).name !== CONDITION_FAILED) throw e;
    }
  }

  async getSiteSaltDays(siteId: string): Promise<number | undefined> {
    const out = await this.db.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: "sites" }, sk: { S: `site#${siteId}` } },
        ProjectionExpression: "saltDays",
      }),
    );
    const n = Number(out.Item?.saltDays?.N);
    return Number.isFinite(n) && n >= 1 ? n : undefined;
  }

  async bumpViews(pk: string): Promise<number> {
    const out = await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: pk }, sk: { S: "total#views" } },
        UpdateExpression: "ADD #c :one",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":one": { N: "1" } },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(out.Attributes?.count?.N ?? "0");
  }

  async bumpCounters(keys: CounterKey[]): Promise<void> {
    await Promise.all(
      keys.map((k) =>
        this.db.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: { pk: { S: k.pk }, sk: { S: k.sk } },
            // Short-lived rows (the live ticker's minute buckets) also carry their TTL.
            UpdateExpression: k.expiresAt ? "ADD #c :one SET expiresAt = :x" : "ADD #c :one",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: {
              ":one": { N: "1" },
              ...(k.expiresAt ? { ":x": { N: String(k.expiresAt) } } : {}),
            },
          }),
        ),
      ),
    );
  }

  async putUniqueIfNew(pk: string, hash: string, expiresAt: number): Promise<boolean> {
    try {
      await this.db.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: { pk: { S: pk }, sk: { S: hash }, expiresAt: { N: String(expiresAt) } },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === CONDITION_FAILED) return false; // already seen today
      throw e;
    }
  }
}
