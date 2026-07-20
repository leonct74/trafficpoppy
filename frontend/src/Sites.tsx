import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import type { Site, SiteStats } from "./types";

/**
 * The Sites screen (DESIGN.md §7.1): add a site → get the one-line snippet with a copy
 * button → see whether data is arriving. `collectorUrl` is the deployed Function URL — the
 * origin baked into every snippet.
 */
export function Sites(props: { collectorUrl: string }) {
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
            <SiteRow key={s.id} site={s} collectorUrl={props.collectorUrl} onRemoved={load} />
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

function SiteRow(props: { site: Site; collectorUrl: string; onRemoved: () => void }) {
  const { site, collectorUrl } = props;
  const origin = collectorUrl.replace(/\/+$/, "");
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
          {site.domain && <span className="muted mono" style={{ fontSize: 12 }}>{site.domain}</span>}
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
      </div>

      {stats && stats.receiving && (
        <div className="row" style={{ gap: 20 }}>
          <Metric label="Views today" value={stats.views} />
          <Metric label="Unique visitors" value={stats.uniques} />
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
