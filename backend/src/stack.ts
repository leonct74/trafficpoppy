// The stack lifecycle: deploy, report live status, tear down.
//
// The template is EMBEDDED in this binary (backend-bundle.ts, generated from infra/), so
// the user never needs cdk, node, or an internet round-trip to a template store. P0's
// template is small enough to pass inline as TemplateBody — no deploy bucket exists yet,
// which means P0 creates NOTHING outside its stack. (P1 adds the Lambda zip, which does
// need an S3 bucket; that bucket must then be tagged and removed by the teardown hook.)
//
// Everything here takes its CloudFormation client by injection so the lifecycle logic is
// unit-testable without touching AWS.

import {
  ContinueUpdateRollbackCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type Capability,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  stackName,
  templateJson,
  templateKey,
  tableName,
  lambdaCodeKey,
  lambdaZipBase64,
  sourceCommit,
} from "./generated/backend-bundle";
import { deployBucketName, ensureDeployBucket, uploadLambdaCode, deleteDeployBucket } from "./deploy-bucket";
import { stackTags, type AttributionContext } from "./tags";

export { stackName, tableName, templateKey };

/** Everything the stack lifecycle needs to reach AWS. Clients injected → unit-testable. */
export interface AwsCtx {
  cfn: CloudFormationClient;
  s3: S3Client;
  region: string;
  accountId: string;
}

/** The stack creates an IAM role, so CloudFormation needs these acknowledged. */
const CAPABILITIES: Capability[] = ["CAPABILITY_NAMED_IAM"];

/** How the UI should treat the stack right now — derived from AWS, never remembered. */
export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** The raw CloudFormation StackStatus, for the technical/details view. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  /** True while AWS is still working — the UI polls on this (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence for the user when something went wrong. */
  message?: string;
  /** The raw CloudFormation reason for a failure — for the technical details view. */
  failureReason?: string;
  /** The template this deployment actually runs, vs. the one this build ships. */
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  updateAvailable: boolean;
  /** The collector endpoint (Function URL) once the stack is up — the tracking script's origin. */
  collectorUrl?: string;
}

export type StackOperation = "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";

/** The tag recording WHICH template a stack runs — the NO_CHANGE cross-check (DESIGN.md §8). */
export const TEMPLATE_KEY_TAG = "trafficpoppy:templateKey";

/** CloudFormation statuses that mean "AWS is mid-operation, poll me". */
const IN_PROGRESS = /_IN_PROGRESS$/;
/** Statuses that mean the last operation left the stack unusable. */
const FAILED = /(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/;

/** True when DescribeStacks says the stack simply isn't there. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

/** The stack as AWS currently has it, or null if it doesn't exist. */
async function describe(cfn: CloudFormationClient, name: string): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function phaseOf(status: string | undefined): DeploymentPhase {
  if (!status) return "none";
  if (status.startsWith("DELETE") && IN_PROGRESS.test(status)) return "removing";
  if (IN_PROGRESS.test(status)) return "deploying";
  if (FAILED.test(status)) return "failed";
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") return "ready";
  return "deploying";
}

/**
 * Read the live deployment state straight from CloudFormation.
 *
 * This is the whole of AGENTS.md §5: the UI holds no memory of a deploy. It calls this on
 * every mount and derives where the user is from what's really in their account, so
 * leaving mid-deploy and coming back lands on live progress rather than a dead spinner.
 */
export async function getStatus(ctx: AwsCtx): Promise<DeploymentStatus> {
  const { cfn, region } = ctx;
  const stack = await describe(cfn, stackName);
  const stackStatus = stack?.StackStatus;
  const phase = phaseOf(stackStatus);
  const deployedTemplateKey = stack?.Tags?.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value;
  const collectorUrl = stack?.Outputs?.find((o) => o.OutputKey === "CollectorUrl")?.OutputValue;

  // On a failure, pull the actual reason from the stack's events so the details view shows
  // WHY (e.g. an AccessDenied on a specific action), not just "it rolled back". Best-effort
  // and read-only — a permission gap here must never mask the failure itself.
  const failureReason = phase === "failed" ? await firstFailureReason(cfn) : undefined;

  return {
    phase,
    stackStatus,
    stackName,
    region,
    tableName: phase === "ready" ? tableName : undefined,
    inProgress: !!stackStatus && IN_PROGRESS.test(stackStatus),
    message: phase === "failed" ? failureMessage(stackStatus) : undefined,
    failureReason,
    deployedTemplateKey,
    currentTemplateKey: templateKey,
    // Only meaningful once we know what's deployed; a stack from before this tag existed
    // reports no key and we don't nag about an update we can't substantiate.
    updateAvailable: !!deployedTemplateKey && deployedTemplateKey !== templateKey,
    collectorUrl: phase === "ready" ? collectorUrl : undefined,
  };
}

/**
 * The raw reason CloudFormation gives for the first resource that failed — the
 * root-cause event, which the later CREATE_FAILED/ROLLBACK noise buries. Read-only,
 * best-effort: any error (throttling, a missing DescribeStackEvents grant) yields
 * undefined rather than masking the failure the user is already looking at.
 */
async function firstFailureReason(cfn: CloudFormationClient): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    // Events are newest-first; the earliest *_FAILED with a reason is the trigger. Ignore
    // the boilerplate rollback reason CloudFormation stamps on the stack itself.
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        e.ResourceStatus?.endsWith("_FAILED") &&
        e.ResourceStatusReason &&
        !/resource creation cancelled/i.test(e.ResourceStatusReason),
    );
    const root = failures[failures.length - 1];
    return root?.ResourceStatusReason;
  } catch {
    return undefined;
  }
}

