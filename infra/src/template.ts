// TrafficPoppy's CloudFormation template, authored as typed TypeScript.
//
// WHY NOT CDK: MailPoppy's generator shells out to `cdk synth` at build time. Our whole
// footprint is one table now, and a table + one Lambda + a Function URL + its role at P1
// — small enough to author directly, and doing so removes the cdk dependency and the
// synth step from the build. The output is the same thing either way: an asset-free
// template JSON that scripts/build-backend-bundle.mjs embeds into the sidecar. Recorded
// as an implementation decision in DESIGN.md §2.
//
// EVERYTHING LIVES IN THIS ONE STACK (AGENTS.md §4 "the easy path"): deleting the stack
// removes the whole footprint, so teardown can't leak. Nothing gets DeletionPolicy:
// Retain, and deletion protection stays off — both would make our own teardown fail.

/** The one stack we deploy. The manifest's cloudformation grant is scoped to this exact name. */
export const STACK_NAME = "TrafficPoppyStack";

/**
 * The analytics table. A fixed name (rather than a CloudFormation-generated one) because
 * the schema is a documented, stable, public surface — the owner's BI tools query this
 * table by name (DESIGN.md §1.4). It matches the manifest's `TrafficPoppy*` dynamodb scope.
 */
export const TABLE_NAME = "TrafficPoppyData";

/** The attribute holding a row's expiry, for the rows that should age out (P1 uniques). */
export const TTL_ATTRIBUTE = "expiresAt";

export interface CfnTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Resources: Record<string, unknown>;
  Outputs: Record<string, unknown>;
}

/**
 * Build the template. Pure — same input, same bytes — so the content-addressed hash the
 * build script derives from it is stable across machines.
 *
 * Single-table design (DESIGN.md §2):
 *   pk = site#<siteId>#day#<YYYY-MM-DD>   sk = <metric>#<value>   (atomic ADD count)
 *   pk = site#<siteId>#uniq#<YYYY-MM-DD>  sk = <dailyHash>        (conditional put, TTL'd)
 *
 * The TTL attribute is declared from P0 so the privacy-critical expiry (DESIGN.md §2: raw
 * hash rows MUST age out) is part of the table from the moment it exists, not bolted on by
 * a later stack update that could silently fail to apply.
 */
export function buildTemplate(): CfnTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "TrafficPoppy — privacy-first web analytics, running entirely in your own AWS.",
    Resources: {
      TrafficTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: TABLE_NAME,
          // On-demand: nothing provisioned, so an idle site bills ~$0 (DESIGN.md §1.3).
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          // CloudFormation enables TTL with a SEPARATE dynamodb:UpdateTimeToLive call after
          // CreateTable (and reads it back with DescribeTimeToLive) — so the manifest MUST
          // grant both, or the stack creates the table then rolls back on AccessDenied. This
          // only shows up on a live deploy; keep these two in lockstep with extension.json.
          TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
          // Deliberately absent: DeletionProtectionEnabled. CloudFormation cannot delete a
          // protected table, which would break leaves-no-trace (AGENTS.md §4).
        },
      },
    },
    Outputs: {
      TableName: {
        Description: "The DynamoDB table holding this deployment's analytics.",
        Value: { Ref: "TrafficTable" },
      },
      TableArn: {
        Description: "ARN of the analytics table — for the owner's own BI tools.",
        Value: { "Fn::GetAtt": ["TrafficTable", "Arn"] },
      },
    },
  };
}
