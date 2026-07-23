// The True Reach edge lifecycle (DESIGN.md §12, §14 P5 decisions): certificate + CloudFront
// in front of the collector, on the owner's own subdomain.
//
// THE CERTIFICATE IS REQUESTED DIRECTLY BY THIS SIDECAR — deliberately NOT via
// CloudFormation. The broker's session policy (rightly) allows creates only when the
// resource is BORN carrying our attribution tag (aws:RequestTag — SECURITY_MECHANISM.md
// I3), and CloudTrail proved CloudFormation's ACM handler calls RequestCertificate
// WITHOUT tags (it tags afterwards) — so a CFN-managed certificate is unauthorizable
// under the mechanism. Requesting it ourselves WITH tags satisfies birth-tagging
// honestly, and the cert stays in the tag sweep like the deploy bucket (our precedent
// for a managed out-of-stack resource). The distribution stays in CloudFormation: its
// create path (CreateDistributionWithTags) carries tags in-call.
//
// State machine, re-derived from AWS on every poll (background + resume, AGENTS.md §5):
//   none → validating (cert PENDING_VALIDATION; owner owes the validation CNAME)
//        → deploying  (cert ISSUED; stack creating — advanced by the status poll itself)
//        → ready      (stack complete; owner owes the pointing CNAME if not added)
//   removing / failed as encountered. Clients + cert-arn store injected → unit-testable.

import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
  type ACMClient,
} from "@aws-sdk/client-acm";
import { createHash } from "node:crypto";
import { edgeStackName, edgeTemplateJson, edgeTemplateKey, sourceCommit } from "./generated/backend-bundle";
import { stackTags, type AttributionContext } from "./tags";
import { TEMPLATE_KEY_TAG } from "./stack";

export { edgeStackName };

/** Where the sidecar remembers the certificate it requested (the owner's own table). */
export interface CertStore {
  get(domain: string): Promise<string | undefined>;
  put(domain: string, arn: string): Promise<void>;
  del(domain: string): Promise<void>;
}

/** Everything the edge lifecycle needs — us-east-1 clients (CloudFront's cert region). */
export interface EdgeCtx {
  cfn: CloudFormationClient;
  acm: ACMClient;
  certs: CertStore;
  attribution: AttributionContext;
}

export type EdgePhase = "none" | "validating" | "deploying" | "ready" | "removing" | "failed";

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

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The single edge domain this deployment runs (one True Reach domain per deployment, v1). */
const DOMAIN_KEY = "truereach";

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

async function describeStack(cfn: CloudFormationClient): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: edgeStackName }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The stored domain+arn, if a True Reach setup exists. */
async function storedCert(ctx: EdgeCtx): Promise<{ domain: string; arn: string } | undefined> {
  const stored = await ctx.certs.get(DOMAIN_KEY);
  if (!stored) return undefined;
  const [domain, arn] = stored.split("|", 2);
  return domain && arn ? { domain, arn } : undefined;
}

/**
 * Start (or resume) True Reach for a domain: request the certificate OURSELVES, tagged at
 * birth (see module header). Returns immediately; edgeStatus advances the rest.
 */
export async function deployEdge(
  ctx: EdgeCtx,
  domain: string,
  collectorUrlHost: string,
): Promise<{ operation: "REQUESTED_CERTIFICATE" | "RESUMED" }> {
  const cleaned = domain.trim().toLowerCase();
  if (!HOSTNAME.test(cleaned)) {
    throw new Error("That doesn't look like a hostname — try something like stats.your-domain.com.");
  }
  if (!collectorUrlHost) {
    throw new Error("The collector isn't deployed yet — set up TrafficPoppy first.");
  }
  if (!ctx.attribution.accountId || !ctx.attribution.connectionId) {
    throw new Error("TrafficPoppy isn't connected to your AWS account yet.");
  }

  const existing = await storedCert(ctx);
  if (existing?.domain === cleaned) return { operation: "RESUMED" }; // idempotent re-click

  // Tags IN the create call — the mechanism's birth-tag condition (I3) requires it, and
  // it's what makes the cert sweepable at teardown despite living outside the stack.
  const out = await ctx.acm.send(
    new RequestCertificateCommand({
      DomainName: cleaned,
      ValidationMethod: "DNS",
      // Same domain re-requested (e.g. after a remove) must not mint duplicate certs.
      IdempotencyToken: createHash("sha256").update(cleaned).digest("hex").slice(0, 32),
      Tags: stackTags({ ...ctx.attribution, sourceCommit: sourceCommit || undefined }),
    }),
  );
  if (!out.CertificateArn) throw new Error("AWS accepted the request but returned no certificate.");
  await ctx.certs.put(DOMAIN_KEY, `${cleaned}|${out.CertificateArn}`);
  return { operation: "REQUESTED_CERTIFICATE" };
}

/**
 * The live state + whatever DNS work is still the owner's, straight from AWS — and the
 * one place the machine ADVANCES: once the certificate is issued, the poll that sees it
 * creates/updates the stack (so progress continues however long the owner took over DNS).
 */
