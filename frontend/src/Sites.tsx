import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton, copyText } from "./CopyButton";
import { SITE_FIELDS, SNIPPET_STEP, TRUE_REACH, buildSnippet } from "./catalogue";
import { buildHelperPrompt } from "./helper-prompt";
import type { Site, SiteStats } from "./types";

// The matcher lives in shared/ — the viewer Lambda enforces the Online Dashboard gate
// with the SAME rule that picks a site's snippet origin here. Re-exported so existing
// imports and tests keep working.
export { isFirstPartyFor } from "../../shared/src/first-party";
import { isFirstPartyFor } from "../../shared/src/first-party";

/**
 * The Sites screen (DESIGN.md §7.1): add a site → get the one-line snippet with a copy
 * button → see whether data is arriving. `collectorUrl` is the deployed AWS Function URL —
 * the free-tier origin. `trueReachDomains` are the LIVE True Reach custom subdomains
 * (multi-domain since 2026-08-04); each is applied per-site, only to the site it's
 * actually first-party for.
 */
export function Sites(props: { collectorUrl: string; trueReachDomains?: string[]; onOpen?: (site: Site) => void }) {
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
              trueReachDomains={props.trueReachDomains}
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

        <HelperPromptBanner collectorUrl={props.collectorUrl} trueReachDomain={props.trueReachDomains?.[0]} />

        {/* Labels and placeholders come from SITE_FIELDS so the helper prompt describes
            exactly these fields, in exactly these words (AGENTS.md §9, rule 1). */}
        <div className="grid-2">
          {SITE_FIELDS.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              <input
                className="input"
                value={f.key === "name" ? name : domain}
                onChange={(e) => (f.key === "name" ? setName : setDomain)(e.target.value)}
                placeholder={f.placeholder}
                autoCapitalize={f.key === "domain" ? "off" : undefined}
                spellCheck={f.key === "domain" ? false : undefined}
              />
            </label>
          ))}
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

/**
 * "Copy the helper prompt" — the banner variant (AGENTS.md §9, REQUIRED on the primary
 * creation surface). The prompt is TrafficPoppy's onboarding, packaged: paste it into any AI,
 * say what you want to measure, get back what to type here and where to paste the snippet.
 * Pulses until it's first used — an invitation, not an alarm; the kit's class holds still for
 * anyone who asked their OS for reduced motion.
 */
function HelperPromptBanner(props: { collectorUrl: string; trueReachDomain?: string }) {
  const [copied, setCopied] = useState(false);
  const [used, setUsed] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    const ok = await copyText(buildHelperPrompt(props));
    setUsed(true);
    setFailed(!ok);
    setCopied(ok);
    window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2500);
  };

  return (
    <div className="banner info">
      <div className="spread">
        <span>
          <strong>Not sure what to put here?</strong> Copy the helper prompt, paste it into any AI you use (Claude,
          ChatGPT…), and say what you want to know about your visitors — it answers with everything to fill in
          below, where to paste the snippet, and what TrafficPoppy will never collect.
        </span>
        <Button className={`btn btn-primary${used ? "" : " poppy-helper-pulse"}`} onClick={copy}>
          {copied ? "Copied ✓" : failed ? "Select & copy manually" : "✨ Copy the helper prompt"}
        </Button>
      </div>
    </div>
  );
}

function SiteRow(props: {
  site: Site;
  collectorUrl: string;
  trueReachDomains?: string[];
  onRemoved: () => void;
  onOpen?: (site: Site) => void;
}) {
  const { site, collectorUrl } = props;
  const domains = props.trueReachDomains ?? [];
  // First-party only when a True Reach subdomain belongs to THIS site's domain.
  const trueReachDomain = domains.find((d) => isFirstPartyFor(site.domain, d));
  const firstParty = !!trueReachDomain;
  // True Reach edges exist, but none for this site's domain → upsell hint.
  const canUpsell = domains.length > 0 && !firstParty;
  const snippet = buildSnippet(firstParty ? `https://${trueReachDomain}` : collectorUrl, site.id);
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
              Online Dashboard
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
          {SNIPPET_STEP.title}
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
            {TRUE_REACH.freeTierNote} Set up the Online Dashboard on a subdomain of{" "}
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
