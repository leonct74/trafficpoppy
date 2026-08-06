// The shapes the backend returns. Mirrors backend/src/stack.ts — the sidecar is a
// separate process, so this is a wire contract, not a shared type.

export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** Raw CloudFormation status — for the technical details disclosure only. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  /** AWS is still working: keep polling (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence, already written for the user by the backend. */
  message?: string;
  /** The raw CloudFormation reason for a failure — shown in Technical details. */
  failureReason?: string;
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  updateAvailable: boolean;
  /** The collector endpoint once the stack is up — the tracking script's origin. */
  collectorUrl?: string;
  /** The team dashboard URL (§7b). Absent on a deployment from before P6a. */
  viewerUrl?: string;
  /** The Cognito pool holding viewer accounts. Absent ⇒ team access needs a stack update. */
  viewerUserPoolId?: string;
}

export interface Meta {
  account: { accountId: string; region: string };
  connectionId: string;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
  /** The §6b recognition window in days (1–7). Absent ⇒ 1 (the strict default). */
  saltDays?: number;
  /** The site's conversion goals (§7e). */
  goals?: Goal[];
}

/** A conversion goal. The definition itself lives in shared/src/goals.ts. */
export type { Goal, GoalKind } from "../../shared/src/goals";
import type { Goal } from "../../shared/src/goals";

/** One goal's numbers for the picked range — mirrors GoalStats in shared/src/range.ts. */
export interface GoalStats {
  name: string;
  kind: "page" | "event";
  path?: string;
  createdAt?: string;
  conversions: number;
  /** Distinct visitors who converted, within the site's recognition window. */
  converters: number;
  prevConversions: number;
}

/** The dashboard's range read. Mirrors RangeStats in backend/src/sites.ts. */
export interface RangeStats {
  siteId: string;
  from: string;
  to: string;
  /** Per-day series, oldest first. */
  days: { day: string; views: number; uniques: number }[];
  views: number;
  /** Sum of DAILY uniques — cross-day identity cannot exist (the salt is destroyed daily). */
  uniques: number;
  topPages: { key: string; count: number }[];
  topReferrers: { key: string; count: number }[];
  browsers: { key: string; count: number }[];
  os: { key: string; count: number }[];
  sizes: { key: string; count: number }[];
  /** The allowlisted utm params — the whole marketing-attribution surface. */
  utmSources: { key: string; count: number }[];
  utmCampaigns: { key: string; count: number }[];
  utmMediums: { key: string; count: number }[];
  /** Country-level geography (True Reach tier) — empty on the free Function-URL path. */
  countries: { key: string; count: number }[];
  /** Views per UTC hour-of-day, 24 buckets (index = hour). */
  hours: number[];
  /** Of the range's daily uniques: first-seen vs seen-earlier within the §6b window. */
  newVisitors: number;
  returningVisitors: number;
  /** Conversion goals (§7e) — empty unless the site has any (absent on older sidecars). */
  goals?: GoalStats[];
  /** Traffic flow (§7d) — aggregate counts only, never individual visitors. */
  entries: { source: string; path: string; count: number }[];
  edges: { from: string; to: string; count: number }[];
  /** The immediately-preceding window of the same length — for Δ% and top movers. */
  prev?: {
    views: number;
    uniques: number;
    topPages: { key: string; count: number }[];
    topReferrers: { key: string; count: number }[];
  };
  receiving: boolean;
}

/** A DNS record the owner must create at their DNS host. Mirrors backend/src/edge.ts. */
export interface DnsRecord {
  purpose: "certificate-validation" | "point-your-domain";
  name: string;
  type: string;
  value: string;
}

/** The True Reach edge deployment's live state. Mirrors backend/src/edge.ts. */
export interface EdgeStatus {
  phase: "none" | "validating" | "deploying" | "ready" | "removing" | "failed";
  stackStatus?: string;
  domain?: string;
  records: DnsRecord[];
  distributionDomain?: string;
  inProgress: boolean;
  failureReason?: string;
  /** The deployed edge is behind this build — the owner applies it with a click. */
  updateAvailable?: boolean;
  /** Browsing https://<domain>/ serves the statistics page (not just beacons). */
  viewerAtEdge?: boolean;
}

/** The live-ticker read: views per minute over the last half hour, oldest first. */
export interface LiveStats {
  siteId: string;
  minutes: { minute: string; views: number }[];
  views: number;
}

export interface SiteStats {
  siteId: string;
  day: string;
  views: number;
  uniques: number;
  topPages: { key: string; count: number }[];
  topReferrers: { key: string; count: number }[];
  browsers: { key: string; count: number }[];
  receiving: boolean;
}

/** A team member who can open the browser dashboard (DESIGN.md §7b). */
export interface Viewer {
  email: string;
  /** Cognito account state — FORCE_CHANGE_PASSWORD until they accept the invite. */
  status: string;
  allSites: boolean;
  siteIds: string[];
  createdAt?: string;
}
