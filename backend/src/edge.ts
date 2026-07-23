// The True Reach edge-stack lifecycle (DESIGN.md §12, §14 P5 decisions): deploy the
// us-east-1 ACM+CloudFront stack, report its state INCLUDING the DNS records the owner
// must add (background + resumable: the UI re-derives everything from AWS on every poll),
// and remove it. Clients injected — unit-testable like stack.ts.

import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { DescribeCertificateCommand, type ACMClient } from "@aws-sdk/client-acm";
import { edgeStackName, edgeTemplateJson, edgeTemplateKey, sourceCommit } from "./generated/backend-bundle";
import { stackTags, type AttributionContext } from "./tags";
import { TEMPLATE_KEY_TAG } from "./stack";

export { edgeStackName };

/** Everything the edge lifecycle needs — us-east-1 clients (CloudFront's cert region). */
export interface EdgeCtx {
  cfn: CloudFormationClient;
  acm: ACMClient;
}

export type EdgePhase =
  | "none" // no True Reach deployment
  | "validating" // stack up to the cert, waiting for the owner's validation CNAME
  | "deploying" // cert issued; CloudFront distribution rolling out (minutes)
  | "ready"
  | "removing"
  | "failed";

/** A DNS record the owner must create at their DNS host (shown with a copy button). */
export interface DnsRecord {
  purpose: "certificate-validation" | "point-your-domain";
  name: string;
  type: string;
  value: string;
}

export interface EdgeStatus {
  phase: EdgePhase;
  stackStatus?: string;
  /** The custom collector hostname (stats.<domain>), once known. */
  domain?: string;
  /** Records the owner still needs to create — empty when everything is verified. */
  records: DnsRecord[];
  /** The distribution's *.cloudfront.net hostname (the CNAME target), once created. */
  distributionDomain?: string;
  inProgress: boolean;
  failureReason?: string;
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

async function describe(cfn: CloudFormationClient): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: edgeStackName }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Deploy (or update) the edge stack. Returns immediately — ACM will hold the stack
 * IN_PROGRESS until the owner adds the validation CNAME, and that's fine: the status
 * read below surfaces the record and the UI polls (AGENTS.md §5).
 */
export async function deployEdge(
  ctx: EdgeCtx,
  domain: string,
  collectorUrlHost: string,
  attribution: AttributionContext,
): Promise<{ operation: "CREATE" | "UPDATE" | "NO_CHANGE" }> {
  const cleaned = domain.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleaned)) {
    throw new Error("That doesn't look like a hostname — try something like stats.your-domain.com.");
  }
  if (!collectorUrlHost) {
    throw new Error("The collector isn't deployed yet — set up TrafficPoppy first.");
  }
  const args = {
    StackName: edgeStackName,
    TemplateBody: edgeTemplateJson,
    Parameters: [
      { ParameterKey: "DomainName", ParameterValue: cleaned },
      { ParameterKey: "CollectorUrlHost", ParameterValue: collectorUrlHost },
    ],
    Tags: [
      ...stackTags({ ...attribution, sourceCommit: sourceCommit || undefined }),
      { Key: TEMPLATE_KEY_TAG, Value: edgeTemplateKey },
    ],
  };
  const existing = await describe(ctx.cfn);
  // A failed create leaves ROLLBACK_COMPLETE, which can't be updated — delete + recreate
  // (the same rule stack.ts follows for the core stack).
  if (existing?.StackStatus === "ROLLBACK_COMPLETE") {
    await ctx.cfn.send(new DeleteStackCommand({ StackName: edgeStackName }));
    await waitUntilStackDeleteComplete({ client: ctx.cfn, maxWaitTime: 600 }, { StackName: edgeStackName });
    await ctx.cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE" };
  }
  if (!existing) {
    await ctx.cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE" };
  }
  try {
    await ctx.cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE" };
  } catch (e) {
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) return { operation: "NO_CHANGE" };
    throw e;
  }
}

/** The live edge state + whatever DNS work is still the owner's, straight from AWS. */
export async function edgeStatus(ctx: EdgeCtx): Promise<EdgeStatus> {
  const stack = await describe(ctx.cfn);
  if (!stack) return { phase: "none", records: [], inProgress: false };

  const stackStatus = stack.StackStatus ?? "";
  const domain = stack.Parameters?.find((p) => p.ParameterKey === "DomainName")?.ParameterValue;
  const distributionDomain = stack.Outputs?.find((o) => o.OutputKey === "DistributionDomain")?.OutputValue;
  const records: DnsRecord[] = [];

  // While the certificate awaits validation, surface the CNAME ACM wants. Best-effort:
  // a hiccup here must never hide the deployment state itself.
  let certPending = false;
  try {
    const resources = await ctx.cfn.send(new DescribeStackResourcesCommand({ StackName: edgeStackName }));
    const certArn = resources.StackResources?.find((r) => r.LogicalResourceId === "Certificate")
      ?.PhysicalResourceId;
    if (certArn?.startsWith("arn:")) {
      const cert = await ctx.acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }));
      certPending = cert.Certificate?.Status === "PENDING_VALIDATION";
      const rr = cert.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
      if (certPending && rr?.Name && rr.Value) {
        records.push({ purpose: "certificate-validation", name: rr.Name, type: rr.Type ?? "CNAME", value: rr.Value });
      }
    }
  } catch {
    /* keep going with what CloudFormation told us */
  }

  // The pointing record: only actionable once the distribution exists (outputs present).
  if (domain && distributionDomain) {
    records.push({ purpose: "point-your-domain", name: `${domain}.`, type: "CNAME", value: distributionDomain });
  }

  const inProgress = /_IN_PROGRESS$/.test(stackStatus);
  let phase: EdgePhase;
  if (stackStatus.startsWith("DELETE") && inProgress) phase = "removing";
  else if (/(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/.test(stackStatus)) phase = "failed";
  else if (stackStatus === "CREATE_COMPLETE" || stackStatus === "UPDATE_COMPLETE") phase = "ready";
  else if (certPending) phase = "validating";
  else phase = "deploying";

  return {
    phase,
    stackStatus,
    domain,
    records,
    distributionDomain,
    inProgress,
    failureReason: phase === "failed" ? await firstFailure(ctx.cfn) : undefined,
  };
}

/** The root-cause event of a failed edge deploy (the rollback noise buries it). Best-effort. */
async function firstFailure(cfn: CloudFormationClient): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: edgeStackName }));
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        e.ResourceStatus?.endsWith("_FAILED") &&
        e.ResourceStatusReason &&
        !/resource creation cancelled/i.test(e.ResourceStatusReason),
    );
    return failures[failures.length - 1]?.ResourceStatusReason;
  } catch {
    return undefined;
  }
}

/** Remove the edge stack. Idempotent; the core stack and all data stay untouched. */
export async function removeEdge(ctx: EdgeCtx): Promise<{ removed: boolean }> {
  const stack = await describe(ctx.cfn);
  if (!stack) return { removed: false };
  if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
    await ctx.cfn.send(new DeleteStackCommand({ StackName: edgeStackName }));
  }
  return { removed: true };
}

/**
 * Wait out an edge delete (teardown must not report success early — certification's tag
 * sweep would find the distribution). CloudFront disable+delete is the slow path: allow
 * up to 20 minutes.
 */
export async function waitEdgeDeleted(ctx: EdgeCtx): Promise<void> {
  await waitUntilStackDeleteComplete({ client: ctx.cfn, maxWaitTime: 1200 }, { StackName: edgeStackName });
}
