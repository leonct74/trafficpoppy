import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  ALL_SITES_GROUP,
  AuthError,
  bearerToken,
  mayReadSite,
  siteGroup,
  verifyJwt,
  visibleSites,
  type Jwk,
} from "./auth";

// A throwaway RSA keypair per test run — the tests mint their own tokens, so nothing here
// depends on AWS, the network, or a fixture that could silently rot.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "test-key" } as unknown as Jwk;

const ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test";
const CLIENT = "client-abc";
const NOW = 1_800_000_000;

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mint(
  claims: Record<string, unknown>,
  opts: { header?: Record<string, unknown>; key?: KeyObject; signature?: string } = {},
): string {
  const header = { alg: "RS256", kid: "test-key", ...opts.header };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  if (opts.signature !== undefined) return `${h}.${p}.${opts.signature}`;
  const signer = createSign("RSA-SHA256");
  signer.update(`${h}.${p}`);
  signer.end();
  return `${h}.${p}.${b64url(signer.sign(opts.key ?? privateKey))}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  sub: "user-1",
  email: "viewer@example.com",
  iss: ISSUER,
  aud: CLIENT,
  token_use: "id",
  exp: NOW + 600,
  "cognito:groups": ["site:abc"],
  ...over,
});

const verify = (token: string, over: Partial<Parameters<typeof verifyJwt>[1]> = {}) =>
  verifyJwt(token, { jwks: [jwk], issuer: ISSUER, clientId: CLIENT, now: NOW, ...over });

describe("verifyJwt", () => {
  it("accepts a well-formed token and returns its claims + groups", () => {
    const claims = verify(mint(goodClaims()));
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("viewer@example.com");
    expect(claims.groups).toEqual(["site:abc"]);
  });

  it("accepts an access token, which carries client_id instead of aud", () => {
    const claims = verify(mint(goodClaims({ token_use: "access", aud: undefined, client_id: CLIENT })));
    expect(claims.tokenUse).toBe("access");
  });

  // ── the classic JWT breaks ────────────────────────────────────────────────────────
  it("rejects alg:none — the forge-anything attack", () => {
    const token = mint(goodClaims(), { header: { alg: "none" }, signature: "" });
    expect(() => verify(token)).toThrow(AuthError);
  });

  it("rejects HS256, so a public key is never used as an HMAC secret", () => {
    const token = mint(goodClaims(), { header: { alg: "HS256" } });
    expect(() => verify(token)).toThrow(/algorithm/);
  });

  it("rejects a signature made with a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => verify(mint(goodClaims(), { key: other }))).toThrow(/bad signature/);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = mint(goodClaims());
    const [h, , s] = token.split(".");
    const forged = b64url(JSON.stringify(goodClaims({ "cognito:groups": [ALL_SITES_GROUP] })));
    expect(() => verify(`${h}.${forged}.${s}`)).toThrow(/bad signature/);
  });

  it("rejects a token from another pool (wrong issuer)", () => {
    expect(() => verify(mint(goodClaims({ iss: "https://cognito-idp.eu-west-1.amazonaws.com/other" })))).toThrow(
      /issuer/,
    );
  });

  it("rejects a token minted for a different app client", () => {
    expect(() => verify(mint(goodClaims({ aud: "someone-else" })))).toThrow(/audience/);
  });

  it("rejects an expired token — a revoked viewer must lose access", () => {
    expect(() => verify(mint(goodClaims({ exp: NOW - 3600 })))).toThrow(/expired/);
  });

  it("rejects an unknown signing key id", () => {
    expect(() => verify(mint(goodClaims(), { header: { kid: "rotated-away" } }))).toThrow(/unknown signing key/);
  });

  it("rejects malformed input rather than crashing", () => {
    expect(() => verify("not-a-jwt")).toThrow(AuthError);
    expect(() => verify("a.b.c")).toThrow(AuthError);
  });
});

describe("site grants (server-side enforcement)", () => {
  const claims = { sub: "u", groups: [siteGroup("abc")], exp: 0, tokenUse: "id" };
  const staff = { sub: "u", groups: [ALL_SITES_GROUP], exp: 0, tokenUse: "id" };

  it("allows a granted site and refuses everything else", () => {
    expect(mayReadSite(claims, "abc")).toBe(true);
    expect(mayReadSite(claims, "xyz")).toBe(false);
  });

  it("all-sites sees everything", () => {
    expect(mayReadSite(staff, "anything")).toBe(true);
  });

  it("hides ungranted sites entirely — client A never learns B exists", () => {
    const sites = [{ id: "abc" }, { id: "xyz" }];
    expect(visibleSites(claims, sites)).toEqual([{ id: "abc" }]);
    expect(visibleSites(staff, sites)).toHaveLength(2);
  });

  it("no groups means no access at all (fail closed)", () => {
    const nobody = { sub: "u", groups: [], exp: 0, tokenUse: "id" };
    expect(mayReadSite(nobody, "abc")).toBe(false);
    expect(visibleSites(nobody, [{ id: "abc" }])).toEqual([]);
  });
});

describe("bearerToken", () => {
  it("extracts a bearer token, case-insensitively", () => {
    expect(bearerToken({ authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
    expect(bearerToken({ authorization: "bearer xyz" })).toBe("xyz");
  });
  it("returns undefined when absent or malformed", () => {
    expect(bearerToken({})).toBeUndefined();
    expect(bearerToken({ authorization: "Basic abc" })).toBeUndefined();
  });
});
