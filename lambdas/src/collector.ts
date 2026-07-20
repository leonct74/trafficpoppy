// The collector Lambda: one handler behind a Function URL that both serves t.js and
// ingests events (DESIGN.md §2 — no API Gateway). Payload format 2.0.
//
// The event-handling logic is split from the AWS wiring: handleEvent() takes an injected
// Store + deps and is unit-tested; the exported `handler` builds the real DynamoStore once
// per cold start and delegates to it.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { isDoNotTrack, normalize, type RawEvent } from "./core";
import { ingest, type IngestDeps } from "./ingest";
import { DynamoStore, type Store } from "./store";
import { trackerHeaders, trackerScript } from "./tracker";

/** The slice of a Lambda Function URL (payload v2) request we use. */
interface FunctionUrlEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string; sourceIp?: string; userAgent?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

/** CORS: t.js POSTs from the owner's own site (cross-origin). Opaque, so `*` is correct. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const noContent = (): LambdaResponse => ({ statusCode: 204, headers: { ...CORS } });

/** Reconstruct the origin the request arrived on — where t.js should POST back. */
function originOf(event: FunctionUrlEvent): string {
  const host = event.headers?.["host"] ?? event.headers?.["Host"] ?? "";
  const proto = event.headers?.["x-forwarded-proto"] ?? "https";
  return host ? `${proto}://${host}` : "";
}

function readBody(event: FunctionUrlEvent): RawEvent {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as RawEvent) : {};
  } catch {
    return {};
  }
}

export interface HandlerDeps extends Omit<IngestDeps, "store"> {
  store: Store;
}

/**
 * The pure(ish) request handler: route, serve t.js, or ingest an event. Never leaks whether
 * a hit was counted, capped, or opted-out — every ingest answer is a bare 204, so the
 * public endpoint gives an abuser nothing to probe. Errors are swallowed to 204 too: a
 * collector must never turn a visitor's page into a console error.
 */
export async function handleEvent(event: FunctionUrlEvent, deps: HandlerDeps): Promise<LambdaResponse> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  if (method === "OPTIONS") return noContent();

  if (method === "GET" && (path === "/t.js" || path === "/t.js/")) {
    return { statusCode: 200, headers: { ...trackerHeaders(), ...CORS }, body: trackerScript(originOf(event)) };
  }

  if (method === "POST" && (path === "/e" || path === "/e/")) {
    try {
      const headers = event.headers ?? {};
      const ev = normalize(readBody(event), {
        userAgent: headers["user-agent"] ?? event.requestContext?.http?.userAgent,
        doNotTrack: isDoNotTrack(headers),
      });
      if (ev) {
        const ip = event.requestContext?.http?.sourceIp ?? "";
        const ua = headers["user-agent"] ?? event.requestContext?.http?.userAgent ?? "";
        await ingest(ev, ip, ua, deps);
      }
    } catch {
      /* never surface collector errors to the visitor's page */
    }
    return noContent();
  }

  return { statusCode: 404, headers: { ...CORS }, body: "" };
}

// --- real AWS wiring (built once per cold start) ------------------------------------------

let cachedStore: Store | null = null;
function store(): Store {
  if (cachedStore) return cachedStore;
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME env is not set");
  cachedStore = new DynamoStore(new DynamoDBClient({}), tableName);
  return cachedStore;
}

const DEFAULT_DAILY_CAP = 100_000;

export async function handler(event: FunctionUrlEvent): Promise<LambdaResponse> {
  const deps: HandlerDeps = {
    store: store(),
    now: () => new Date(),
    freshSalt: () => randomBytes(16).toString("hex"),
    dailyCap: Number(process.env.DAILY_CAP ?? DEFAULT_DAILY_CAP) || DEFAULT_DAILY_CAP,
  };
  return handleEvent(event, deps);
}
