import { describe, expect, it, vi } from "vitest";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
  type ACMClient,
} from "@aws-sdk/client-acm";
import {
  deployEdge,
  edgeStackName,
  edgeStatusAll,
  listEdges,
  removeEdge,
  stackNameFor,
  updateEdge,
  type CertStore,
  type EdgeCtx,
} from "./edge";
import { edgeTemplateKey } from "./generated/backend-bundle";
import { TAG_APP } from "./tags";

// The delete path polls a real waiter; stub it so tests don't sleep.
vi.mock("@aws-sdk/client-cloudformation", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cloudformation")>(
    "@aws-sdk/client-cloudformation",
  );
  return { ...actual, waitUntilStackDeleteComplete: vi.fn(async () => ({ state: "SUCCESS" })) };
});

const attribution = { accountId: "111122223333", connectionId: "conn-1" };
const notFound = (name: string) =>
  Object.assign(new Error(`Stack with id ${name} does not exist`), { name: "ValidationError" });

function fakeCerts(seed: Record<string, string> = {}): CertStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>(Object.entries(seed));
  return {
    rows,
    list: async () => [...rows.entries()].map(([key, value]) => ({ key, value })),
    put: async (k, v) => void rows.set(k, v),
    del: async (k) => void rows.delete(k),
  };
}

/** Fake AWS: per-stack-name Describe answers; ACM answers per configured status. */
function fakeCtx(script: {
  stacks?: Record<string, Record<string, unknown>>;
  certSeed?: Record<string, string>;
  certStatus?: string;
  certRecord?: { Name: string; Type: string; Value: string };
}) {
  const sent: unknown[] = [];
  const cfn = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof DescribeStacksCommand) {
        const name = cmd.input.StackName ?? "";
        const stack = script.stacks?.[name];
        if (!stack) throw notFound(name);
        return { Stacks: [stack] };
      }
      return {};
    }),
  } as unknown as CloudFormationClient;
  const acm = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof RequestCertificateCommand) {
        return { CertificateArn: `arn:aws:acm:us-east-1:1:certificate/new-${cmd.input.DomainName}` };
      }
      if (cmd instanceof DescribeCertificateCommand) {
        return {
          Certificate: {
            Status: script.certStatus ?? "PENDING_VALIDATION",
            DomainValidationOptions: script.certRecord ? [{ ResourceRecord: script.certRecord }] : [],
          },
        };
      }
      return {};
    }),
  } as unknown as ACMClient;
  const certs = fakeCerts(script.certSeed);
  const ctx: EdgeCtx = { cfn, acm, certs, attribution };
  return { ctx, sent, certs };
}

const HOST = "abc.lambda-url.eu-west-1.on.aws";
const VIEWER = "vvv.lambda-url.eu-west-1.on.aws";
const ARN_A = "arn:aws:acm:us-east-1:1:certificate/abc";
/** A v2 record: domain|arn|stackName. */
const A = { "stats.example.com": `stats.example.com|${ARN_A}|${stackNameFor("stats.example.com")}` };

const readyStack = (domain: string, over: Record<string, unknown> = {}) => ({
  StackStatus: "UPDATE_COMPLETE",
  Parameters: [{ ParameterKey: "DomainName", ParameterValue: domain }],
  Outputs: [{ OutputKey: "DistributionDomain", OutputValue: "d111.cloudfront.net" }],
  Tags: [{ Key: "trafficpoppy:templateKey", Value: edgeTemplateKey }],
  ...over,
});

describe("the per-domain stack name", () => {
  it("is unique per domain and always under the granted TrafficPoppy* prefix", () => {
    expect(stackNameFor("stats.example.com")).toBe("TrafficPoppyEdge-stats-example-com");
    expect(stackNameFor("stats.example.com")).not.toBe(stackNameFor("stats.other.com"));
    expect(stackNameFor("x".repeat(300)).length).toBeLessThanOrEqual(128);
  });
});

describe("listEdges — the registry, with silent v1 migration", () => {
  it("migrates the legacy single-domain row: key becomes the domain, stack keeps v1's name", async () => {
    // v1 stored ONE row under the fixed key "truereach" with a 2-part value; its live
    // stack is named TrafficPoppyEdgeStack and must never be re-created under a new name.
    const { ctx, certs } = fakeCtx({ certSeed: { truereach: `stats.example.com|${ARN_A}` } });
    const edges = await listEdges(ctx);
    expect(edges).toEqual([{ domain: "stats.example.com", arn: ARN_A, stackName: edgeStackName }]);
    expect(certs.rows.has("truereach")).toBe(false);
    expect(certs.rows.get("stats.example.com")).toBe(`stats.example.com|${ARN_A}|${edgeStackName}`);
  });

  it("lists v2 rows sorted by domain", async () => {
    const { ctx } = fakeCtx({
      certSeed: {
        "stats.zzz.com": `stats.zzz.com|arn:z|${stackNameFor("stats.zzz.com")}`,
        ...A,
      },
    });
    expect((await listEdges(ctx)).map((e) => e.domain)).toEqual(["stats.example.com", "stats.zzz.com"]);
  });
});

