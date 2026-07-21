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
  receiving: boolean;
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
