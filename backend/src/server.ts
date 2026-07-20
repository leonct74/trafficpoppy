// TrafficPoppy backend sidecar — the HTTP surface the host proxies frontend calls to,
// plus the teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on
// the injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §2.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import { deploy, getStatus, teardown, tableName, type AwsCtx } from "./stack";
import { SiteRegistry } from "./sites";

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
      return json(res, 200, await getStatus(aws));
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
        if (method === "DELETE" && parts.length === 2) {
          await sites.remove(id);
          return json(res, 200, { ok: true });
        }
      }
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
