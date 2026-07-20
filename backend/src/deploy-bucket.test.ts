import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { deleteDeployBucket, deployBucketName, ensureDeployBucket, uploadLambdaCode } from "./deploy-bucket";

/** Records commands by class name; Head throws unless the bucket "exists". */
function fakeS3(opts: { exists?: boolean; objects?: string[]; truncateOnce?: boolean } = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let listCalls = 0;
  const client = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      if (name === "HeadBucketCommand" && !opts.exists) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      if (name === "ListObjectsV2Command") {
        const truncated = opts.truncateOnce && listCalls++ === 0;
        return { Contents: (opts.objects ?? []).map((Key) => ({ Key })), IsTruncated: truncated };
      }
      return {};
    }),
  } as unknown as S3Client;
  return { client, sent, names: () => sent.map((s) => s.name) };
}

describe("deployBucketName", () => {
  it("is DNS-safe, lowercased, and matches the manifest's trafficpoppy-deploy-* scope", () => {
    expect(deployBucketName("111122223333", "EU-West-1")).toBe("trafficpoppy-deploy-111122223333-eu-west-1");
  });
});

describe("ensureDeployBucket", () => {
  it("creates the bucket when absent and always tags it as ours", async () => {
    const s3 = fakeS3({ exists: false });
    await ensureDeployBucket(s3.client, "b", "eu-west-1", [{ Key: "agentspoppy:app", Value: "x" }]);
    expect(s3.names()).toContain("CreateBucketCommand");
    expect(s3.names()).toContain("PutBucketTaggingCommand");
  });

  it("skips creation when the bucket already exists, but still (re)tags it", async () => {
    const s3 = fakeS3({ exists: true });
    await ensureDeployBucket(s3.client, "b", "eu-west-1", [{ Key: "agentspoppy:app", Value: "x" }]);
    expect(s3.names()).not.toContain("CreateBucketCommand");
    expect(s3.names()).toContain("PutBucketTaggingCommand");
  });

  it("omits LocationConstraint in us-east-1 (where sending it is an error)", async () => {
    const s3 = fakeS3({ exists: false });
    await ensureDeployBucket(s3.client, "b", "us-east-1", []);
    const create = s3.sent.find((c) => c.name === "CreateBucketCommand")!;
    expect(create.input.CreateBucketConfiguration).toBeUndefined();
  });
});

describe("uploadLambdaCode", () => {
  it("puts the decoded zip under the content-addressed key", async () => {
    const s3 = fakeS3({ exists: true });
    await uploadLambdaCode(s3.client, "b", "collector-abc.zip", Buffer.from("zipbytes").toString("base64"));
    const put = s3.sent.find((c) => c.name === "PutObjectCommand")!;
    expect(put.input.Key).toBe("collector-abc.zip");
    expect((put.input.Body as Buffer).toString()).toBe("zipbytes");
  });
});

describe("deleteDeployBucket — idempotent (teardown may run twice)", () => {
  it("is a no-op when the bucket is already gone", async () => {
    const s3 = fakeS3({ exists: false });
    expect(await deleteDeployBucket(s3.client, "b")).toBe(false);
    expect(s3.names()).not.toContain("DeleteBucketCommand");
  });

  it("empties (all pages) then deletes the bucket", async () => {
    const s3 = fakeS3({ exists: true, objects: ["a", "b"], truncateOnce: true });
    expect(await deleteDeployBucket(s3.client, "b")).toBe(true);
    // Two list pages ⇒ two DeleteObjects, then the bucket delete.
    expect(s3.names().filter((n) => n === "DeleteObjectsCommand").length).toBe(2);
    expect(s3.names()).toContain("DeleteBucketCommand");
  });

  it("skips the object delete when the bucket is already empty", async () => {
    const s3 = fakeS3({ exists: true, objects: [] });
    await deleteDeployBucket(s3.client, "b");
    expect(s3.names()).not.toContain("DeleteObjectsCommand");
    expect(s3.names()).toContain("DeleteBucketCommand");
  });
});
