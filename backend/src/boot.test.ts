import { describe, it, expect } from "vitest";
import { brokerCredentialsProvider, readBootstrap, type BackendBootstrap } from "./boot";

const boot: BackendBootstrap = {
  connectionId: "conn-1",
  credentialsUrl: "http://127.0.0.1:9999/connections/conn-1/credentials",
  credentialsToken: "tok-abc",
  account: { accountId: "111122223333", region: "eu-west-1" },
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const creds = {
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "session",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
};

describe("brokerCredentialsProvider", () => {
  it("returns scoped credentials on an immediate 200", async () => {
    let calls = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => { calls++; return jsonResponse(200, creds); },
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(c.secretAccessKey).toBe("secret");
    expect(c.sessionToken).toBe("session");
    expect(c.expiration).toBeInstanceOf(Date);
    expect(calls).toBe(1);
  });

  it("presents the bearer token when minting", async () => {
    let auth: string | undefined;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async (_url, init) => {
        auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return jsonResponse(200, creds);
      },
      sleep: async () => {},
    });
    await provider();
    expect(auth).toBe("Bearer tok-abc");
  });

  it("polls a supervised 202 approval until credentials arrive (the bug that caused 'not valid')", async () => {
    const seq = [
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(200, creds),
    ];
    let i = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => seq[i++]!,
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(i).toBe(3);
  });

  it("throws a clear error when the broker refuses (paused/revoked)", async () => {
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => jsonResponse(403, { message: "connection is paused" }),
      sleep: async () => {},
    });
    await expect(provider()).rejects.toThrow(/paused/);
  });

  it("turns an unreachable broker into a calm 'waiting for AWS access', not a raw fetch error", async () => {
    // AGENTS.md §7: vending pauses whenever the user's AWS connection is unhealthy — a
    // normal, recoverable state the UI must render calmly rather than as a crash.
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async () => {},
    });
    await expect(provider()).rejects.toThrow(/waiting for AWS access/i);
  });

  it("re-requests a fresh approval when a pending one expires", async () => {
    const seq = [
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(410, { message: "approval expired, request again" }),
      jsonResponse(200, creds),
    ];
    let i = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => seq[i++]!,
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(i).toBe(3);
  });
});

describe("readBootstrap — the permissions boundary the host confirmed", () => {
  const withEnv = (v: unknown) => {
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ ...boot, permissionsBoundaryArn: v });
    return readBootstrap();
  };

  it("takes a non-empty ARN through", () => {
    expect(withEnv("arn:aws:iam::111122223333:policy/AgentsPoppyBoundary").permissionsBoundaryArn).toBe(
      "arn:aws:iam::111122223333:policy/AgentsPoppyBoundary",
    );
  });

  it("accepts the other AWS partitions, and trims", () => {
    expect(withEnv("  arn:aws:iam::111122223333:policy/AgentsPoppyBoundary  ").permissionsBoundaryArn).toBe(
      "arn:aws:iam::111122223333:policy/AgentsPoppyBoundary",
    );
    expect(withEnv("arn:aws-cn:iam::111122223333:policy/AgentsPoppyBoundary").permissionsBoundaryArn).toBe(
      "arn:aws-cn:iam::111122223333:policy/AgentsPoppyBoundary",
    );
    expect(withEnv("arn:aws-us-gov:iam::111122223333:policy/path/Boundary").permissionsBoundaryArn).toBe(
      "arn:aws-us-gov:iam::111122223333:policy/path/Boundary",
    );
  });

  it("reads anything else as unconfirmed, so the deploy keeps what the stack has", () => {
    // Never a value we'd hand to CloudFormation verbatim: absent, empty and wrong-typed
    // all mean "the host can't confirm a boundary", not "the boundary is ''".
    for (const v of ["", null, 0, {}, undefined]) {
      expect(withEnv(v).permissionsBoundaryArn, JSON.stringify(v)).toBeUndefined();
    }
  });

  it("rejects anything that isn't SHAPED like an IAM policy ARN", () => {
    // Truthy is not enough. A malformed value passed through verbatim makes the template's
    // HasPermissionsBoundary condition TRUE and then fails every CreateRole in the stack —
    // a rolled-back deploy where an unbounded one was promised.
    const junk = [
      "   ", // whitespace only — truthy, and the bug this closes
      "AgentsPoppyBoundary", // a bare policy name
      "arn:aws:iam::111122223333:policy/", // no policy name
      "arn:aws:iam::11112223:policy/Boundary", // account id too short
      "arn:aws:s3:::some-bucket", // right prefix, wrong service
      "arn:aws:iam::111122223333:role/Boundary", // a role, not a policy
      "notanarn arn:aws:iam::111122223333:policy/Boundary", // leading junk
    ];
    for (const v of junk) {
      expect(withEnv(v).permissionsBoundaryArn, v).toBeUndefined();
    }
  });
});
