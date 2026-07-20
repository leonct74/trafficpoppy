// The per-account S3 bucket that holds the collector Lambda's code zip.
//
// CloudFormation can't carry a Lambda zip inline (the template is passed as TemplateBody),
// so the code must live in S3 and the template references it by bucket+key. This bucket is
// the ONE thing TrafficPoppy creates OUTSIDE its stack — so (a) it's tagged with the
// attribution tags like everything else, and (b) the teardown hook empties and deletes it,
// because the stack delete won't (AGENTS.md §4).
//
// Bucket ops are small and taken by an injected S3 client so the deploy/teardown logic is
// unit-testable without touching AWS.

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/** The deploy bucket name for an account+region. Matches the manifest's s3 scope
 *  (trafficpoppy-deploy-*), lowercased and DNS-safe. */
export function deployBucketName(accountId: string, region: string): string {
  return `trafficpoppy-deploy-${accountId}-${region}`.toLowerCase();
}

/** Create the bucket if absent and tag it as ours. Idempotent. */
export async function ensureDeployBucket(
  s3: S3Client,
  bucket: string,
  region: string,
  tags: { Key: string; Value: string }[],
): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 must NOT send a LocationConstraint (it's the API default and errors otherwise).
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  }
  // Tag even on the already-exists path, so a bucket from a prior partial run is attributable
  // (and therefore swept up) rather than orphaned.
  await s3.send(
    new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tags } }),
  );
}

/** Upload the Lambda code zip under its content-addressed key (idempotent by key). */
export async function uploadLambdaCode(
  s3: S3Client,
  bucket: string,
  key: string,
  zipBase64: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(zipBase64, "base64") }));
}

/**
 * Empty and delete the deploy bucket. Idempotent: a missing bucket is success (teardown may
 * run more than once). S3 refuses to delete a non-empty bucket, so we list + delete all
 * objects first (in pages).
 */
export async function deleteDeployBucket(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    return false; // already gone
  }
  for (;;) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
    if (!listed.IsTruncated) break;
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  return true;
}
