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
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { stackName, templateJson, templateKey, tableName, sourceCommit } from "./generated/backend-bundle";
import { stackTags, TAG_SOURCE_COMMIT, type AttributionContext } from "./tags";

export { stackName, tableName, templateKey };

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
  /** The template this deployment actually runs, vs. the one this build ships. */
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  updateAvailable: boolean;
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
export async function getStatus(cfn: CloudFormationClient, region: string): Promise<DeploymentStatus> {
  const stack = await describe(cfn, stackName);
  const stackStatus = stack?.StackStatus;
  const phase = phaseOf(stackStatus);
  const deployedTemplateKey = stack?.Tags?.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value;

  return {
    phase,
    stackStatus,
    stackName,
    region,
    tableName: phase === "ready" ? tableName : undefined,
    inProgress: !!stackStatus && IN_PROGRESS.test(stackStatus),
    message: phase === "failed" ? failureMessage(stackStatus) : undefined,
    deployedTemplateKey,
    currentTemplateKey: templateKey,
    // Only meaningful once we know what's deployed; a stack from before this tag existed
    // reports no key and we don't nag about an update we can't substantiate.
    updateAvailable: !!deployedTemplateKey && deployedTemplateKey !== templateKey,
  };
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
 */
export async function deploy(
  cfn: CloudFormationClient,
  ctx: AttributionContext,
): Promise<DeployResult> {
  // The stack MUST carry attribution or AgentsPoppy can neither show nor tear down what
  // we made — so refuse rather than deploy an untrackable footprint.
  if (!ctx.accountId || !ctx.connectionId) {
    throw new Error(
      "TrafficPoppy isn't connected to your AWS account yet. Approve it in AgentsPoppy, then try again.",
    );
  }
  const Tags = [...stackTags({ ...ctx, sourceCommit: sourceCommit || undefined }), { Key: TEMPLATE_KEY_TAG, Value: templateKey }];
  const args = { StackName: stackName, TemplateBody: templateJson, Tags };

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

  try {
    await cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE", stackName, templateKey };
  } catch (e) {
    // Not an error: the account already runs exactly this template.
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) {
      return { operation: "NO_CHANGE", stackName, templateKey };
    }
    throw e;
  }
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
 * P0 keeps the entire footprint inside the stack, so deleting the stack IS the complete
 * teardown. Anything we ever create outside it (the P1 deploy bucket) must be removed
 * here too.
 */
export async function teardown(cfn: CloudFormationClient): Promise<TeardownResult> {
  const stack = await describe(cfn, stackName);
  if (!stack) return { removed: [] };

  if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  }
  // Wait for the delete to actually land: returning early would report success while the
  // table still exists, and certification's tag sweep would (correctly) find it.
  await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stackName });
  return { removed: [stackName] };
}
