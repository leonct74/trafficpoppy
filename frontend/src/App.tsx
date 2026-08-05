import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Backup } from "./Backup";
import { Button } from "./Button";
import { Dashboard } from "./Dashboard";
import { Integrate } from "./Integrate";
import { host, type AccessState } from "./host";
import { RemovePanel } from "./RemovePanel";
import { Sites } from "./Sites";
import { TrueReach } from "./TrueReach";
import { Viewers } from "./Viewers";
import type { DeploymentStatus, EdgeStatus, Meta, Site } from "./types";

// Served from frontend/public → dist root; the same file the manifest declares as our icon.
const icon = "./trafficpoppy-icon.png";

const POLL_MS = 5_000;

type Phase = "loading" | "gate" | "ready";

/**
 * The ready screen's sections. Founder feedback (2026-08-04): with several sites
 * configured, extra cards ended up below the fold and were effectively invisible — tabs
 * make every section one visible click away (the "visible navigation" rule). Team access
 * is its OWN tab again (a brief merge into Advanced stats was reverted: granting people
 * all-domain access inside the purchase surface muddled both) — it sits to the RIGHT of
 * Advanced stats and stays LOCKED until a subscription exists; pressing it while locked
 * explains why in a modal instead of silently doing nothing. Inactive panels stay
 * MOUNTED: the edge polling feeds the per-site snippet origins, and unmounting it would
 * freeze a DNS-validation flow the moment the user peeked at another tab.
 */
