// Viewer accounts and their per-site grants (DESIGN.md §7b).
//
// Viewers live in a Cognito pool in the OWNER's own AWS account: no identity, email or
// password ever reaches us. The owner invites people from the poppy; they sign in to the
// browser dashboard. A viewer can never touch AWS, site config, or teardown — the viewer
// Lambda's role is read-only on the table, and every read is authorised from verified claims.
//
// GRANTS ARE COGNITO GROUPS: `site:<id>` per granted site, or `all-sites` for staff. They ride
// in the JWT, so the viewer Lambda authorises from the token alone — no extra lookup on the
// request path, and nothing the client sends can influence it.

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CreateGroupCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

export const ALL_SITES_GROUP = "all-sites";
export const siteGroup = (siteId: string) => `site:${siteId}`;

export interface Viewer {
  email: string;
  /** Cognito's account state — FORCE_CHANGE_PASSWORD until they accept the invite. */
  status: string;
  /** True when this viewer can see every site, present and future. */
  allSites: boolean;
  /** Site ids this viewer was granted individually (empty when allSites). */
  siteIds: string[];
  createdAt?: string;
}

/** What the owner picks in the UI: specific sites, or everything. */
export interface Grants {
  allSites: boolean;
  siteIds: string[];
}

/** Group names for a grant selection. `all-sites` and per-site grants are mutually exclusive. */
export function groupsFor(grants: Grants): string[] {
  return grants.allSites ? [ALL_SITES_GROUP] : grants.siteIds.map(siteGroup);
}

/** Read a grant selection back out of a viewer's group memberships. */
export function grantsFrom(groups: string[]): Grants {
  if (groups.includes(ALL_SITES_GROUP)) return { allSites: true, siteIds: [] };
  return {
    allSites: false,
    siteIds: groups.filter((g) => g.startsWith("site:")).map((g) => g.slice("site:".length)),
  };
}

/** Reject nonsense before it reaches Cognito, with a sentence the owner can act on. */
export function validateEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error("Enter the person's email address so they can be invited.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`"${email}" doesn't look like an email address.`);
  return e;
}

export class ViewerDirectory {
  constructor(
    private readonly cognito: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  /** Every viewer, with the sites each may see. */
  async list(): Promise<Viewer[]> {
    const out = await this.cognito.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Limit: 60 }));
    const users = out.Users ?? [];
    return Promise.all(
      users.map(async (u) => {
        const email = u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username ?? "";
        const groups = await this.groupsOf(u.Username ?? "");
        const grants = grantsFrom(groups);
        return {
          email,
          status: u.UserStatus ?? "UNKNOWN",
          allSites: grants.allSites,
          siteIds: grants.siteIds,
          createdAt: u.UserCreateDate?.toISOString(),
        };
      }),
    );
  }

  private async groupsOf(username: string): Promise<string[]> {
    if (!username) return [];
    const out = await this.cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
    return (out.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean);
  }

  /**
   * A group must exist before anyone can be added to it. Idempotent: an existing group is a
   * success, not an error — inviting a second viewer to the same site must not fail.
   */
  private async ensureGroup(name: string): Promise<void> {
    try {
      await this.cognito.send(new CreateGroupCommand({ UserPoolId: this.userPoolId, GroupName: name }));
    } catch (e) {
      if ((e as { name?: string }).name !== "GroupExistsException") throw e;
    }
  }

  /**
   * Invite someone. Cognito emails them a temporary password; the dashboard's login handles
   * the NEW_PASSWORD_REQUIRED challenge on first sign-in, so they set their own password and
   * we never see it.
   */
  async invite(emailRaw: string, grants: Grants): Promise<Viewer> {
    const email = validateEmail(emailRaw);
    await this.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        // email_verified up front: the owner is vouching for their own colleague, and an
        // unverified address can't use the forgot-password path later.
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    await this.setGrants(email, grants);
    return { email, status: "FORCE_CHANGE_PASSWORD", allSites: grants.allSites, siteIds: grants.siteIds };
  }

  /** Replace a viewer's grants with exactly this selection. */
  async setGrants(emailRaw: string, grants: Grants): Promise<void> {
    const email = validateEmail(emailRaw);
    const want = groupsFor(grants);
    const have = await this.groupsOf(email);

    for (const g of want.filter((g) => !have.includes(g))) {
      await this.ensureGroup(g);
      await this.cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: g }),
      );
    }
    // Remove what's no longer granted — revoking a site must actually revoke it. Only touch
    // groups we manage, so a group the owner made by hand in the console is left alone.
    const ours = (g: string) => g === ALL_SITES_GROUP || g.startsWith("site:");
    for (const g of have.filter((g) => ours(g) && !want.includes(g))) {
      await this.cognito.send(
        new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: g }),
      );
    }
  }

  /** Remove a viewer entirely. Their access dies with the account. */
  async remove(emailRaw: string): Promise<void> {
    const email = validateEmail(emailRaw);
    await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: email }));
  }
}