function failureMessage(status: string | undefined): string {
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
    return "The last setup attempt didn't finish and AWS undid it. You can safely try again.";
  }
  return "Something went wrong in your AWS account during the last change. You can try again, or remove TrafficPoppy and start fresh.";
}

export interface DeployResult {
  operation: StackOperation;
  stackName: string;
  templateKey: string;
}

/**
 * Create or update the stack. Returns as soon as AWS accepts the request — the work runs
 * in the background (AGENTS.md §5); poll getStatus for completion.
 *
 * Before deploying we ensure the per-account deploy bucket exists and upload the collector's
 * code zip to it (content-addressed key), then point the stack at it via parameters.
 */
export async function deploy(ctx: AwsCtx, attribution: AttributionContext): Promise<DeployResult> {
  const { cfn, s3, region, accountId } = ctx;
  // The stack MUST carry attribution or AgentsPoppy can neither show nor tear down what
  // we made — so refuse rather than deploy an untrackable footprint.
  if (!attribution.accountId || !attribution.connectionId) {
    throw new Error(
      "TrafficPoppy isn't connected to your AWS account yet. Approve it in AgentsPoppy, then try again.",
    );
  }

  const attrTags = stackTags({ ...attribution, sourceCommit: sourceCommit || undefined });
  const Tags = [...attrTags, { Key: TEMPLATE_KEY_TAG, Value: templateKey }];

  // The deploy bucket is our one out-of-stack resource — tag it as ours so it's swept up,
  // and upload the code the stack will reference.
  const bucket = deployBucketName(accountId, region);
  await ensureDeployBucket(s3, bucket, region, attrTags);
  await uploadLambdaCode(s3, bucket, lambdaCodeKey, lambdaZipBase64);

  const Parameters = [
    { ParameterKey: "LambdaCodeBucket", ParameterValue: bucket },
    { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
  ];
  const args = {
    StackName: stackName,
    TemplateBody: templateJson,
    Parameters,
    Capabilities: CAPABILITIES,
    Tags,
  };

  const existing = await describe(cfn, stackName);
  const status = existing?.StackStatus;

  // A previous failed create leaves ROLLBACK_COMPLETE: it can't be updated, and creating
  // over it fails until it's fully gone. Delete, wait, recreate.
  if (status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 300 }, { StackName: stackName });
    await cfn.send(new CreateStackCommand(args));
    return { operation: "RECREATE", stackName, templateKey };
  }

  if (!status) {
    await cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE", stackName, templateKey };
  }

  // A failed update whose rollback ALSO failed strands the stack: it can only leave
  // UPDATE_ROLLBACK_FAILED via ContinueUpdateRollback — or a delete, which would destroy
  // the Function URL and silently invalidate every snippet site owners have installed.
  // So: finish the rollback, then run the update as normal. (Live lesson: a permission
  // gap that fails the update usually fails the rollback identically, so this branch only
  // succeeds AFTER the gap itself is fixed.)
  if (status === "UPDATE_ROLLBACK_FAILED") {
    await cfn.send(new ContinueUpdateRollbackCommand({ StackName: stackName }));
    const settled = await waitUntilRollbackSettles(cfn);
    if (settled !== "UPDATE_ROLLBACK_COMPLETE") {
      throw new Error(`The previous change could not be rolled back (stack is ${settled}).`);
    }
  }

  try {
    await cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE", stackName, templateKey };
  } catch (e) {
    // Not an error: the account already runs exactly this template + code.
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) {
      return { operation: "NO_CHANGE", stackName, templateKey };
    }
    throw e;
  }
}

/** Poll until a continued rollback stops being in-progress; returns the final status. */
async function waitUntilRollbackSettles(cfn: CloudFormationClient): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const stack = await describe(cfn, stackName);
    const status = stack?.StackStatus ?? "";
    if (!IN_PROGRESS.test(status)) return status;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for the previous change to finish rolling back.");
}

export interface TeardownResult {
  /** What we actually asked AWS to remove (empty when there was nothing left). */
  removed: string[];
}

/**
 * The teardown hook (AGENTS.md §4). The host POSTs this at the START of teardown, then
 * deletes our stack itself — but certification runs with the host's cleanup OFF, so this
 * must do the real work on its own.
 *
 * MUST be idempotent: it can run more than once, including after a partial teardown, and
 * "already gone" is a success, not an error.
 *
 * Two things to remove: the stack (table, Lambda, role, log group, Function URL — all
 * in-stack, so DeleteStack handles them) and the deploy bucket, which lives OUTSIDE the
 * stack and which the stack delete won't touch. We delete the bucket AFTER the stack is
 * gone, so we never pull the Lambda code out from under an in-flight stack operation.
 */
export async function teardown(ctx: AwsCtx): Promise<TeardownResult> {
  const { cfn, s3, region, accountId } = ctx;
  const removed: string[] = [];

  const stack = await describe(cfn, stackName);
  if (stack) {
    if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    }
    // Wait for the delete to actually land: returning early would report success while the
    // table still exists, and certification's tag sweep would (correctly) find it.
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stackName });
    removed.push(stackName);
  }

  // The out-of-stack deploy bucket (idempotent — a missing bucket is success).
  const bucket = deployBucketName(accountId, region);
  if (await deleteDeployBucket(s3, bucket)) removed.push(bucket);

  return { removed };
}
