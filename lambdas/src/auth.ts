// Viewer authentication (DESIGN.md §7b): verify a Cognito JWT and read its site grants.
//
// WHY NO LIBRARY: Node 20's webcrypto/crypto can build a public key straight from a JWK and
// verify RS256, so the whole verifier is ~60 lines with no dependency to audit, no supply
// chain, and no bundle weight on a Lambda that shares a zip with the hot collector path.
//
// WHY OFFLINE: verification never calls Cognito (only the JWKS fetch does, and that is
// cached per cold start and keyed by `kid`). The request path therefore has no network
// dependency — a viewer's dashboard cannot be taken down by Cognito latency, and NOTHING
// phones home to us (DESIGN.md §6: "nothing reaches us" must stay literally true).
//
// ⚠ SECURITY: this file is the ONLY thing standing between a stranger and a company's
// traffic. Every claim below is checked because skipping any one of them is a known JWT
// break: unverified `alg` (alg=none / HS256-with-public-key confusion), unchecked `iss`
// (a token from someone else's pool), unchecked `aud`/`client_id` (a token minted for a
// different app), unchecked `exp` (a revoked viewer keeps access forever).

import { createPublicKey, createVerify } from "node:crypto";

/** A JSON Web Key as Cognito publishes it at /.well-known/jwks.json. */
export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

/** The claims we rely on. Cognito sends many more; we deliberately ignore them. */
export interface ViewerClaims {
  sub: string;
  email?: string;
  /** Cognito group memberships — this is where per-site grants live (§7b). */
  groups: string[];
  exp: number;
  tokenUse: string;
}

export class AuthError extends Error {}

function b64urlToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AuthError("malformed token");
  }
}

export interface VerifyOptions {
  jwks: Jwk[];
  /** Expected issuer: https://cognito-idp.<region>.amazonaws.com/<poolId> */
  issuer: string;
  /** The SPA's app-client id — a token minted for another client must not work here. */
  clientId: string;
  /** Epoch seconds; injectable so expiry is testable without waiting. */
  now: number;
  /** Small tolerance for clock skew between Cognito and Lambda. */
  clockSkewSec?: number;
}

/**
 * Verify a Cognito ID/access token and return its claims. Throws AuthError on ANY problem —
 * callers must treat a throw as 401 and must never fall back to "unauthenticated but allowed".
 */
export function verifyJwt(token: string, opts: VerifyOptions): ViewerClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64);
  // Pin the algorithm. Accepting whatever the token asks for is the classic JWT break:
  // `alg: "none"` forges anything, and `alg: "HS256"` invites verifying an RSA public key
  // as an HMAC secret — the public key is, by definition, public.
  if (header.alg !== "RS256") throw new AuthError("unsupported token algorithm");
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) throw new AuthError("token has no key id");

  const jwk = opts.jwks.find((k) => k.kid === kid);
  if (!jwk) throw new AuthError("unknown signing key");
  if (jwk.kty !== "RSA") throw new AuthError("unsupported key type");

  const key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(key, b64urlToBuffer(signatureB64))) throw new AuthError("bad signature");

  const claims = decodeJson(payloadB64);
  const skew = opts.clockSkewSec ?? 60;

  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (!exp || exp + skew < opts.now) throw new AuthError("token expired");
  const nbf = typeof claims.nbf === "number" ? claims.nbf : undefined;
  if (nbf !== undefined && nbf - skew > opts.now) throw new AuthError("token not yet valid");

  if (claims.iss !== opts.issuer) throw new AuthError("wrong issuer");

  // ID tokens carry `aud`; access tokens carry `client_id`. Accept either, but the value
  // must be OUR client — otherwise a token minted for a different app in the same pool
  // would be accepted.
  const tokenUse = typeof claims.token_use === "string" ? claims.token_use : "";
  const audience = tokenUse === "access" ? claims.client_id : claims.aud;
  if (audience !== opts.clientId) throw new AuthError("wrong audience");
  if (tokenUse !== "id" && tokenUse !== "access") throw new AuthError("unexpected token use");

  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [];

  return {
    sub: typeof claims.sub === "string" ? claims.sub : "",
    email: typeof claims.email === "string" ? claims.email : undefined,
    groups,
    exp,
    tokenUse,
  };
}

/** The group naming scheme for per-site grants (§7b). */
export const ALL_SITES_GROUP = "all-sites";
export const siteGroup = (siteId: string) => `site:${siteId}`;

/**
 * May this caller read this site? Enforced SERVER-SIDE from verified claims only — never
 * from anything the client sends. (MailPoppy's tenant-isolation lesson, CLAUDE.md §4:
 * client-side filtering is not access control.)
 */
export function mayReadSite(claims: ViewerClaims, siteId: string): boolean {
  if (claims.groups.includes(ALL_SITES_GROUP)) return true;
  return claims.groups.includes(siteGroup(siteId));
}

/** The subset of sites a caller may see. An agency's client A never learns B exists. */
export function visibleSites<T extends { id: string }>(claims: ViewerClaims, sites: T[]): T[] {
  if (claims.groups.includes(ALL_SITES_GROUP)) return sites;
  return sites.filter((s) => claims.groups.includes(siteGroup(s.id)));
}

/** Pull the bearer token out of an Authorization header, if present and well-formed. */
export function bearerToken(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : undefined;
}
