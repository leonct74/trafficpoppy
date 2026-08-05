import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { isFirstPartyFor } from "../../shared/src/first-party";
import type { Site, Viewer } from "./types";

/**
 * The Viewers panel (DESIGN.md §7b) — who on the team can open the browser dashboard.
 *
 * The admin plane stays here in the poppy (it needs the AWS connection); viewers only ever
 * get the read-only browser dashboard. Accounts live in a Cognito pool in the owner's OWN
 * account, so no colleague's email or password ever reaches us.
 *
 * Grants are per-site so an agency can give each client exactly their own dashboard — the
 * viewer API enforces this server-side from the verified token, and hides everything else.
 */
export function Viewers(props: {
  viewerUrl?: string;
  canManage: boolean;
  /**
   * The Online Dashboard paywall (founder, 2026-08-04): inviting is pointless — and
   * misleading — while no domain has the tier, so the invite flow only exists once one
   * does. Existing viewers stay manageable either way: a lapsed subscription must never
   * lock the owner out of REMOVING people.
   */
  onlineActive?: boolean;
  /** The live Advanced Stats domains — used to mark which sites actually appear online. */
  onlineDomains?: string[];
}) {
  const [sites, setSites] = useState<Site[]>([]);
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [allSites, setAllSites] = useState(true);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [invited, setInvited] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ viewers: vs }, { sites: ss }] = await Promise.all([api.listViewers(), api.listSites()]);
      setViewers(vs);
      setSites(ss);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (props.canManage) void load();
  }, [load, props.canManage]);

  // Team access arrived in a later stack version — say so plainly instead of erroring.
  if (!props.canManage) {
    return (
      <div className="card stack">
        <h2 className="section-title" style={{ margin: 0 }}>
          Team access
        </h2>
        <p style={{ margin: 0 }}>
          Let colleagues see your numbers in a browser — no AgentsPoppy and no AWS access needed.{" "}
          <strong>Update your deployment</strong> to turn this on.
        </p>
      </div>
    );
  }

  const invite = async () => {
    setErr(null);
    setInvited(null);
    try {
      const { viewer } = await api.inviteViewer(email.trim(), { allSites, siteIds });
      setInvited(viewer.email);
      setEmail("");
      setSiteIds([]);
      setAllSites(true);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggleSite = (id: string) =>
    setSiteIds((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));

  // The SAME rule the viewer Lambda enforces server-side — the picker only explains it.
  const isOnline = (site: Site) => (props.onlineDomains ?? []).some((d) => isFirstPartyFor(site.domain, d));

  return (
    <div className="card stack">
      <div className="spread">
        <h2 className="section-title" style={{ margin: 0 }}>
          Team access
        </h2>
        {props.viewerUrl && (
          <span className="row" style={{ gap: 6 }}>
            <a className="btn btn-sm" href={props.viewerUrl} target="_blank" rel="noreferrer">
              Open dashboard ↗
            </a>
            <CopyButton text={props.viewerUrl} label="dashboard link" />
          </span>
        )}
      </div>

      {props.viewerUrl ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Everyone you invite signs in at the link above, from any browser or phone. They can only read — never
          change your sites, your AWS, or anything else. Their accounts live in your own AWS.
        </p>
      ) : (
        // The Online Dashboard gate (founder decision 2026-08-04): browser access is part
        // of the paid tier. Invites still work now — the dashboard lights up when a domain
        // is set up in the Online dashboard tab.
        <div className="banner info">
          The browser dashboard is part of the <strong>Advanced Stats</strong> upgrade. Set up a domain above
          and everyone you invite here can open the statistics from any browser or phone — sites without
          the upgrade stay visible in this app only.
        </div>
      )}

      {err && <div className="banner err">{err}</div>}
      {invited && (
        <div className="banner ok">
          Invited <strong>{invited}</strong>. AWS emails them a temporary password — they choose their own on first
          sign-in.
        </div>
      )}

      {viewers === null ? (
        <div className="row">
          <span className="spinner" /> <span className="muted">Loading your team…</span>
        </div>
      ) : viewers.length === 0 ? (
        props.onlineActive ? (
          <p className="muted" style={{ margin: 0 }}>
            Nobody has been invited yet.
          </p>
        ) : null
      ) : (
        <div className="stack">
          {viewers.map((v) => (
            <ViewerRow key={v.email} viewer={v} sites={sites} onChanged={load} isOnline={isOnline} />
          ))}
        </div>
      )}

      {/* Inviting exists only once the tier does — behind the paywall, an invite would
          activate accounts that can open nothing. Managing/removing above always works. */}
      {props.onlineActive && (
        <div className="card card-2 stack" style={{ marginBottom: 0 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Invite someone
          </div>
          <label className="field">
            <span>Their email</span>
            <input
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <SitePicker
            sites={sites}
            allSites={allSites}
            siteIds={siteIds}
            onAllSites={setAllSites}
            onToggle={toggleSite}
            isOnline={isOnline}
          />
          <div>
            <Button
              className="btn btn-primary"
              busyLabel="Inviting…"
              disabled={!email.trim() || (!allSites && siteIds.length === 0)}
              onClick={invite}
            >
              Send invite
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewerRow(props: {
  viewer: Viewer;
  sites: Site[];
  onChanged: () => void;
  isOnline?: (site: Site) => boolean;
}) {
  const { viewer, sites } = props;
  const [editing, setEditing] = useState(false);
  const [allSites, setAllSites] = useState(viewer.allSites);
  const [siteIds, setSiteIds] = useState<string[]>(viewer.siteIds);
  const [confirming, setConfirming] = useState(false);

  const nameOf = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const summary = viewer.allSites
    ? "All sites"
    : viewer.siteIds.length === 0
      ? "No sites yet"
      : viewer.siteIds.map(nameOf).join(", ");

  return (
    <div className="card card-2 stack" style={{ marginBottom: 0, gap: 8 }}>
      <div className="spread">
        <div>
          <strong>{viewer.email}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {summary}
          </div>
        </div>
        {viewer.status === "FORCE_CHANGE_PASSWORD" ? (
          <span className="badge" title="They haven't signed in yet">
            Invite sent
          </span>
        ) : (
          <span className="badge ok">
            <span className="dot" /> Active
          </span>
        )}
      </div>

      {editing && (
        <>
          <SitePicker
            sites={sites}
            allSites={allSites}
            siteIds={siteIds}
            onAllSites={setAllSites}
            isOnline={props.isOnline}
            onToggle={(id) => setSiteIds((c) => (c.includes(id) ? c.filter((s) => s !== id) : [...c, id]))}
          />
          <div className="row">
            <Button
              className="btn btn-primary btn-sm"
              busyLabel="Saving…"
              onClick={async () => {
                await api.setViewerGrants(viewer.email, { allSites, siteIds });
                setEditing(false);
                props.onChanged();
              }}
            >
              Save access
            </Button>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {!editing && (
        <div className="spread">
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            Change access
          </button>
          {confirming ? (
            <span className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                Remove {viewer.email}?
              </span>
              <Button
                className="btn btn-danger btn-sm"
                busyLabel="Removing…"
                onClick={async () => {
                  await api.removeViewer(viewer.email);
                  setConfirming(false);
                  props.onChanged();
                }}
              >
                Remove
              </Button>
              <button className="btn btn-sm" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** All-sites vs a per-site tick list — the agency case in one control. */
function SitePicker(props: {
  sites: Site[];
  allSites: boolean;
  siteIds: string[];
  onAllSites: (v: boolean) => void;
  onToggle: (id: string) => void;
  /** Predicate: is this site's domain covered by an Advanced Stats subscription? */
  isOnline?: (site: Site) => boolean;
}) {
  const isOnline = props.isOnline ?? (() => true);
  const offlineCount = props.sites.filter((s) => !isOnline(s)).length;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="section-title" style={{ margin: 0 }}>
        What they can see
      </div>
      {/* Access is a GRANT; the subscription decides what actually appears. Say the rule
          once, where the choice is made — granting an offline site felt like paying for
          nothing (founder feedback 2026-08-04). */}
      {offlineCount > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          People only ever see sites whose domain has Advanced Stats. You can still grant the
          others now — they appear to your team automatically the moment their domain is upgraded,
          and cost nothing until then.
        </p>
      )}
      <label className="row" style={{ gap: 8 }}>
        <input type="radio" checked={props.allSites} onChange={() => props.onAllSites(true)} />
        <span>
          All sites <span className="muted">— including any you add later</span>
        </span>
      </label>
      <label className="row" style={{ gap: 8 }}>
        <input type="radio" checked={!props.allSites} onChange={() => props.onAllSites(false)} />
        <span>Only the sites I pick</span>
      </label>
      {!props.allSites && (
        <div className="stack" style={{ gap: 4, paddingLeft: 24 }}>
          {props.sites.length === 0 ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Add a site first.
            </span>
          ) : (
            props.sites.map((s) => (
              <label key={s.id} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={props.siteIds.includes(s.id)}
                  onChange={() => props.onToggle(s.id)}
                />
                <span>
                  {s.name} <span className="muted mono" style={{ fontSize: 12 }}>{s.domain}</span>{" "}
                  {isOnline(s) ? (
                    <span className="badge ok" style={{ fontSize: 10 }}>
                      online
                    </span>
                  ) : (
                    <span className="badge" style={{ fontSize: 10 }} title="Visible to your team once this domain has Advanced Stats">
                      not online yet
                    </span>
                  )}
                </span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