export async function edgeStatus(ctx: EdgeCtx, collectorUrlHost: string): Promise<EdgeStatus> {
  const cert = await storedCert(ctx);
  const stack = await describeStack(ctx.cfn);
  if (!cert && !stack) return { phase: "none", records: [], inProgress: false };

  const records: DnsRecord[] = [];
  const domain = cert?.domain ?? stack?.Parameters?.find((p) => p.ParameterKey === "DomainName")?.ParameterValue;

  // Certificate side (best-effort detail — a hiccup here must never mask the state).
  let certStatus: string | undefined;
  if (cert) {
    try {
      const d = await ctx.acm.send(new DescribeCertificateCommand({ CertificateArn: cert.arn }));
      certStatus = d.Certificate?.Status;
      const rr = d.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
      if (certStatus === "PENDING_VALIDATION" && rr?.Name && rr.Value) {
        records.push({ purpose: "certificate-validation", name: rr.Name, type: rr.Type ?? "CNAME", value: rr.Value });
      }
    } catch {
      /* keep going with what we have */
    }
  }

  // Stack side.
  const stackStatus = stack?.StackStatus ?? "";
  const distributionDomain = stack?.Outputs?.find((o) => o.OutputKey === "DistributionDomain")?.OutputValue;
  if (domain && distributionDomain) {
    records.push({ purpose: "point-your-domain", name: `${domain}.`, type: "CNAME", value: distributionDomain });
  }

  // ADVANCE: cert issued, no stack yet (or a failed one to replace) → deploy the distribution.
  if (cert && certStatus === "ISSUED" && collectorUrlHost) {
    if (!stack) {
      await createStack(ctx, cert.domain, collectorUrlHost, cert.arn);
      return { phase: "deploying", stackStatus: "CREATE_IN_PROGRESS", domain, records, inProgress: true };
    }
    if (stackStatus === "ROLLBACK_COMPLETE") {
      await ctx.cfn.send(new DeleteStackCommand({ StackName: edgeStackName }));
      return { phase: "deploying", stackStatus: "DELETE_IN_PROGRESS", domain, records, inProgress: true };
    }
  }

  let phase: EdgePhase;
  const inProgress = /_IN_PROGRESS$/.test(stackStatus);
  if (stackStatus.startsWith("DELETE") && inProgress) phase = "removing";
  else if (/(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/.test(stackStatus)) phase = "failed";
  else if (stackStatus === "CREATE_COMPLETE" || stackStatus === "UPDATE_COMPLETE") phase = "ready";
  else if (stack) phase = "deploying";
  else if (certStatus === "PENDING_VALIDATION") phase = "validating";
  else if (cert) phase = "deploying"; // issued-but-stack-not-yet, or describe hiccup
  else phase = "none";

  return {
    phase,
    stackStatus: stackStatus || undefined,
    domain,
    records,
    distributionDomain,
    inProgress: inProgress || phase === "validating",
    failureReason: phase === "failed" ? await firstFailure(ctx.cfn) : undefined,
  };
}

async function createStack(ctx: EdgeCtx, domain: string, collectorUrlHost: string, certArn: string): Promise<void> {
  const args = {
    StackName: edgeStackName,
    TemplateBody: edgeTemplateJson,
    Parameters: [
      { ParameterKey: "DomainName", ParameterValue: domain },
      { ParameterKey: "CollectorUrlHost", ParameterValue: collectorUrlHost },
      { ParameterKey: "CertificateArn", ParameterValue: certArn },
    ],
    Tags: [
      ...stackTags({ ...ctx.attribution, sourceCommit: sourceCommit || undefined }),
      { Key: TEMPLATE_KEY_TAG, Value: edgeTemplateKey },
    ],
  };
  try {
    await ctx.cfn.send(new CreateStackCommand(args));
  } catch (e) {
    if (/already exists/i.test((e as Error).message ?? "")) {
      try {
        await ctx.cfn.send(new UpdateStackCommand(args));
      } catch (e2) {
        if (!/No updates are to be performed/i.test((e2 as Error).message ?? "")) throw e2;
      }
      return;
    }
    throw e;
  }
}

/**
 * Remove True Reach entirely: distribution stack first (the slow CloudFront drain),
 * then the certificate (deletable only once nothing references it). Idempotent; the
 * core stack and every collected number stay untouched.
 */
export async function removeEdge(ctx: EdgeCtx): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const stack = await describeStack(ctx.cfn);
  if (stack) {
    if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
      await ctx.cfn.send(new DeleteStackCommand({ StackName: edgeStackName }));
    }
    await waitUntilStackDeleteComplete({ client: ctx.cfn, maxWaitTime: 1200 }, { StackName: edgeStackName });
    removed.push(edgeStackName);
  }
  const cert = await storedCert(ctx);
  if (cert) {
    try {
      await ctx.acm.send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
      removed.push(cert.arn);
    } catch (e) {
      if ((e as { name?: string }).name !== "ResourceNotFoundException") throw e;
    }
    await ctx.certs.del(DOMAIN_KEY);
  }
  return { removed };
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
