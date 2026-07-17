import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTemplate, STACK_NAME, TABLE_NAME, TTL_ATTRIBUTE } from "./template";

const template = buildTemplate();
const table = template.Resources.TrafficTable as {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: Record<string, unknown>;
};

describe("the analytics table", () => {
  it("bills on demand, so an idle site costs ~$0", () => {
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.Properties).not.toHaveProperty("ProvisionedThroughput");
  });

  it("declares the TTL attribute from day one, so privacy-sensitive rows can age out", () => {
    // DESIGN.md §2: the raw daily-hash rows are the most sensitive thing we ever hold and
    // MUST expire. Declaring TTL at P0 means it's never a later stack update that could
    // silently fail to apply.
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTRIBUTE, Enabled: true });
  });

  it("keys on (pk, sk) for the single-table design", () => {
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
  });

  it("is pure — two builds produce identical bytes", () => {
    // The build script content-addresses the template; a nondeterministic builder would
    // make the hash differ per machine.
    expect(JSON.stringify(buildTemplate())).toBe(JSON.stringify(buildTemplate()));
  });
});

describe("leaves no trace (AGENTS.md §4)", () => {
  const resources = Object.entries(template.Resources) as [
    string,
    { DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties?: Record<string, unknown> },
  ][];

  it("retains nothing — deleting the stack must remove the whole footprint", () => {
    for (const [name, r] of resources) {
      expect(r.DeletionPolicy, `${name} must not be retained on delete`).not.toBe("Retain");
      expect(r.UpdateReplacePolicy, `${name} must not be retained on replace`).not.toBe("Retain");
    }
  });

  it("never enables deletion protection — CloudFormation could not then delete the table", () => {
    for (const [name, r] of resources) {
      expect(r.Properties?.DeletionProtectionEnabled, `${name} must stay deletable`).toBeUndefined();
    }
  });
});

describe("the template stays in lockstep with the manifest's declared scope", () => {
  // AGENTS.md §6: "Keep it in lockstep with your real IAM deploy policy." If a resource
  // ever gets a name our grants don't cover, the deploy fails at the user's account with
  // an AccessDenied — this catches it here instead.
  const manifest = JSON.parse(readFileSync(new URL("../../extension.json", import.meta.url), "utf8")) as {
    permissionSet: { grants: { service: string; actions: string[]; resourceScope: string }[] };
  };
  const scopeOf = (service: string) =>
    manifest.permissionSet.grants.find((g) => g.service === service)!.resourceScope;

  /** Does an AWS ARN pattern (with `*` wildcards) cover this concrete ARN? */
  const covers = (pattern: string, arn: string) =>
    new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(arn);

  it("covers the table name we actually create", () => {
    expect(covers(scopeOf("dynamodb"), `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE_NAME}`)).toBe(true);
  });

  it("covers the stack name we actually deploy", () => {
    expect(
      covers(scopeOf("cloudformation"), `arn:aws:cloudformation:eu-west-1:123456789012:stack/${STACK_NAME}/abc-123`),
    ).toBe(true);
  });

  it("does not cover a resource that isn't ours", () => {
    expect(covers(scopeOf("dynamodb"), "arn:aws:dynamodb:eu-west-1:123456789012:table/CustomerOrders")).toBe(false);
  });
});
