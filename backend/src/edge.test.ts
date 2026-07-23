import { describe, expect, it, vi } from "vitest";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import { DescribeCertificateCommand, type ACMClient } from "@aws-sdk/client-acm";
import { deployEdge, edgeStatus, removeEdge, type EdgeCtx } from "./edge";
import { TAG_APP } from "./tags";

const attribution = { accountId: "111122223333", connectionId: "conn-1" };
const notFound = Object.assign(new Error("Stack with id TrafficPoppyEdgeStack does not exist"), {
  name: "ValidationError",
});

function fakeCtx(script: {
  stack?: Record<string, unknown> | Error | null;
  certStatus?: string;
  certRecord?: { Name: string; Type: string; Value: string };
}) {
  const sent: unknown[] = [];
  const cfn = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof DescribeStacksCommand) {
        if (script.stack instanceof Error) throw script.stack;
        if (!script.stack) throw notFound;
        return { Stacks: [script.stack] };
      }
      if (cmd instanceof DescribeStackResourcesCommand) {
        return {
          StackResources: [
            { LogicalResourceId: "Certificate", PhysicalResourceId: "arn:aws:acm:us-east-1:1:certificate/abc" },
          ],
        };
      }
      return {};
    }),
  } as unknown as CloudFormationClient;
  const acm = {
    send: vi.fn(async (cmd: unknown) => {
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
  return { ctx: { cfn, acm } as EdgeCtx, sent };
}

describe("deployEdge", () => {
  it("creates the stack with the domain, the collector origin host, and attribution tags", async () => {
    const { ctx, sent } = fakeCtx({ stack: null });
    const r = await deployEdge(ctx, "Stats.Example.COM", "abc.lambda-url.eu-west-1.on.aws", attribution);
    expect(r.operation).toBe("CREATE");
    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    const params = Object.fromEntries((create.input.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params.DomainName).toBe("stats.example.com"); // normalized
    expect(params.CollectorUrlHost).toBe("abc.lambda-url.eu-west-1.on.aws");
    expect((create.input.Tags ?? []).some((t) => t.Key === TAG_APP)).toBe(true); // tagged-as-self depends on this
  });

  it("rejects junk hostnames and a missing collector with a human sentence", async () => {
    const { ctx } = fakeCtx({ stack: null });
    await expect(deployEdge(ctx, "not a host!", "h", attribution)).rejects.toThrow(/hostname/i);
    await expect(deployEdge(ctx, "stats.x.com", "", attribution)).rejects.toThrow(/set up TrafficPoppy first/i);
  });
});

describe("edgeStatus — everything the owner needs, re-derived from AWS on every poll", () => {
  it("reports none when no True Reach deployment exists", async () => {
    const { ctx } = fakeCtx({ stack: null });
    expect((await edgeStatus(ctx)).phase).toBe("none");
  });

  it("surfaces the ACM validation CNAME while the certificate waits (phase: validating)", async () => {
    const { ctx } = fakeCtx({
      stack: {
        StackStatus: "CREATE_IN_PROGRESS",
        Parameters: [{ ParameterKey: "DomainName", ParameterValue: "stats.example.com" }],
      },
      certStatus: "PENDING_VALIDATION",
      certRecord: { Name: "_x1.stats.example.com.", Type: "CNAME", Value: "_y2.acm-validations.aws." },
    });
    const s = await edgeStatus(ctx);
    expect(s.phase).toBe("validating");
    expect(s.records).toEqual([
      {
        purpose: "certificate-validation",
        name: "_x1.stats.example.com.",
        type: "CNAME",
        value: "_y2.acm-validations.aws.",
      },
    ]);
  });

  it("once ready, hands over the pointing CNAME (stats.domain -> cloudfront)", async () => {
    const { ctx } = fakeCtx({
      stack: {
        StackStatus: "CREATE_COMPLETE",
        Parameters: [{ ParameterKey: "DomainName", ParameterValue: "stats.example.com" }],
        Outputs: [{ OutputKey: "DistributionDomain", OutputValue: "d111.cloudfront.net" }],
      },
      certStatus: "ISSUED",
    });
    const s = await edgeStatus(ctx);
    expect(s.phase).toBe("ready");
    expect(s.records).toEqual([
      { purpose: "point-your-domain", name: "stats.example.com.", type: "CNAME", value: "d111.cloudfront.net" },
    ]);
    expect(s.distributionDomain).toBe("d111.cloudfront.net");
  });

  it("keeps reporting even when the ACM read fails (best-effort detail, never masks state)", async () => {
    const { ctx } = fakeCtx({ stack: { StackStatus: "CREATE_IN_PROGRESS" } });
    (ctx.acm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("AccessDenied"));
    const s = await edgeStatus(ctx);
    expect(s.phase).toBe("deploying");
    expect(s.inProgress).toBe(true);
  });
});

describe("removeEdge — idempotent, never touches the core stack", () => {
  it("deletes an existing edge stack", async () => {
    const { ctx, sent } = fakeCtx({ stack: { StackStatus: "CREATE_COMPLETE" } });
    expect((await removeEdge(ctx)).removed).toBe(true);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
  });

  it("treats already-gone as success", async () => {
    const { ctx, sent } = fakeCtx({ stack: null });
    expect((await removeEdge(ctx)).removed).toBe(false);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeUndefined();
  });
});