const SECTIONS = [
  { key: "sites", label: "Your sites" },
  { key: "advanced", label: "Advanced stats" },
  { key: "team", label: "Team access" },
  { key: "backup", label: "Back up" },
  // Founder feedback 2026-08-05: removal sat under whatever tab was open and was hard to
  // find. Its own tab — and deliberately NOT locked: "you can always remove everything"
  // is a platform promise, so it must stay reachable on the free tier too.
  { key: "remove", label: "Remove" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

/** Tabs that need an active Advanced Stats domain, with what the lock modal says. */
const LOCKED_TABS: Partial<Record<SectionKey, { title: string; body: string }>> = {
  team: {
    title: "To set up a team, Advanced Stats must be activated.",
    body:
      "Team access lets people open your statistics from any browser — and that page is part of " +
      "the Advanced Stats upgrade. Set up a domain in the Advanced stats tab first, then invite " +
      "your team here.",
  },
  // Founder decision 2026-08-05: Back up & restore is part of the paid tier (supersedes
  // the §12 "free teardown export" line — recorded in DESIGN.md).
  backup: {
    title: "To back up and restore statistics, Advanced Stats must be activated.",
    body:
      "Backups save your sites and every collected number to a file, so they survive a full " +
      "removal and return after a fresh setup. It's part of the Advanced Stats upgrade — unlock " +
      "a site in the Advanced stats tab first.",
  },
};

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [access, setAccess] = useState<AccessState>("pending");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  /** The site whose dashboard is open; null = the sites list. */
  const [openSite, setOpenSite] = useState<Site | null>(null);
  /** Within an open site: the Integrate (use-your-data) screen instead of the dashboard. */
  const [integrating, setIntegrating] = useState(false);
  /** The True Reach edges (one per domain) — ready ones serve snippets first-party. */
  const [edgeState, setEdgeState] = useState<EdgeStatus[]>([]);
  const [section, setSection] = useState<SectionKey>("sites");
  /** Which locked tab's "needs Advanced Stats" modal is open (null = none). */
  const [lockedTab, setLockedTab] = useState<SectionKey | null>(null);
  /** Advanced Stats is live on at least one domain — unlocks the Team access tab. */
  const onlineActive = edgeState.some((e) => e.phase === "ready");
  const pollRef = useRef<number | null>(null);

  /**
   * Read the real state out of the user's AWS account. This is the ONLY source of truth
   * for where the user is (AGENTS.md §5) — nothing is remembered across mounts, so
   * closing the window mid-setup and coming back lands on live progress.
   */
  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setErr(null);
      return s;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, []);

  const connect = useCallback(async () => {
    setErr(null);
    try {
      const state = await host.ensureAccess();
      setAccess(state);
      if (state !== "granted") return;
      setMeta(await api.meta());
      await refresh();
      setPhase("ready");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [refresh]);

  // On mount: if access is already granted, go straight to live state — don't make the
  // user re-approve or re-trigger anything they already did.
  useEffect(() => {
    void (async () => {
      try {
        const conn = await host.getConnection();
        if (conn.status === "approved" || conn.status === "active") {
          await connect();
          return;
        }
      } catch {
        /* not connected yet — fall through to the gate */
      }
      setPhase("gate");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll only while AWS is actually mid-operation, and re-attach automatically on mount
  // if we return to find work still in flight.
  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (phase !== "ready" || !status?.inProgress) return;
    pollRef.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [phase, status?.inProgress, refresh]);

  // Returns the promise so the Button that triggered it stays spinning until AWS has
  // accepted the request and we've read back the (now in-progress) live state.
  const deploy = async () => {
    setErr(null);
    try {
      await api.deploy();
      await refresh(); // picks up *_IN_PROGRESS, which starts the poller
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (phase === "loading") {
    return (
      <div className="app">
        <Header />
        <div className="card row">
          <span className="spinner" /> <span className="muted">Checking your setup…</span>
        </div>
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="app">
        <Header />
        <div className="card stack">
          <p style={{ margin: 0 }}>
            TrafficPoppy keeps your website statistics in <strong>your own AWS account</strong> — nobody else,
            including us, can see them. To set that up, it needs your permission to create its own storage
            there.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            It can only ever touch the things it creates itself, and you can remove all of them in one click.
          </p>
          {access === "denied" && (
            <div className="banner err">
              Access wasn't granted. You can approve TrafficPoppy in AgentsPoppy and try again.
            </div>
          )}
          {err && <div className="banner err">{err}</div>}
          <div>
            <Button className="btn btn-primary" busyLabel="Waiting for approval…" onClick={connect}>
              Connect my AWS account
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const phaseKey = status?.phase ?? "none";

  return (
    <div className="app">
      <Header />

      {err && <div className="banner err" style={{ marginBottom: 14 }}>{err}</div>}

      {phaseKey === "none" && (
        <div className="card stack">
          <h2 className="section-title">Set up TrafficPoppy</h2>
          <p style={{ margin: 0 }}>
            One click creates the storage your website statistics will live in, inside your own AWS account
            in <strong>{meta?.account.region}</strong>. It takes about a minute.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Nothing is running yet, so nothing is being billed.
          </p>
          <div>
            <Button className="btn btn-primary" busyLabel="Starting…" onClick={deploy}>
              Set up TrafficPoppy
            </Button>
          </div>
        </div>
      )}

      {(phaseKey === "deploying" || phaseKey === "removing") && (
        <div className="card stack">
          <div className="row">
            <span className="spinner" />
            <strong>{phaseKey === "deploying" ? "Setting up in your AWS account…" : "Removing everything…"}</strong>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            This keeps running in your AWS account even if you close this tab or switch to something else —
            come back any time and you'll see where it got to.
          </p>
        </div>
      )}

      {phaseKey === "ready" && openSite && integrating && (
        <Integrate
          site={openSite}
          region={status?.region ?? ""}
          tableName={status?.tableName ?? "TrafficPoppyData"}
          onBack={() => setIntegrating(false)}
        />
      )}

      {phaseKey === "ready" && openSite && !integrating && (
        <Dashboard
          site={openSite}
          onBack={() => {
            setOpenSite(null);
            setIntegrating(false); // never re-enter another site's view mid-Integrate
          }}
          onIntegrate={() => setIntegrating(true)}
        />
      )}

      {phaseKey === "ready" && !openSite && (
        <>
          <div className="card stack">
            <div className="spread">
              <strong>TrafficPoppy is set up</strong>
              <span className="badge ok">
                <span className="dot" /> Ready
              </span>
            </div>
            <div className="banner info">
              <strong>Running in your own AWS in {status?.region}.</strong> Serverless, so you're billed only
              for what you actually collect — cents a month at typical traffic, nothing when nobody visits.
            </div>

            {/* A newer version of TrafficPoppy ships changes the deployed stack doesn't have
                yet. The backend has reported this since P1 (`updateAvailable`) but nothing
                rendered it, so the only way to notice was the technical details panel —
                which meant new features looked broken rather than pending. */}
            {status?.updateAvailable && (
              <div className="banner info stack" style={{ gap: 10 }}>
                <div>
                  <strong>An update is ready for your AWS setup.</strong> This version of TrafficPoppy adds
                  things your deployment doesn't have yet. Your data and your tracking snippets are
                  untouched — collection keeps running while it applies.
                </div>
                <div>
                  <Button className="btn btn-primary btn-sm" busyLabel="Updating…" onClick={deploy}>
                    Update now
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="tabs" role="tablist" aria-label="TrafficPoppy sections" style={{ marginBottom: 14 }}>
            {SECTIONS.map((s) => {
              // Paid tabs are locked until Advanced Stats is active — but each tab stays
              // pressable so the lock can EXPLAIN itself (a dead control reads as broken).
              const locked = s.key in LOCKED_TABS && !onlineActive;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={section === s.key}
                  aria-disabled={locked || undefined}
                  className={`tab${section === s.key ? " active" : ""}`}
                  style={locked ? { opacity: 0.45 } : undefined}
                  title={locked ? "Requires Advanced Stats" : undefined}
                  onClick={() => (locked ? setLockedTab(s.key) : setSection(s.key))}
                >
                  {s.label}
                  {locked ? " 🔒" : ""}
                </button>
              );
            })}
          </div>

          {lockedTab && LOCKED_TABS[lockedTab] && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Requires Advanced Stats"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 40,
              }}
              onClick={() => setLockedTab(null)}
            >
              <div className="card stack" style={{ maxWidth: 400, margin: 16 }} onClick={(e) => e.stopPropagation()}>
                <strong>{LOCKED_TABS[lockedTab]!.title}</strong>
                <p className="muted" style={{ margin: 0 }}>
                  {LOCKED_TABS[lockedTab]!.body}
                </p>
                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setLockedTab(null);
                      setSection("advanced");
                    }}
                  >
                    Open Advanced stats
                  </button>
                  <button className="btn" onClick={() => setLockedTab(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          <div hidden={section !== "sites"}>
            {status?.collectorUrl && (
              <Sites
                // Every site's snippet defaults to the AWS Function URL. True Reach is
                // per-domain: a custom subdomain (stats.ollydigital.com) is first-party for
                // ONLY its own registrable domain, so Sites applies it per-site — never as a
                // blanket origin for every site (that would point one site at another's domain).
                collectorUrl={status.collectorUrl}
                trueReachDomains={edgeState
                  .filter((e) => e.phase === "ready" && e.domain)
                  .map((e) => e.domain!)}
                onOpen={setOpenSite}
              />
            )}
          </div>
          <div hidden={section !== "backup"}>
            {/* Paid tier (founder decision 2026-08-05) — the tab is locked without an
                active domain, and the panel double-checks so a stale section state can
                never render the tools unpaid. */}
            {onlineActive && (
              <Backup
                onlineDomains={edgeState.filter((e) => e.phase === "ready" && e.domain).map((e) => e.domain!)}
              />
            )}
          </div>
          <div hidden={section !== "remove"}>
            {status && status.phase !== "none" && (
              <RemovePanel
                disabled={status.inProgress}
                onRemove={async () => {
                  await api.teardown();
                  await refresh();
                }}
              />
            )}
          </div>
          <div hidden={section !== "advanced"}>
            <TrueReach onStatus={setEdgeState} />
          </div>
          <div hidden={section !== "team"}>
            <Viewers
              // The Advanced Stats gate: hand out a link only when the paid tier exists.
              // Prefer the memorable address; the raw AWS URL only bridges an edge that
              // hasn't taken the viewer-routing update yet. No edge ⇒ no link (the panel
              // explains the upgrade instead).
              viewerUrl={(() => {
                const pretty = edgeState.find((e) => e.viewerAtEdge && e.domain);
                if (pretty) return `https://${pretty.domain}/`;
                return onlineActive ? status?.viewerUrl : undefined;
              })()}
              canManage={!!status?.viewerUserPoolId}
              onlineActive={onlineActive}
              onlineDomains={edgeState.filter((e) => e.phase === "ready" && e.domain).map((e) => e.domain!)}
            />
          </div>
        </>
      )}

      {phaseKey === "failed" && (
        <div className="card stack">
          <div className="banner err">{status?.message}</div>
          {status?.failureReason && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              What AWS reported: <span className="mono">{status.failureReason}</span>
            </p>
          )}
          <div>
            <Button className="btn btn-primary" busyLabel="Starting…" onClick={deploy}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {/* Layer the depth: plain path above, exact technical detail one click away
          (AGENTS.md §9 "relocate technical detail, don't delete it"). */}
      <button className="btn btn-ghost btn-sm" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? "Hide technical details" : "Technical details"}
      </button>
      {showDetails && status && (
        <div className="card card-2" style={{ marginTop: 8 }}>
          <dl className="stack" style={{ margin: 0 }}>
            <Detail label="AWS account" value={meta?.account.accountId} />
            <Detail label="Region" value={status.region} />
            <Detail label="CloudFormation stack" value={status.stackName} />
            <Detail label="Stack status" value={status.stackStatus ?? "not deployed"} />
            <Detail label="DynamoDB table" value={status.tableName ?? "—"} />
            <Detail label="Template version" value={status.currentTemplateKey} />
            {status.updateAvailable && <Detail label="Deployed version" value={status.deployedTemplateKey} />}
          </dl>
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <>
      <div className="app-header">
        <img src={icon} alt="" />
        <h1>TrafficPoppy</h1>
      </div>
      <p className="app-sub">Website statistics that stay in your own AWS account. No cookies, no banners.</p>
    </>
  );
}

function Detail(props: { label: string; value?: string }) {
  return (
    <div className="spread">
      <span className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </span>
      <span className="chip">{props.value ?? "—"}</span>
    </div>
  );
}
