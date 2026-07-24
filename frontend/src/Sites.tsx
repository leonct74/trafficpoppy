import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import type { Site, SiteStats } from "./types";

/**
 * Does `edgeDomain` (e.g. stats.ollydigital.com) collect first-party for a site whose own
 * address is `siteDomain` (e.g. ollydigital.com)? True only when the edge domain IS, or is a
 * subdomain of, the site's registrable domain — never across two different domains. This is
 * what keeps True Reach per-site: one custom subdomain can't be first-party for every site.
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

/**
 * The Sites screen (DESIGN.md §7.1): add a site → get the one-line snippet with a copy
 * button → see whether data is arriving. `collectorUrl` is the deployed AWS Function URL —
 * the free-tier origin. `trueReachDomain`, when set, is the live True Reach custom subdomain;
 * it's applied per-site, only to the site it's actually first-party for.
 */
export function Sites(props: { collectorUrl: string; trueReachDomain?: string; onOpen?: (site: Site) => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");

  const load = useCallback(async () => {
    try {
      setSites((await api.listSites()).sites);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setErr(null);
    try {
      await api.addSite(name, domain);
      setName("");
      setDomain("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card stack">
      <h2 className="section-title">Your sites</h2>

      {err && <div className="banner err">{err}</div>}

      {sites === null ? (
        <div className="row">
          <span className="spinner" /> <span className="muted">Loading your sites…</span>
        </div>
      ) : sites.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Add the first website you want to measure. You'll get a one-line snippet to paste into its pages.
        </p>
      ) : (
        <div className="stack">
          {sites.map((s) => (
            <SiteRow
              key={s.id}
              site={s}
              collectorUrl={props.collectorUrl}
              trueReachDomain={props.trueReachDomain}
              onRemoved={load}
              onOpen={props.onOpen}
            />
          ))}
        </div>
      )}

      <div className="card card-2 stack" style={{ marginBottom: 0 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Add a site
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Olly Digital" />
          </label>
          <label className="field">
            <span>Website address</span>
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="ollydigital.com"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div>
          <Button className="btn btn-primary" busyLabel="Adding…" disabled={!name.trim()} onClick={add}>
            Add site
          </Button>
        </div>
      </div>
    </div>
  );
}

function SiteRow(props: {
  site: Site;
  collectorUrl: string;
  trueReachDomain?: string;
  onRemoved: () => void;
  onOpen?: (site: Site) => void;
}) {
  const { site, collectorUrl, trueReachDomain } = props;
  // First-party only when the True Reach subdomain belongs to THIS site's domain.
  const firstParty = !!trueReachDomain && isFirstPartyFor(site.domain, trueReachDomain);
  // A True Reach edge exists, but for a different domain than this site → upsell hint.
  const canUpsell = !!trueReachDomain && !firstParty;
  const origin = (firstParty ? `https://${trueReachDomain}` : collectorUrl).replace(/\/+$/, "");
  const snippet = `<script defer src="${origin}/t.js" data-site="${site.id}"></script>`;
  const [stats, setStats] = useState<SiteStats | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Poll the receiving-state so the user watches the first hit land in real time.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const { stats: s } = await api.siteStats(site.id);
        if (live) setStats(s);
      } catch {
        /* transient — keep the last value */
      }
    };
    void tick();
    const t = window.setInterval(tick, 10_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [site.id]);

  return (
    <div className="card card-2 stack">
      <div className="spread">
        <div>
          <strong>{site.name}</strong>{" "}
          {site.domain && <span className="muted mono" style={{ fontSize: 12 }}>{site.domain}</span>}{" "}
          {firstParty && (
            <span className="badge ok" title={`First-party via ${trueReachDomain}`}>
              True Reach
            </span>
          )}
        </div>
        {stats?.receiving ? (
          <span className="badge ok">
            <span className="dot" /> Receiving data
          </span>
        ) : (
          <span className="badge">
            <span className="dot" /> Waiting for first visit
          </span>
        )}
      </div>

      <div>
        <div className="section-title" style={{ marginBottom: 6 }}>
          Paste this into your site's &lt;head&gt;
        </div>
        <div className="row" style={{ alignItems: "stretch" }}>
          <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap", padding: "8px 10px" }}>
            {snippet}
          </code>
          <CopyButton text={snippet} label="snippet" />
        </div>
        {firstParty ? (
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
            Served first-party from <span className="mono">{trueReachDomain}</span> — invisible to ad blockers, with
            country stats.
          </p>
        ) : canUpsell ? (
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
            Free tier — served from your AWS address. Set up True Reach on a subdomain of{" "}
            <span className="mono">{site.domain || "this site"}</span> for ad-blocker-immune collection and country
            stats.
          </p>
        ) : null}
      </div>

      {stats && stats.receiving && (
        <div className="spread">
          <div className="row" style={{ gap: 20 }}>
            <Metric label="Views today" value={stats.views} />
            <Metric label="Unique visitors" value={stats.uniques} />
          </div>
          {props.onOpen && (
            <button className="btn btn-primary btn-sm" onClick={() => props.onOpen?.(site)}>
              Open dashboard →
            </button>
          )}
        </div>
      )}

      <div className="spread">
        <span className="muted" style={{ fontSize: 12 }}>
          Site id <span className="mono">{site.id}</span>
        </span>
        {confirming ? (
          <span className="row">
            <span className="muted" style={{ fontSize: 12 }}>Remove this site?</span>
            <Button
              className="btn btn-danger btn-sm"
              busyLabel="Removing…"
              onClick={async () => {
                await api.removeSite(site.id);
                props.onRemoved();
              }}
            >
              Remove
            </Button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 650 }}>{props.value.toLocaleString()}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </div>
    </div>
  );
}
