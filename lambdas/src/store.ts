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
  /** The day's rotating salt, or undefined if not set yet. */
  getSalt(day: string): Promise<string | undefined>;
  /** Set the day's salt only if absent (so concurrent Lambdas don't clobber). */
  putSaltIfAbsent(day: string, salt: string, expiresAt: number): Promise<void>;
  /** Atomic ADD 1 to total#views; returns the new count (for the daily cap). */
  bumpViews(pk: string): Promise<number>;
  /** Atomic ADD 1 to each counter row. */
  bumpCounters(keys: CounterKey[]): Promise<void>;
  /** Conditional put of a unique's daily-hash row; true iff newly inserted (first seen today). */
  putUniqueIfNew(pk: string, hash: string, expiresAt: number): Promise<boolean>;
}

/** Thrown-name DynamoDB uses when a conditional write's condition isn't met. */
const CONDITION_FAILED = "ConditionalCheckFailedException";

export class DynamoStore implements Store {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly tableName: string,
  ) {}

  async getSalt(day: string): Promise<string | undefined> {
    const out = await this.db.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: "salt" }, sk: { S: day } },
        ProjectionExpression: "saltValue",
      }),
    );
    return out.Item?.saltValue?.S;
  }

  async putSaltIfAbsent(day: string, salt: string, expiresAt: number): Promise<void> {
    try {
      await this.db.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            pk: { S: "salt" },
            sk: { S: day },
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
            UpdateExpression: "ADD #c :one",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: { ":one": { N: "1" } },
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
