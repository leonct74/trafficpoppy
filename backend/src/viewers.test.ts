import { describe, expect, it, vi } from "vitest";
import {
  ALL_SITES_GROUP,
  grantsFrom,
  groupsFor,
  siteGroup,
  validateEmail,
  ViewerDirectory,
} from "./viewers";

/** A fake Cognito that records the commands it was sent. */
function fakeCognito(groupsByUser: Record<string, string[]> = {}, users: unknown[] = []) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    sent.push({ name, input: cmd.input });
    if (name === "ListUsersCommand") return { Users: users };
    if (name === "AdminListGroupsForUserCommand") {
      const u = String(cmd.input.Username);
      return { Groups: (groupsByUser[u] ?? []).map((g) => ({ GroupName: g })) };
    }
    return {};
  });
  return { client: { send } as never, sent, send };
}

const dir = (c: ReturnType<typeof fakeCognito>) => new ViewerDirectory(c.client, "eu-west-1_pool");
const names = (c: ReturnType<typeof fakeCognito>) => c.sent.map((s) => s.name);

describe("grant ↔ group mapping", () => {
  it("maps specific sites to per-site groups", () => {
    expect(groupsFor({ allSites: false, siteIds: ["abc", "xyz"] })).toEqual(["site:abc", "site:xyz"]);
  });

  it("all-sites replaces per-site grants rather than adding to them", () => {
    expect(groupsFor({ allSites: true, siteIds: ["abc"] })).toEqual([ALL_SITES_GROUP]);
  });

  it("round-trips back from group memberships", () => {
    expect(grantsFrom(["site:abc", "site:xyz"])).toEqual({ allSites: false, siteIds: ["abc", "xyz"] });
    expect(grantsFrom([ALL_SITES_GROUP, "site:abc"])).toEqual({ allSites: true, siteIds: [] });
    expect(grantsFrom([])).toEqual({ allSites: false, siteIds: [] });
  });

  it("ignores groups it doesn't own", () => {
    expect(grantsFrom(["some-other-group", "site:abc"])).toEqual({ allSites: false, siteIds: ["abc"] });
  });
});

describe("validateEmail", () => {
  it("normalises case and whitespace", () => {
    expect(validateEmail("  Person@Example.COM ")).toBe("person@example.com");
  });
  it("explains itself rather than throwing a raw AWS error later", () => {
    expect(() => validateEmail("")).toThrow(/Enter the person's email/);
    expect(() => validateEmail("nope")).toThrow(/doesn't look like an email/);
  });
});

describe("inviting", () => {
  it("creates the user, emails them, and applies the grants", async () => {
    const c = fakeCognito();
    const v = await dir(c).invite("New.Person@example.com", { allSites: false, siteIds: ["abc"] });

    expect(v.email).toBe("new.person@example.com");
    expect(v.status).toBe("FORCE_CHANGE_PASSWORD"); // must set their own password first
    expect(names(c)).toContain("AdminCreateUserCommand");
    expect(names(c)).toContain("CreateGroupCommand"); // group must exist before the add
    expect(names(c)).toContain("AdminAddUserToGroupCommand");

    const create = c.sent.find((s) => s.name === "AdminCreateUserCommand")!;
    expect(create.input.DesiredDeliveryMediums).toEqual(["EMAIL"]);
    expect(create.input.UserAttributes).toContainEqual({ Name: "email_verified", Value: "true" });
  });

  it("survives a group that already exists (second viewer on the same site)", async () => {
    const c = fakeCognito();
    c.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      c.sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "CreateGroupCommand") {
        throw Object.assign(new Error("exists"), { name: "GroupExistsException" });
      }
      if (cmd.constructor.name === "AdminListGroupsForUserCommand") return { Groups: [] };
      return {};
    });
    await expect(dir(c).invite("second@example.com", { allSites: false, siteIds: ["abc"] })).resolves.toBeTruthy();
    expect(names(c)).toContain("AdminAddUserToGroupCommand");
  });

  it("propagates a real CreateGroup failure instead of silently granting nothing", async () => {
    const c = fakeCognito();
    c.send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "CreateGroupCommand") {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      }
      if (cmd.constructor.name === "AdminListGroupsForUserCommand") return { Groups: [] };
      return {};
    });
    await expect(dir(c).invite("x@example.com", { allSites: false, siteIds: ["abc"] })).rejects.toThrow(/denied/);
  });
});

