// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes through the bridge.

import { host } from "./host";
import type { DeploymentStatus, EdgeStatus, LiveStats, Meta, RangeStats, Site, SiteStats, Viewer } from "./types";

export const api = {
  meta: (): Promise<Meta> => host.invokeBackend({ method: "GET", path: "/meta" }),

  /** The live deployment state, read from CloudFormation on every call. */
  status: (): Promise<DeploymentStatus> => host.invokeBackend({ method: "GET", path: "/status" }),

  /** Kicks off the deploy; AWS carries on with it in the background. */
  deploy: (): Promise<{ operation: string; stackName: string }> =>
    host.invokeBackend({ method: "POST", path: "/deploy" }),

  /** Removes everything TrafficPoppy created. Waits for AWS to finish. */
  teardown: (): Promise<{ ok: true; removed: string[] }> =>
    host.invokeBackend({ method: "POST", path: "/teardown" }, 15 * 60_000),

  listSites: (): Promise<{ sites: Site[] }> => host.invokeBackend({ method: "GET", path: "/sites" }),

  addSite: (name: string, domain: string): Promise<{ site: Site }> =>
    host.invokeBackend({ method: "POST", path: "/sites", body: { name, domain } }),

  removeSite: (id: string): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "DELETE", path: `/sites/${encodeURIComponent(id)}` }),

  siteStats: (id: string): Promise<{ stats: SiteStats }> =>
    host.invokeBackend({ method: "GET", path: `/sites/${encodeURIComponent(id)}/stats` }),

  /** The dashboard's range read: last `days` UTC days, aggregated server-side. */
  rangeStats: (id: string, days: number): Promise<{ range: RangeStats }> =>
    host.invokeBackend({ method: "GET", path: `/sites/${encodeURIComponent(id)}/range?days=${days}` }),

  /** The last-30-minutes ticker. */
  liveStats: (id: string): Promise<{ live: LiveStats }> =>
    host.invokeBackend({ method: "GET", path: `/sites/${encodeURIComponent(id)}/live` }),

  /** Viewer accounts (§7b): who on the team can open the browser dashboard. */
  listViewers: (): Promise<{ viewers: Viewer[] }> => host.invokeBackend({ method: "GET", path: "/viewers" }),
  inviteViewer: (email: string, grants: { allSites: boolean; siteIds: string[] }): Promise<{ viewer: Viewer }> =>
    host.invokeBackend({ method: "POST", path: "/viewers", body: { email, ...grants } }),
  setViewerGrants: (email: string, grants: { allSites: boolean; siteIds: string[] }): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "PUT", path: `/viewers/${encodeURIComponent(email)}`, body: grants }),
  removeViewer: (email: string): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "DELETE", path: `/viewers/${encodeURIComponent(email)}` }),

  /** §6b: the site's returning-visitor recognition window (1–7 days, server-clamped). */
  updateSiteSettings: (id: string, settings: { saltDays: number }): Promise<{ saltDays: number }> =>
    host.invokeBackend({ method: "PUT", path: `/sites/${encodeURIComponent(id)}/settings`, body: settings }),

  /** Back up & restore: statistics to/from a local JSON file (sidecar writes it —
   *  sandboxed frontends cannot download). Scanning a big table can take a while. */
  backup: (): Promise<{
    path: string;
    rows: number;
    sites: number;
    counters: number;
    skippedSites: string[];
  }> =>
    host.invokeBackend({ method: "POST", path: "/backup" }, 5 * 60_000),
  listBackups: (): Promise<{ backups: { path: string; date: string; bytes: number }[] }> =>
    host.invokeBackend({ method: "GET", path: "/backups" }),
  restore: (path: string): Promise<{ restored: number }> =>
    host.invokeBackend({ method: "POST", path: "/restore", body: { path } }, 15 * 60_000),

  /** True Reach (custom domains, one small stack each): live state, add, remove, update. */
  edgeStatus: (): Promise<{ edges: EdgeStatus[] }> => host.invokeBackend({ method: "GET", path: "/truereach" }),
  edgeDeploy: (domain: string): Promise<{ operation: string }> =>
    host.invokeBackend({ method: "POST", path: "/truereach", body: { domain } }),
  edgeRemove: (domain: string): Promise<{ removed: string[] }> =>
    host.invokeBackend({ method: "DELETE", path: `/truereach/${encodeURIComponent(domain)}` }),
  /** Apply one domain's pending True Reach update (e.g. put the statistics page on it). */
  edgeUpdate: (domain: string): Promise<{ edges: EdgeStatus[] }> =>
    host.invokeBackend({ method: "POST", path: "/truereach/update", body: { domain } }),
};
