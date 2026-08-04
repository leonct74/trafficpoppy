/**
 * Does `edgeDomain` (e.g. stats.ollydigital.com) belong to a site whose own address is
 * `siteDomain` (e.g. ollydigital.com)? True only when the edge domain IS, or is a
 * subdomain of, the site's registrable domain — never across two different domains.
 *
 * SHARED because two enforcement points must agree exactly: the frontend picks which
 * snippet origin a site gets, and the viewer Lambda decides which sites are visible
 * online at all (the Online Dashboard gate, founder decision 2026-08-04). If these
 * drifted, a site could be billed under one rule and served under another.
 */
export function isFirstPartyFor(siteDomain: string | undefined, edgeDomain: string): boolean {
  if (!siteDomain) return false;
  const site = siteDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/:].*$/, "");
  if (!site) return false;
  const edge = edgeDomain.trim().toLowerCase();
  return edge === site || edge.endsWith(`.${site}`);
}
