// TrafficPoppy backend sidecar — the HTTP surface the host proxies frontend calls to,
// plus the teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on
// the injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §2.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  LambdaClient,
  AddPermissionCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  DeleteFunctionUrlConfigCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  RemovePermissionCommand,
  TagResourceCommand,
} from "@aws-sdk/client-lambda";
import { probeZipBase64 } from "./generated/backend-bundle";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import { deploy, getStatus, teardown, tableName, type AwsCtx } from "./stack";
import { SiteRegistry, lastDays } from "./sites";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const region = boot.account.region;
const aws: AwsCtx = {
  cfn: new CloudFormationClient({ region, credentials }),
  s3: new S3Client({ region, credentials }),
  region,
  accountId: boot.account.accountId,
};
const sites = new SiteRegistry(new DynamoDBClient({ region, credentials }), tableName);
const lambda = new LambdaClient({ region, credentials });
/** The current UTC day (YYYY-MM-DD) — the key the dashboard reads. */
const today = () => new Date().toISOString().slice(0, 10);
/** Attribution for the stack (who created it) — separate from the AWS client context. */
const attribution = { accountId: boot.account.accountId, connectionId: boot.connectionId };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** One calm sentence for the UI — never a raw stack trace (AGENTS.md §9). */
function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && (parts.length === 0 || parts[0] === "health")) return json(res, 200, { ok: true });
    if (method === "GET" && parts[0] === "meta") {
      return json(res, 200, { account: boot.account, connectionId: boot.connectionId });
    }

    // The live deployment state, read from CloudFormation on every call. The frontend
    // holds no memory of a deploy; this is what it mounts against and polls.
    if (method === "GET" && parts[0] === "status" && parts.length === 1) {
      const status = await getStatus(aws);
      // Prefer the LIVE Function URL over the stack output: a repair recreates the URL
      // out-of-band, and snippets must always carry the address that actually serves.
      if (status.phase === "ready") {
        try {
          const live = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: "TrafficPoppyCollector" }));
          if (live.FunctionUrl) status.collectorUrl = live.FunctionUrl;
        } catch {
          /* keep the stack output */
        }
      }
      return json(res, 200, status);
    }

    // Start (or update) the deploy. Returns as soon as AWS accepts it — the work carries
    // on in the background whatever the UI does.
    if (method === "POST" && parts[0] === "deploy" && parts.length === 1) {
      return json(res, 200, await deploy(aws, attribution));
    }

    // Sites: the owner's site registry, stored in their own table.
    if (parts[0] === "sites") {
      if (method === "GET" && parts.length === 1) return json(res, 200, { sites: await sites.list() });
      if (method === "POST" && parts.length === 1) {
        const body = (await readBody(req)) as { name?: string; domain?: string } | undefined;
        const site = await sites.create({ name: body?.name ?? "", domain: body?.domain ?? "" });
        return json(res, 200, { site });
      }
      if (parts.length >= 2) {
        const id = decodeURIComponent(parts[1]!);
        if (method === "GET" && parts[2] === "stats") {
          const day = url.searchParams.get("day") ?? today();
          return json(res, 200, { stats: await sites.stats(id, day) });
        }
        // The dashboard's range read: ?days=1|7|30 (clamped — each day is one Query).
        // Always carries the PREVIOUS same-length window too (Δ% chips + top movers).
        if (method === "GET" && parts[2] === "range") {
          const n = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? "7") || 7));
          const both = lastDays(n * 2, today());
          return json(res, 200, { range: await sites.rangeStats(id, both.slice(n), both.slice(0, n)) });
        }
        // The live "last 30 minutes" ticker.
        if (method === "GET" && parts[2] === "live") {
          return json(res, 200, { live: await sites.live(id, new Date()) });
        }
        if (method === "DELETE" && parts.length === 2) {
          await sites.remove(id);
          return json(res, 200, { ok: true });
        }
      }
    }

    // Read-only diagnostic: the collector's DEPLOYED Function URL auth config + resource
    // policy, so we can see why public requests are being refused. GetPolicy may not be
    // granted; report it as unavailable rather than failing the whole check.
    if (method === "GET" && parts[0] === "debug" && parts[1] === "collector") {
      const fn = "TrafficPoppyCollector";
      const urlCfg = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: fn }));
      let policy: unknown = "unavailable";
      try {
        const p = await lambda.send(new GetPolicyCommand({ FunctionName: fn }));
        policy = p.Policy ? JSON.parse(p.Policy) : "empty";
      } catch (e) {
        policy = `unavailable: ${(e as Error).name}`;
      }
      let fnState: unknown = "unavailable";
      try {
        const f = await lambda.send(new GetFunctionCommand({ FunctionName: fn }));
        fnState = {
          State: f.Configuration?.State,
          StateReason: f.Configuration?.StateReason,
          LastUpdateStatus: f.Configuration?.LastUpdateStatus,
          LastUpdateStatusReason: f.Configuration?.LastUpdateStatusReason,
          Runtime: f.Configuration?.Runtime,
          Handler: f.Configuration?.Handler,
        };
      } catch (e) {
        fnState = `unavailable: ${(e as Error).name}`;
      }
      return json(res, 200, {
        authType: urlCfg.AuthType,
        cors: urlCfg.Cors,
        functionUrl: urlCfg.FunctionUrl,
        function: fnState,
        policy,
      });
    }

    // Repair actions for the stuck-public-URL condition (edge refuses anonymous invokes
    // despite a correct NONE config + allow-everyone policy). Both recreate state OUT-OF-
    // BAND from CloudFormation — the working theory is that CFN-created registrations are
    // what's broken. Founder-triggered during live debugging; not exposed in the UI.
    const CORS_CFG = {
      AllowOrigins: ["*"],
      AllowMethods: ["GET", "POST"],
      AllowHeaders: ["content-type"],
      MaxAge: 86400,
    };
    if (method === "POST" && parts[0] === "repair" && parts[1] === "url") {
      const fn = "TrafficPoppyCollector";
      try {
        await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: fn }));
      } catch {
        /* already gone is fine */
      }
      const created = await lambda.send(
        new CreateFunctionUrlConfigCommand({ FunctionName: fn, AuthType: "NONE", Cors: CORS_CFG }),
      );
      return json(res, 200, { ok: true, functionUrl: created.FunctionUrl });
    }
    if (method === "POST" && parts[0] === "repair" && parts[1] === "permission") {
      const fn = "TrafficPoppyCollector";
      // Drop every existing statement, then write a fresh canonical public-invoke one.
      try {
        const p = await lambda.send(new GetPolicyCommand({ FunctionName: fn }));
        const sids: string[] = p.Policy ? JSON.parse(p.Policy).Statement.map((s: { Sid: string }) => s.Sid) : [];
        for (const sid of sids) {
          await lambda.send(new RemovePermissionCommand({ FunctionName: fn, StatementId: sid }));
        }
      } catch {
        /* no policy yet is fine */
      }
      // Since October 2025 a public Function URL needs BOTH statements (docs: urls-auth):
      // InvokeFunctionUrl (auth-type-NONE-gated) AND InvokeFunction (gated to calls made
      // via the URL). The console adds both automatically; CFN/API users must. Missing the
      // second one yields exactly a 403 "even if the function URL uses the NONE auth type".
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: fn,
          StatementId: "TrafficPoppyPublicUrl",
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        }),
      );
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: fn,
          StatementId: "TrafficPoppyPublicUrlInvoke",
          Action: "lambda:InvokeFunction",
          Principal: "*",
          InvokedViaFunctionUrl: true,
        }),
      );
      return json(res, 200, { ok: true });
    }

    // Probe: a minimal broker-created hello-function to bisect the public-URL 403.
    // Same shape as a console-made hello-world; created via the SAME brokered creds as
    // the collector; initially UNTAGGED. /probe/tag then adds the agentspoppy tags so we
    // can observe whether tagging flips its URL from 200 to 403. /probe/delete cleans up
    // (it must never outlive the debugging session — leaves-no-trace).
    const PROBE = "TrafficPoppyProbe";
    if (method === "POST" && parts[0] === "probe" && parts[1] === "create") {
      const roleArn = `arn:aws:iam::${boot.account.accountId}:role/TrafficPoppyCollectorRole`;
      await lambda.send(
        new CreateFunctionCommand({
          FunctionName: PROBE,
          Runtime: "nodejs20.x",
          Handler: "probe.handler",
          Role: roleArn,
          Code: { ZipFile: Buffer.from(probeZipBase64, "base64") },
          Timeout: 5,
          MemorySize: 128,
        }),
      );
      // Wait for Active before attaching the URL (mirrors what the console does).
      for (let i = 0; i < 15; i++) {
        const f = await lambda.send(new GetFunctionCommand({ FunctionName: PROBE }));
        if (f.Configuration?.State === "Active") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const url = await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: PROBE, AuthType: "NONE" }));
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: PROBE,
          StatementId: "ProbePublic",
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        }),
      );
      return json(res, 200, { ok: true, functionUrl: url.FunctionUrl });
    }
    if (method === "POST" && parts[0] === "probe" && parts[1] === "tag") {
      await lambda.send(
        new TagResourceCommand({
          Resource: `arn:aws:lambda:${region}:${boot.account.accountId}:function:${PROBE}`,
          Tags: {
            "agentspoppy:account": boot.account.accountId,
            "agentspoppy:app": "com.trafficpoppy.desktop",
            "agentspoppy:connection": boot.connectionId,
          },
        }),
      );
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && parts[0] === "probe" && parts[1] === "delete") {
      try {
        await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: PROBE }));
      } catch {
        /* already gone */
      }
      try {
        await lambda.send(new DeleteFunctionCommand({ FunctionName: PROBE }));
      } catch {
        /* already gone */
      }
      return json(res, 200, { ok: true });
    }

    // The teardown hook the host POSTs at the start of teardown. MUST be idempotent.
    if (method === "POST" && parts[0] === "teardown" && parts.length === 1) {
      return json(res, 200, { ok: true, ...(await teardown(aws)) });
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    return json(res, 500, { error: errorMessage(e) });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[trafficpoppy] backend listening on 127.0.0.1:${actual} (region ${boot.account.region})`);
});
