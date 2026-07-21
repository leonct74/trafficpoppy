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

/** Fixed names, all under the `TrafficPoppy*` prefix the manifest's grants are scoped to. */
export const FUNCTION_NAME = "TrafficPoppyCollector";
export const ROLE_NAME = "TrafficPoppyCollectorRole";
/** The Lambda runtime's handler entrypoint: <bundled-file>.<export>. */
export const LAMBDA_HANDLER = "collector.handler";
export const LAMBDA_RUNTIME = "nodejs20.x";

export interface CfnTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Parameters?: Record<string, unknown>;
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
    // The Lambda code lives in the per-account deploy bucket the sidecar uploads to before
    // deploying (P0's inline template couldn't carry a zip). Passed as parameters so the
    // content-addressed key changes whenever the collector changes — CloudFormation then
    // sees a real update instead of NO_CHANGE.
    Parameters: {
      LambdaCodeBucket: { Type: "String", Description: "S3 bucket holding the collector code zip." },
      LambdaCodeKey: { Type: "String", Description: "S3 key of the collector code zip (content-addressed)." },
    },
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

      // The collector's execution role — a NAMED role (TrafficPoppyCollectorRole) so the
      // manifest's iam grant can be scoped to role/TrafficPoppy* rather than "*". It grants
      // the LEAST: write its own log group, and read/write ONLY the analytics table.
      CollectorRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: ROLE_NAME,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "collector",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                    Resource: { "Fn::GetAtt": ["TrafficTable", "Arn"] },
                  },
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    // Construct the log-group ARN by name rather than Fn::GetAtt on the
                    // LogGroup: resolving a LogGroup's Arn attribute makes CloudFormation call
                    // logs:DescribeLogGroups on that group, and DescribeLogGroups can't be
                    // scoped to a single group in a session policy — so the deploy is denied.
                    // Building the ARN with Fn::Sub needs no read-back. (Live-deploy lesson.)
                    Resource: {
                      "Fn::Sub": `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${FUNCTION_NAME}:*`,
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      // Declared in-stack (rather than left for Lambda to auto-create) so it carries a
      // retention policy AND is removed on teardown — an auto-created log group would orphan.
      CollectorLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: { "Fn::Sub": `/aws/lambda/${FUNCTION_NAME}` },
          RetentionInDays: 14,
        },
      },

      Collector: {
        Type: "AWS::Lambda::Function",
        // The function name must exist before its log group is referenced by name; declare
        // the dependency so CloudFormation orders them correctly.
        DependsOn: ["CollectorLogGroup"],
        Properties: {
          FunctionName: FUNCTION_NAME,
          Runtime: LAMBDA_RUNTIME,
          Handler: LAMBDA_HANDLER,
          Role: { "Fn::GetAtt": ["CollectorRole", "Arn"] },
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Timeout: 10,
          MemorySize: 128,
          Environment: { Variables: { TABLE_NAME: { Ref: "TrafficTable" } } },
        },
      },

      // The public HTTPS endpoint — no API Gateway (DESIGN.md §2). AuthType NONE because it
      // serves a public tracking script and ingests anonymous beacons; abuse is bounded by
      // the per-site daily write cap in the collector, not by auth.
      CollectorUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["Collector", "Arn"] },
          AuthType: "NONE",
          Cors: {
            AllowOrigins: ["*"],
            AllowMethods: ["GET", "POST"],
            AllowHeaders: ["content-type"],
            MaxAge: 86400,
          },
        },
      },

      // A Function URL needs an explicit resource-based permission for public invoke.
      CollectorUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Collector" },
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
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
      CollectorUrl: {
        Description: "The collector endpoint — serves /t.js and ingests /e. This is the script's origin.",
        Value: { "Fn::GetAtt": ["CollectorUrl", "FunctionUrl"] },
      },
    },
  };
}
