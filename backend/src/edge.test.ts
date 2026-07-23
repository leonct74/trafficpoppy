import { describe, expect, it, vi } from "vitest";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  type CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
  type ACMClient,
} from "@aws-sdk/client-acm";
import { deployEdge, edgeStatus, removeEdge, type CertStore, type EdgeCtx } from "./edge";
import { TAG_APP } from "./tags";

// The delete path polls a real waiter; stub it so tests don't sleep.
vi.mock("@aws-sdk/client-cloudformation", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cloudformation")>(
    "@aws-sdk/client-cloudformation",
  );
  return { ...actual, waitUntilStackDeleteComplete: vi.fn(async () => ({ state: "SUCCESS" })) };
});

const attribution = { accountId: "111122223333", connectionId: "conn-1" };
const notFound = Object.assign(new Error("Stack with id TrafficPoppyEdgeStack does not exist"), {
  name: "ValidationError",
});

function fakeCerts(seed?: string): CertStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>(seed ? [["truereach", seed]] : []);
  return {
    rows,
    get: async (d) => rows.get(d),
    put: async (d, v) => void rows.set(d, v),
    del: async (d) => void rows.delete(d),
  };
}

function fakeCtx(script: {
  stack?: Record<string, unknown> | null;
  certSeed?: string;
  certStatus?: string;
  certRecord?: { Name: string; Type: string; Value: string };
}) {
  const sent: unknown[] = [];
  const cfn = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof DescribeStacksCommand) {
        if (!script.stack) throw notFound;
        return { Stacks: [script.stack] };
      }
      return {};
    }),
  } as unknown as CloudFormationClient;
  const acm = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof RequestCertificateCommand) {
        return { CertificateArn: "arn:aws:acm:us-east-1:1:certificate/new" };
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
const SEED = "stats.example.com|arn:aws:acm:us-east-1:1:certificate/abc";

describe("deployEdge — the sidecar requests the certificate ITSELF, born tagged", () => {
  it("calls RequestCertificate with the attribution tags IN the create call (I3)", async () => {
    // CloudTrail-proven: CloudFormation's ACM handler creates untagged, which the broker's
    // birth-tag rule rightly denies — so the cert must be requested here, tags attached.
    const { ctx, sent, certs } = fakeCtx({ stack: null });
    const r = await deployEdge(ctx, "Stats.Example.COM", HOST);
    expect(r.operation).toBe("REQUESTED_CERTIFICATE");
    const req = sent.find((c) => c instanceof RequestCertificateCommand) as RequestCertificateCommand;
    expect(req.input.DomainName).toBe("stats.example.com"); // normalized
    expect(req.input.ValidationMethod).toBe("DNS");
    expect((req.input.Tags ?? []).some((t) => t.Key === TAG_APP)).toBe(true);
    expect(req.input.IdempotencyToken).toMatch(/^[a-f0-9]{32}$/); // retry-safe
    expect(certs.rows.get("truereach")).toBe("stats.example.com|arn:aws:acm:us-east-1:1:certificate/new");
  });

  it("is idempotent for the same domain — a re-click resumes, no duplicate certs", async () => {
    const { ctx, sent } = fakeCtx({ stack: null, certSeed: SEED });
    expect((await deployEdge(ctx, "stats.example.com", HOST)).operation).toBe("RESUMED");
    expect(sent.find((c) => c instanceof RequestCertificateCommand)).toBeUndefined();
  });

  it("rejects junk hostnames and a missing collector with a human sentence", async () => {
    const { ctx } = fakeCtx({ stack: null });
    await expect(deployEdge(ctx, "not a host!", HOST)).rejects.toThrow(/hostname/i);
    await expect(deployEdge(ctx, "stats.x.com", "")).rejects.toThrow(/set up TrafficPoppy first/i);
  });
});

describe("edgeStatus — re-derived from AWS each poll, and where the machine advances", () => {
  it("reports none when nothing exists", async () => {
    const { ctx } = fakeCtx({ stack: null });
    expect((await edgeStatus(ctx, HOST)).phase).toBe("none");
  });

  it("surfaces the ACM validation CNAME while the certificate waits (phase: validating)", async () => {
    const { ctx } = fakeCtx({
      stack: null,
      certSeed: SEED,
      certStatus: "PENDING_VALIDATION",
      certRecord: { Name: "_x1.stats.example.com.", Type: "CNAME", Value: "_y2.acm-validations.aws." },
    });
    const s = await edgeStatus(ctx, HOST);
    expect(s.phase).toBe("validating");
    expect(s.inProgress).toBe(true);
    expect(s.records).toEqual([
      { purpose: "certificate-validation", name: "_x1.stats.example.com.", type: "CNAME", value: "_y2.acm-validations.aws." },
    ]);
  });

  it("ADVANCES once the cert is issued: creates the distribution stack with the cert ARN", async () => {
    const { ctx, sent } = fakeCtx({ stack: null, certSeed: SEED, certStatus: "ISSUED" });
    const s = await edgeStatus(ctx, HOST);
    expect(s.phase).toBe("deploying");
    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    const params = Object.fromEntries((create.input.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params.DomainName).toBe("stats.example.com");
    expect(params.CollectorUrlHost).toBe(HOST);
    expect(params.CertificateArn).toBe("arn:aws:acm:us-east-1:1:certificate/abc");
    expect((create.input.Tags ?? []).some((t) => t.Key === TAG_APP)).toBe(true);
  });

  it("once ready, hands over the pointing CNAME (stats.domain -> cloudfront)", async () => {
    const { ctx } = fakeCtx({
      certSeed: SEED,
      certStatus: "ISSUED",
      stack: {
        StackStatus: "CREATE_COMPLETE",
        Parameters: [{ ParameterKey: "DomainName", ParameterValue: "stats.example.com" }],
        Outputs: [{ OutputKey: "DistributionDomain", OutputValue: "d111.cloudfront.net" }],
      },
    });
    const s = await edgeStatus(ctx, HOST);
    expect(s.phase).toBe("ready");
    expect(s.records).toEqual([
      { purpose: "point-your-domain", name: "stats.example.com.", type: "CNAME", value: "d111.cloudfront.net" },
    ]);
  });

  it("keeps reporting even when the ACM read fails (best-effort detail, never masks state)", async () => {
    const { ctx } = fakeCtx({ stack: null, certSeed: SEED });
    (ctx.acm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("AccessDenied"));
    const s = await edgeStatus(ctx, HOST);
    expect(s.phase).toBe("deploying"); // cert exists; detail unavailable — still not "none"
  });
});

describe("removeEdge — distribution first, then the certificate; idempotent", () => {
  it("deletes stack then cert then the stored row", async () => {
    const { ctx, sent, certs } = fakeCtx({ stack: { StackStatus: "CREATE_COMPLETE" }, certSeed: SEED });
    const r = await removeEdge(ctx);
    expect(r.removed).toEqual(["TrafficPoppyEdgeStack", "arn:aws:acm:us-east-1:1:certificate/abc"]);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
    expect(sent.find((c) => c instanceof DeleteCertificateCommand)).toBeDefined();
    expect(certs.rows.size).toBe(0);
  });

  it("treats already-gone as success", async () => {
    const { ctx, sent } = fakeCtx({ stack: null });
    expect((await removeEdge(ctx)).removed).toEqual([]);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeUndefined();
  });
});
