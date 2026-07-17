import { describe, expect, it, vi } from "vitest";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import { deploy, getStatus, teardown, TEMPLATE_KEY_TAG } from "./stack";
import { templateKey } from "./generated/backend-bundle";
import { TAG_APP, TAG_ACCOUNT, TAG_CONNECTION } from "./tags";

const ctx = { accountId: "111122223333", connectionId: "conn-1" };

/** A CloudFormation whose DescribeStacks answers with the given statuses, in order. */
function fakeCfn(script: { describe?: (unknown | Error)[]; onSend?: (cmd: unknown) => unknown }) {
  const sent: unknown[] = [];
  let i = 0;
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof DescribeStacksCommand) {
        const next = script.describe?.[Math.min(i++, (script.describe?.length ?? 1) - 1)];
        if (next instanceof Error) throw next;
        return next ?? { Stacks: [] };
      }
      return script.onSend?.(cmd) ?? {};
    }),
  } as unknown as CloudFormationClient;
  return { client, sent };
}

const notFound = Object.assign(new Error("Stack with id TrafficPoppyStack does not exist"), {
  name: "ValidationError",
});
const stackWith = (StackStatus: string, Tags: { Key: string; Value: string }[] = []) => ({
  Stacks: [{ StackStatus, Tags }],
});

// waitUntilStackDeleteComplete polls the real client; stub the module so the delete paths
// don't sleep through a waiter in unit tests.
vi.mock("@aws-sdk/client-cloudformation", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cloudformation")>(
    "@aws-sdk/client-cloudformation",
  );
  return { ...actual, waitUntilStackDeleteComplete: vi.fn(async () => ({ state: "SUCCESS" })) };
});

describe("getStatus — state comes from AWS, never from memory (AGENTS.md §5)", () => {
  it("reports 'none' when nothing is deployed", async () => {
    const { client } = fakeCfn({ describe: [notFound] });
    const s = await getStatus(client, "eu-west-1");
    expect(s.phase).toBe("none");
    expect(s.inProgress).toBe(false);
    expect(s.tableName).toBeUndefined();
  });

  it("reports a create in flight as in-progress, so a returning user re-attaches to it", async () => {
    const { client } = fakeCfn({ describe: [stackWith("CREATE_IN_PROGRESS")] });
    const s = await getStatus(client, "eu-west-1");
    expect(s.phase).toBe("deploying");
    expect(s.inProgress).toBe(true);
  });

  it("reports a delete in flight as removing, not as a failed deploy", async () => {
    const { client } = fakeCfn({ describe: [stackWith("DELETE_IN_PROGRESS")] });
    const s = await getStatus(client, "eu-west-1");
    expect(s.phase).toBe("removing");
    expect(s.inProgress).toBe(true);
  });

  it("surfaces the table only once the stack is actually ready", async () => {
    const { client } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    const s = await getStatus(client, "eu-west-1");
    expect(s.phase).toBe("ready");
    expect(s.tableName).toBe("TrafficPoppyData");
  });

  it("turns a rollback into one calm sentence, not a raw status", async () => {
    const { client } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const s = await getStatus(client, "eu-west-1");
    expect(s.phase).toBe("failed");
    expect(s.message).toMatch(/try again/i);
    expect(s.message).not.toMatch(/ROLLBACK/);
    expect(s.stackStatus).toBe("ROLLBACK_COMPLETE"); // still available for the details view
  });

  it("spots a stack running an older template than this build ships", async () => {
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE", [{ Key: TEMPLATE_KEY_TAG, Value: "template-oldoldoldoldold" }])],
    });
    const s = await getStatus(client, "eu-west-1");
    expect(s.updateAvailable).toBe(true);
    expect(s.deployedTemplateKey).toBe("template-oldoldoldoldold");
  });

  it("does not claim an update when the deployed template already matches", async () => {
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE", [{ Key: TEMPLATE_KEY_TAG, Value: templateKey }])],
    });
    expect((await getStatus(client, "eu-west-1")).updateAvailable).toBe(false);
  });
});

describe("deploy", () => {
  it("creates the stack when there is none, stamped with all three attribution tags", async () => {
    const { client, sent } = fakeCfn({ describe: [notFound] });
    const r = await deploy(client, ctx);
    expect(r.operation).toBe("CREATE");

    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    const tags = Object.fromEntries((create.input.Tags ?? []).map((t) => [t.Key, t.Value]));
    // Without these three the host can neither attribute nor tear down what we made.
    expect(tags[TAG_ACCOUNT]).toBe("111122223333");
    expect(tags[TAG_APP]).toBe("com.trafficpoppy.desktop");
    expect(tags[TAG_CONNECTION]).toBe("conn-1");
    expect(tags[TEMPLATE_KEY_TAG]).toBe(templateKey);
  });

  it("refuses to deploy an untrackable footprint when there's no connection", async () => {
    const { client, sent } = fakeCfn({ describe: [notFound] });
    await expect(deploy(client, { accountId: "", connectionId: "" })).rejects.toThrow(/connected/i);
    expect(sent.find((c) => c instanceof CreateStackCommand)).toBeUndefined();
  });

  it("updates an existing stack", async () => {
    const { client } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    expect((await deploy(client, ctx)).operation).toBe("UPDATE");
  });

  it("treats 'no updates to perform' as NO_CHANGE, not an error", async () => {
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE")],
      onSend: (cmd) => {
        if (cmd instanceof UpdateStackCommand) throw new Error("No updates are to be performed.");
        return {};
      },
    });
    expect((await deploy(client, ctx)).operation).toBe("NO_CHANGE");
  });

  it("deletes and recreates a stack stuck in ROLLBACK_COMPLETE (it cannot be updated)", async () => {
    const { client, sent } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const r = await deploy(client, ctx);
    expect(r.operation).toBe("RECREATE");
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
    expect(sent.find((c) => c instanceof CreateStackCommand)).toBeDefined();
  });

  it("lets a real AWS failure surface rather than swallowing it", async () => {
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE")],
      onSend: (cmd) => {
        if (cmd instanceof UpdateStackCommand) throw new Error("AccessDenied: not authorized");
        return {};
      },
    });
    await expect(deploy(client, ctx)).rejects.toThrow(/AccessDenied/);
  });
});

describe("teardown — must leave no trace, and must be idempotent (AGENTS.md §4)", () => {
  it("deletes the stack and waits for it to actually be gone", async () => {
    const { client, sent } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    const r = await teardown(client);
    expect(r.removed).toEqual(["TrafficPoppyStack"]);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
  });

  it("succeeds with nothing to do when the stack is already gone (it may run twice)", async () => {
    const { client, sent } = fakeCfn({ describe: [notFound] });
    const r = await teardown(client);
    expect(r.removed).toEqual([]);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeUndefined();
  });

  it("waits out a delete that's already running instead of asking for it twice", async () => {
    const { client, sent } = fakeCfn({ describe: [stackWith("DELETE_IN_PROGRESS")] });
    const r = await teardown(client);
    expect(sent.filter((c) => c instanceof DeleteStackCommand)).toHaveLength(0);
    expect(r.removed).toEqual(["TrafficPoppyStack"]);
  });

  it("tears down a failed stack too — a rollback still leaves resources behind", async () => {
    const { client, sent } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    await teardown(client);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
  });
});