describe("deployEdge — the sidecar requests the certificate ITSELF, born tagged", () => {
  it("calls RequestCertificate with the attribution tags IN the create call (I3)", async () => {
    const { ctx, sent, certs } = fakeCtx({});
    const r = await deployEdge(ctx, "Stats.Example.COM", HOST);
    expect(r.operation).toBe("REQUESTED_CERTIFICATE");
    const req = sent.find((c) => c instanceof RequestCertificateCommand) as RequestCertificateCommand;
    expect(req.input.DomainName).toBe("stats.example.com"); // normalized
    expect(req.input.ValidationMethod).toBe("DNS");
    expect((req.input.Tags ?? []).some((t) => t.Key === TAG_APP)).toBe(true);
    expect(req.input.IdempotencyToken).toMatch(/^[a-f0-9]{32}$/); // retry-safe
    expect(certs.rows.get("stats.example.com")).toBe(
      "stats.example.com|arn:aws:acm:us-east-1:1:certificate/new-stats.example.com|TrafficPoppyEdge-stats-example-com",
    );
  });

  it("is idempotent for the same domain — a re-click resumes, no duplicate certs", async () => {
    const { ctx, sent } = fakeCtx({ certSeed: A });
    expect((await deployEdge(ctx, "stats.example.com", HOST)).operation).toBe("RESUMED");
    expect(sent.find((c) => c instanceof RequestCertificateCommand)).toBeUndefined();
  });

  it("adding a SECOND domain leaves the first untouched", async () => {
    const { ctx, certs } = fakeCtx({ certSeed: A });
    const r = await deployEdge(ctx, "stats.other.com", HOST);
    expect(r.operation).toBe("REQUESTED_CERTIFICATE");
    expect(certs.rows.get("stats.example.com")).toBe(A["stats.example.com"]); // untouched
    expect(certs.rows.has("stats.other.com")).toBe(true);
  });

  it("rejects junk hostnames and a missing collector with a human sentence", async () => {
    const { ctx } = fakeCtx({});
    await expect(deployEdge(ctx, "not a host!", HOST)).rejects.toThrow(/hostname/i);
    await expect(deployEdge(ctx, "stats.x.com", "")).rejects.toThrow(/set up TrafficPoppy first/i);
  });
});

