// The True Reach edge lifecycle (DESIGN.md §12, §14 P5 decisions): certificate + CloudFront
// in front of the collector, on the owner's own subdomain — now ONE SMALL STACK PER DOMAIN
// (multi-domain, 2026-08-04): distributions cost nothing to exist, each domain gets its own
// certificate and DNS validation, and adding or removing a domain can never touch another
// domain's serving. This is also exactly the shape per-domain billing wants.
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
// State machine, re-derived from AWS on every poll (background + resume, AGENTS.md §5),
// independently per domain:
//   none → validating (cert PENDING_VALIDATION; owner owes the validation CNAME)
//        → deploying  (cert ISSUED; stack creating — advanced by the status poll itself)
//        → ready      (stack complete; owner owes the pointing CNAME if not added)
//   removing / failed as encountered. Clients + cert store injected → unit-testable.

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

/**
 * Where the sidecar remembers the certificates it requested (the owner's own table).
 * Keys are DOMAINS; the single legacy key "truereach" (v1's one-domain model) is migrated
 * on first read. Values: `<domain>|<arn>|<stackName>` (legacy rows lack the third part).
 */
export interface CertStore {
  list(): Promise<{ key: string; value: string }[]>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
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
  /** The custom collector hostname (stats.<domain>) this status describes. */
  domain?: string;
  /** Records the owner still needs to create — empty when everything is verified. */
  records: DnsRecord[];
  /** The distribution's *.cloudfront.net hostname (the CNAME target), once created. */
  distributionDomain?: string;
  inProgress: boolean;
  failureReason?: string;
  /**
   * The deployed edge is behind this build (template drifted, or the viewer plane arrived
   * after it was created). NEVER auto-applied — the owner clicks, same contract as the
   * core stack's update banner.
   */
  updateAvailable?: boolean;
  /** True when browsing https://<domain>/ serves the statistics page (not just beacons). */
  viewerAtEdge?: boolean;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** v1's single-domain row key — recognized forever, rewritten on first sight. */
const LEGACY_KEY = "truereach";

/** One deployed (or deploying) True Reach domain, as remembered in the owner's table. */
export interface EdgeRecord {
  domain: string;
  arn: string;
  stackName: string;
}

/**
 * The stack name for a domain: unique per domain, always under the `TrafficPoppy*`
 * prefix the manifest's cloudformation grant is scoped to. (v1's single stack kept its
 * original name via the migration below, so live deployments are never re-created.)
 */
export function stackNameFor(domain: string): string {
  return `TrafficPoppyEdge-${domain.replace(/[^a-zA-Z0-9]+/g, "-")}`.slice(0, 128);
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

async function describeStack(cfn: CloudFormationClient, stackName: string): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Every remembered domain, migrating the v1 single-domain row in passing: its value was
 * `<domain>|<arn>` under the key "truereach", and its stack keeps v1's fixed name so the
 * live distribution is never replaced.
 */
export async function listEdges(ctx: EdgeCtx): Promise<EdgeRecord[]> {
  const rows = await ctx.certs.list();
  const out: EdgeRecord[] = [];
  for (const row of rows) {
    const [domain, arn, stackName] = row.value.split("|");
    if (!domain || !arn) continue;
    if (row.key === LEGACY_KEY) {
      const migrated: EdgeRecord = { domain, arn, stackName: edgeStackName };
      await ctx.certs.put(domain, `${domain}|${arn}|${edgeStackName}`);
      await ctx.certs.del(LEGACY_KEY);
      out.push(migrated);
    } else {
      out.push({ domain, arn, stackName: stackName || stackNameFor(domain) });
    }
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Start True Reach for one more domain: request the certificate OURSELVES, tagged at
 * birth (see module header). Returns immediately; edgeStatus advances the rest.
 * Idempotent per domain; other domains are untouched.
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

  const existing = await listEdges(ctx);
  if (existing.some((e) => e.domain === cleaned)) return { operation: "RESUMED" }; // idempotent re-click

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
  await ctx.certs.put(cleaned, `${cleaned}|${out.CertificateArn}|${stackNameFor(cleaned)}`);
  return { operation: "REQUESTED_CERTIFICATE" };
}

/** The live state of EVERY domain — one poll drives all machines independently. */
export async function edgeStatusAll(
  ctx: EdgeCtx,
  collectorUrlHost: string,
  viewerUrlHost = "",
): Promise<EdgeStatus[]> {
  const records = await listEdges(ctx);
  return Promise.all(records.map((rec) => edgeStatusOne(ctx, rec, collectorUrlHost, viewerUrlHost)));
}

/**
 * One domain's live state + whatever DNS work is still the owner's, straight from AWS —
 * and the one place its machine ADVANCES: once the certificate is issued, the poll that
 * sees it creates the stack (so progress continues however long the owner took over DNS).
 */
async function edgeStatusOne(
  ctx: EdgeCtx,
  rec: EdgeRecord,
  collectorUrlHost: string,
  viewerUrlHost: string,
): Promise<EdgeStatus> {
  const stack = await describeStack(ctx.cfn, rec.stackName);
  const records: DnsRecord[] = [];
  const domain = rec.domain;

  // Certificate side (best-effort detail — a hiccup here must never mask the state).
  let certStatus: string | undefined;
  try {
    const d = await ctx.acm.send(new DescribeCertificateCommand({ CertificateArn: rec.arn }));
    certStatus = d.Certificate?.Status;
    const rr = d.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
    if (certStatus === "PENDING_VALIDATION" && rr?.Name && rr.Value) {
      // Trimmed defensively: one leading space in a DNS name is stored as a DIFFERENT
      // name and serves NXDOMAIN while looking normal (live lesson, 2026-08-06).
      records.push({
        purpose: "certificate-validation",
        name: rr.Name.trim(),
        type: rr.Type ?? "CNAME",
        value: rr.Value.trim(),
      });
    }
  } catch {
    /* keep going with what we have */
  }

  // Stack side.
  const stackStatus = stack?.StackStatus ?? "";
  const distributionDomain = stack?.Outputs?.find((o) => o.OutputKey === "DistributionDomain")?.OutputValue;
  if (distributionDomain) {
    records.push({ purpose: "point-your-domain", name: `${domain}.`, type: "CNAME", value: distributionDomain });
  }

  // A rolled-back stack beside a live certificate is always debris (an earlier failed
  // attempt) — clear it rather than letting it shadow the real phase with a stale error.
  // But CAPTURE the reason first (live lesson 2026-08-06: a CNAMEAlreadyExists loop spun
  // create→rollback→delete for a DAY, and this cleanup erased the evidence every cycle,
  // so the card showed "setting up at the edge" throughout).
  if (stack && stackStatus === "ROLLBACK_COMPLETE") {
    const failureReason = await firstFailure(ctx.cfn, rec.stackName);
    await ctx.cfn.send(new DeleteStackCommand({ StackName: rec.stackName }));
    const phase = certStatus === "PENDING_VALIDATION" ? "validating" : "deploying";
    return { phase, stackStatus: "DELETE_IN_PROGRESS", domain, records, inProgress: true, failureReason };
  }

  // ADVANCE: cert issued, no stack yet → deploy the distribution.
  if (certStatus === "ISSUED" && collectorUrlHost && !stack) {
    await createStack(ctx, rec, collectorUrlHost, viewerUrlHost);
    return { phase: "deploying", stackStatus: "CREATE_IN_PROGRESS", domain, records, inProgress: true };
  }

  let phase: EdgePhase;
  const inProgress = /_IN_PROGRESS$/.test(stackStatus);
  if (stackStatus.startsWith("DELETE") && inProgress) phase = "removing";
  else if (/(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/.test(stackStatus)) phase = "failed";
  else if (stackStatus === "CREATE_COMPLETE" || stackStatus === "UPDATE_COMPLETE") phase = "ready";
  else if (stack) phase = "deploying";
  else if (certStatus === "PENDING_VALIDATION") phase = "validating";
  else phase = "deploying"; // issued-but-stack-not-yet, or describe hiccup

  // Update detection, NEVER auto-application (the owner clicks): the deployed stack is
  // behind when its template key drifted, or when a viewer plane exists that it doesn't
  // route to yet (stacks from before the dashboard rode this domain).
  const deployedTemplateKey = stack?.Tags?.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value;
  const deployedViewerHost = stack?.Parameters?.find((p) => p.ParameterKey === "ViewerUrlHost")?.ParameterValue ?? "";
  const updateAvailable =
    phase === "ready" &&
    ((!!deployedTemplateKey && deployedTemplateKey !== edgeTemplateKey) ||
      (!!viewerUrlHost && deployedViewerHost !== viewerUrlHost));

  return {
    phase,
    stackStatus: stackStatus || undefined,
    domain,
    records,
    distributionDomain,
    inProgress: inProgress || phase === "validating",
    // A rollback mid-flight is a FAILURE being cleaned up, not progress — surface the
    // reason so "setting up at the edge" can never mask a create→rollback loop again.
    failureReason:
      phase === "failed" || stackStatus.includes("ROLLBACK")
        ? await firstFailure(ctx.cfn, rec.stackName)
        : undefined,
    updateAvailable: updateAvailable || undefined,
    viewerAtEdge: (phase === "ready" && !!deployedViewerHost) || undefined,
  };
}

/**
 * Apply one domain's pending edge update (new template and/or the viewer origin) to its
 * EXISTING setup — same domain, same certificate, the distribution updates in place so
 * the owner's DNS records never change. Only ever called by an explicit owner click.
 */
export async function updateEdge(
  ctx: EdgeCtx,
  domain: string,
  collectorUrlHost: string,
  viewerUrlHost: string,
): Promise<void> {
  const rec = (await listEdges(ctx)).find((e) => e.domain === domain.trim().toLowerCase());
  if (!rec) throw new Error("True Reach isn't set up for that domain, so there's nothing to update.");
  if (!collectorUrlHost) throw new Error("The collector isn't deployed yet — set up TrafficPoppy first.");
  await createStack(ctx, rec, collectorUrlHost, viewerUrlHost);
}

async function createStack(
  ctx: EdgeCtx,
  rec: EdgeRecord,
  collectorUrlHost: string,
  viewerUrlHost: string,
): Promise<void> {
  const args = {
    StackName: rec.stackName,
    TemplateBody: edgeTemplateJson,
    Parameters: [
      { ParameterKey: "DomainName", ParameterValue: rec.domain },
      { ParameterKey: "CollectorUrlHost", ParameterValue: collectorUrlHost },
      { ParameterKey: "CertificateArn", ParameterValue: rec.arn },
      { ParameterKey: "ViewerUrlHost", ParameterValue: viewerUrlHost },
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
 * Remove True Reach for ONE domain (or for EVERY domain when none is given — the teardown
 * sweep): distribution stack first (the slow CloudFront drain), then the certificate
 * (deletable only once nothing references it). Idempotent; the core stack, every collected
 * number, and every OTHER domain stay untouched.
 */
export async function removeEdge(ctx: EdgeCtx, domain?: string): Promise<{ removed: string[] }> {
  const all = await listEdges(ctx);
  const targets = domain ? all.filter((e) => e.domain === domain.trim().toLowerCase()) : all;
  const removed: string[] = [];
  for (const rec of targets) {
    const stack = await describeStack(ctx.cfn, rec.stackName);
    if (stack) {
      if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
        await ctx.cfn.send(new DeleteStackCommand({ StackName: rec.stackName }));
      }
      await waitUntilStackDeleteComplete({ client: ctx.cfn, maxWaitTime: 1200 }, { StackName: rec.stackName });
      removed.push(rec.stackName);
    }
    try {
      await ctx.acm.send(new DeleteCertificateCommand({ CertificateArn: rec.arn }));
      removed.push(rec.arn);
    } catch (e) {
      if ((e as { name?: string }).name !== "ResourceNotFoundException") throw e;
    }
    await ctx.certs.del(rec.domain);
  }
  return { removed };
}

/** The root-cause event of a failed edge deploy (the rollback noise buries it). Best-effort. */
async function firstFailure(cfn: CloudFormationClient, stackName: string): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
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