describe("changing grants", () => {
  it("REVOKES a site that is no longer granted", async () => {
    const c = fakeCognito({ "p@example.com": ["site:abc", "site:xyz"] });
    await dir(c).setGrants("p@example.com", { allSites: false, siteIds: ["abc"] });

    const removed = c.sent.filter((s) => s.name === "AdminRemoveUserFromGroupCommand");
    expect(removed.map((r) => r.input.GroupName)).toEqual(["site:xyz"]);
    // and doesn't churn the grant it already had
    expect(c.sent.filter((s) => s.name === "AdminAddUserToGroupCommand")).toHaveLength(0);
  });

  it("swaps per-site grants for all-sites, removing the now-redundant ones", async () => {
    const c = fakeCognito({ "p@example.com": ["site:abc"] });
    await dir(c).setGrants("p@example.com", { allSites: true, siteIds: [] });

    expect(c.sent.filter((s) => s.name === "AdminAddUserToGroupCommand")[0]!.input.GroupName).toBe(ALL_SITES_GROUP);
    expect(c.sent.filter((s) => s.name === "AdminRemoveUserFromGroupCommand")[0]!.input.GroupName).toBe("site:abc");
  });

  it("leaves groups it does not manage alone", async () => {
    const c = fakeCognito({ "p@example.com": ["finance-team", "site:abc"] });
    await dir(c).setGrants("p@example.com", { allSites: false, siteIds: [] });

    const removed = c.sent.filter((s) => s.name === "AdminRemoveUserFromGroupCommand").map((r) => r.input.GroupName);
    expect(removed).toEqual(["site:abc"]);
    expect(removed).not.toContain("finance-team");
  });

  it("revoking everything leaves the account with no site access", async () => {
    const c = fakeCognito({ "p@example.com": [ALL_SITES_GROUP] });
    await dir(c).setGrants("p@example.com", { allSites: false, siteIds: [] });
    expect(c.sent.filter((s) => s.name === "AdminRemoveUserFromGroupCommand")[0]!.input.GroupName).toBe(
      ALL_SITES_GROUP,
    );
  });
});

describe("listing and removal", () => {
  it("reports each viewer with the sites they can see", async () => {
    const c = fakeCognito({ "a@x.com": ["site:abc"], "b@x.com": [ALL_SITES_GROUP] }, [
      { Username: "a@x.com", UserStatus: "CONFIRMED", Attributes: [{ Name: "email", Value: "a@x.com" }] },
      { Username: "b@x.com", UserStatus: "FORCE_CHANGE_PASSWORD", Attributes: [{ Name: "email", Value: "b@x.com" }] },
    ]);
    const list = await dir(c).list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ email: "a@x.com", allSites: false, siteIds: ["abc"], status: "CONFIRMED" });
    expect(list[1]).toMatchObject({ email: "b@x.com", allSites: true, status: "FORCE_CHANGE_PASSWORD" });
  });

  it("deletes the account so access dies with it", async () => {
    const c = fakeCognito();
    await dir(c).remove("Gone@Example.com");
    const del = c.sent.find((s) => s.name === "AdminDeleteUserCommand")!;
    expect(del.input.Username).toBe("gone@example.com");
  });
});

describe("siteGroup", () => {
  it("namespaces site grants so they can't collide with a hand-made group", () => {
    expect(siteGroup("abc")).toBe("site:abc");
  });
});