describe("edgeStatusAll — every domain's machine, driven independently by one poll", () => {
  it("reports an empty list when nothing exists", async () => {
    const { ctx } = fakeCtx({});
    expect(await edgeStatusAll(ctx, HOST)).toEqual([]);
  });

  it("surfaces the ACM validation CNAME while a certificate waits (phase: validating)", async () => {
    const { ctx } = fakeCtx({
      certSeed: A,
      certStatus: "PENDING_VALIDATION",
      certRecord: { Name: "_x1.stats.example.com.", Type: "CNAME", Value: "_y2.acm-validations.aws." },
    });
    const [s] = await edgeStatusAll(ctx, HOST);
    expect(s!.phase).toBe("validating");
    expect(s!.inProgress).toBe(true);
    expect(s!.records).toEqual([
      { purpose: "certificate-validation", name: "_x1.stats.example.com.", type: "CNAME", value: "_y2.acm-validations.aws." },
    ]);
  });

  it("ADVANCES once a cert is issued: creates THAT domain's stack with its own name", async () => {
    const { ctx, sent } = fakeCtx({ certSeed: A, certStatus: "ISSUED" });
    const [s] = await edgeStatusAll(ctx, HOST, VIEWER);
    expect(s!.phase).toBe("deploying");
    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    expect(create.input.StackName).toBe("TrafficPoppyEdge-stats-example-com");
    const params = Object.fromEntries((create.input.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params.DomainName).toBe("stats.example.com");
    expect(params.CollectorUrlHost).toBe(HOST);
    expect(params.CertificateArn).toBe(ARN_A);
    expect(params.ViewerUrlHost).toBe(VIEWER);
    expect((create.input.Tags ?? []).some((t) => t.Key === TAG_APP)).toBe(true);
  });

  it("once ready, hands over the pointing CNAME (stats.domain -> cloudfront)", async () => {
    const { ctx } = fakeCtx({
      certSeed: A,
      certStatus: "ISSUED",
      stacks: { [stackNameFor("stats.example.com")]: readyStack("stats.example.com") },
    });
    const [s] = await edgeStatusAll(ctx, HOST);
    expect(s!.phase).toBe("ready");
    expect(s!.records).toEqual([
      { purpose: "point-your-domain", name: "stats.example.com.", type: "CNAME", value: "d111.cloudfront.net" },
    ]);
  });

  it("keeps reporting even when the ACM read fails (best-effort detail, never masks state)", async () => {
    const { ctx } = fakeCtx({ certSeed: A });
    (ctx.acm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("AccessDenied"));
    const [s] = await edgeStatusAll(ctx, HOST);
    expect(s!.phase).toBe("deploying"); // cert exists; detail unavailable — still not gone
  });

  it("two domains report independently — one validating, one ready", async () => {
    const seed = {
      ...A,
      "stats.other.com": `stats.other.com|arn:o|${stackNameFor("stats.other.com")}`,
    };
    const { ctx } = fakeCtx({
      certSeed: seed,
      certStatus: "ISSUED",
      stacks: { [stackNameFor("stats.example.com")]: readyStack("stats.example.com") },
    });
    const [a, b] = await edgeStatusAll(ctx, HOST);
    expect(a!.domain).toBe("stats.example.com");
    expect(a!.phase).toBe("ready");
    expect(b!.domain).toBe("stats.other.com");
    expect(b!.phase).toBe("deploying"); // issued, stack advancing
  });
});

describe("the edge update — detected by the poll, applied only by the owner", () => {
  it("flags a ready stack that predates the viewer plane, but does NOT touch AWS", async () => {
    const { ctx, sent } = fakeCtx({
      certSeed: A,
      certStatus: "ISSUED",
      stacks: { [stackNameFor("stats.example.com")]: readyStack("stats.example.com") },
    });
    const [s] = await edgeStatusAll(ctx, HOST, VIEWER);
    expect(s!.phase).toBe("ready");
    expect(s!.updateAvailable).toBe(true);
    expect(s!.viewerAtEdge).toBeUndefined();
    expect(sent.some((c) => c instanceof CreateStackCommand)).toBe(false);
  });

  it("reports current + viewerAtEdge once the deployed parameters match", async () => {
    const { ctx } = fakeCtx({
      certSeed: A,
      certStatus: "ISSUED",
      stacks: {
        [stackNameFor("stats.example.com")]: readyStack("stats.example.com", {
          Parameters: [
            { ParameterKey: "DomainName", ParameterValue: "stats.example.com" },
            { ParameterKey: "ViewerUrlHost", ParameterValue: VIEWER },
          ],
        }),
      },
    });
    const [s] = await edgeStatusAll(ctx, HOST, VIEWER);
    expect(s!.updateAvailable).toBeUndefined();
    expect(s!.viewerAtEdge).toBe(true);
  });

  it("updateEdge re-deploys the SAME domain + certificate with the viewer origin added", async () => {
    const { ctx, sent } = fakeCtx({ certSeed: A, certStatus: "ISSUED" });
    (ctx.cfn.send as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof CreateStackCommand) throw new Error("Stack already exists");
      return {};
    });
    await updateEdge(ctx, "stats.example.com", HOST, VIEWER);
    const update = sent.find((c) => c instanceof UpdateStackCommand) as UpdateStackCommand;
    expect(update.input.StackName).toBe(stackNameFor("stats.example.com"));
    const params = Object.fromEntries((update.input.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params.CertificateArn).toBe(ARN_A);
    expect(params.ViewerUrlHost).toBe(VIEWER);
  });

  it("updateEdge refuses plainly when that domain was never set up", async () => {
    const { ctx } = fakeCtx({});
    await expect(updateEdge(ctx, "stats.nope.com", HOST, VIEWER)).rejects.toThrow(/isn't set up/);
  });
});

describe("removeEdge — one domain surgically, or everything for teardown; idempotent", () => {
  const TWO = {
    ...A,
    "stats.other.com": `stats.other.com|arn:o|${stackNameFor("stats.other.com")}`,
  };

  it("removes ONE domain's stack + cert + row, leaving the other domain alone", async () => {
    const { ctx, sent, certs } = fakeCtx({
      certSeed: TWO,
      stacks: { [stackNameFor("stats.example.com")]: readyStack("stats.example.com") },
    });
    const { removed } = await removeEdge(ctx, "stats.example.com");
    expect(removed).toEqual([stackNameFor("stats.example.com"), ARN_A]);
    expect(certs.rows.has("stats.example.com")).toBe(false);
    expect(certs.rows.has("stats.other.com")).toBe(true);
    const dels = sent.filter((c) => c instanceof DeleteCertificateCommand) as DeleteCertificateCommand[];
    expect(dels.map((d) => d.input.CertificateArn)).toEqual([ARN_A]);
  });

  it("with no domain given (teardown), sweeps EVERY domain", async () => {
    const { ctx, certs } = fakeCtx({
      certSeed: TWO,
      stacks: {
        [stackNameFor("stats.example.com")]: readyStack("stats.example.com"),
        [stackNameFor("stats.other.com")]: readyStack("stats.other.com"),
      },
    });
    const { removed } = await removeEdge(ctx);
    expect(removed).toContain(stackNameFor("stats.example.com"));
    expect(removed).toContain(stackNameFor("stats.other.com"));
    expect(certs.rows.size).toBe(0);
  });

  it("an already-deleted certificate is success, not an error", async () => {
    const { ctx } = fakeCtx({ certSeed: A });
    (ctx.acm.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }),
    );
    const { removed } = await removeEdge(ctx, "stats.example.com");
    expect(removed).toEqual([]); // no stack existed, cert already gone — clean exit
  });
});
