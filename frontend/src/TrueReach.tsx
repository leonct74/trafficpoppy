import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { TRUE_REACH } from "./catalogue";
import { useEntitlement } from "./entitlement";
import { Purchase } from "./Purchase";
import type { EdgeStatus } from "./types";

/**
 * The True Reach card (DESIGN.md §12): collection on the owner's OWN subdomain —
 * ad-blocker-immune measurement + country stats. The flow is background + resumable
 * (AGENTS.md §5): every state below is re-derived from AWS on each poll, so closing the
 * app mid-validation and coming back lands exactly where things are. DNS stays manual:
 * we show the records; the owner adds them wherever their DNS lives.
 *
 * Checkout/entitlement deliberately not wired yet (§14 P5 decision 7) — mechanics first.
 */
export function TrueReach(props: { suggestedDomain?: string; onStatus?: (edge: EdgeStatus) => void }) {
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { onStatus } = props;

  // §12: one paid unit = ONE DOMAIN, so entitlement is keyed to the domain in play — the one
  // already set up, or the one about to be. (When multi-domain True Reach lands, this becomes
  // per-site rather than per-edge; see DESIGN.md §14's open item.)
  const billingTarget = edge?.domain || domain.trim() || props.suggestedDomain || "";
  const entitlement = useEntitlement(billingTarget || undefined);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const { edge: e } = await api.edgeStatus();
        if (alive) {
          setEdge(e);
          onStatus?.(e);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void tick();
    const t = window.setInterval(tick, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [onStatus]);

  const deploy = async () => {
    setErr(null);
    try {
      await api.edgeDeploy(domain || props.suggestedDomain || "");
      const { edge: e } = await api.edgeStatus();
      setEdge(e);
      onStatus?.(e);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (edge === null) return null; // don't flash a teaser before we know the real state

  return (
    <div className="card stack">
      <div className="spread">
        <h2 className="section-title" style={{ margin: 0 }}>
          {TRUE_REACH.label}
        </h2>
        {edge.phase === "ready" && (
          <span className="badge ok">
            <span className="dot" /> {edge.domain}
          </span>
        )}
        {(edge.phase === "validating" || edge.phase === "deploying") && (
          <span className="badge">
            <span className="spinner" style={{ width: 10, height: 10 }} />{" "}
            {edge.phase === "validating" ? "waiting for your DNS record" : "setting up at the edge"}
          </span>
        )}
      </div>

      {err && <div className="banner err">{err}</div>}

      {edge.phase === "none" && (
        <>
          <p style={{ margin: 0 }}>{TRUE_REACH.pitch}</p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input
              className="input"
              style={{ minWidth: 240 }}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={props.suggestedDomain ?? "stats.your-domain.com"}
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button
              className="btn btn-primary"
              busyLabel="Starting…"
              disabled={!entitlement.entitled}
              onClick={deploy}
            >
              Set up True Reach
            </Button>
          </div>
          {billingTarget && !entitlement.entitled && (
            <Purchase
              entitlement={entitlement}
              target={billingTarget}
              pitch={
                <>
                  <strong>Ad blockers are hiding some of your visitors.</strong> Collecting on your own
                  subdomain makes them countable again — and unlocks country statistics.
                </>
              }
            />
          )}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {TRUE_REACH.caution}
          </p>
        </>
      )}

      {edge.phase === "failed" && (
        <>
          <div className="banner err">
            The last attempt didn't finish.{" "}
            {edge.failureReason && <span className="mono" style={{ fontSize: 12 }}>{edge.failureReason}</span>}
          </div>
          <div>
            <Button
              className="btn"
              busyLabel="Removing…"
              onClick={async () => {
                await api.edgeRemove();
              }}
            >
              Remove and start over
            </Button>
          </div>
        </>
      )}

      {(edge.phase === "validating" || edge.phase === "deploying" || edge.phase === "ready") && (
        <>
          {edge.phase === "validating" && (
            <>
              <p style={{ margin: 0 }}>
                Add this record at your DNS host to prove you own <strong>{edge.domain}</strong>. AWS checks
                automatically — this screen moves on by itself (checks continue even if you close the app).
              </p>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Already added it? DNS changes can take a few minutes (sometimes up to an hour) to become
                visible — nothing else to do but wait. If your DNS host offers a proxy/CDN toggle for the
                record (e.g. an orange cloud), turn it OFF: the check needs the plain record.
              </p>
            </>
          )}
          {edge.phase === "deploying" && (
            <p className="muted" style={{ margin: 0 }}>
              Domain verified — AWS is rolling your collector out to its edge locations (usually 5–15 minutes).
            </p>
          )}
          {edge.phase === "ready" && (
            <p style={{ margin: 0 }}>
              <strong>Live.</strong> Make sure the second record below exists, then your snippets serve
              first-party from <span className="mono">{edge.domain}</span> — new copies are already on the
              sites list. Country stats appear in each dashboard as visits arrive.
            </p>
          )}

          {/* The deployed edge is behind this build (e.g. the statistics page can now ride
              this domain). Same contract as the core stack: shown, never auto-applied. */}
          {edge.phase === "ready" && edge.updateAvailable && (
            <div className="banner info stack" style={{ gap: 10 }}>
              <div>
                <strong>An update is ready for True Reach.</strong> It puts your statistics page on this
                domain too — browsing <span className="mono">https://{edge.domain}</span> will show your
                dashboard instead of an error page. Collection keeps running while it applies, and your
                DNS records don't change.
              </div>
              <div>
                <Button
                  className="btn btn-primary btn-sm"
                  busyLabel="Updating…"
                  onClick={async () => {
                    setErr(null);
                    try {
                      const { edge: e } = await api.edgeUpdate();
                      setEdge(e);
                      onStatus?.(e);
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                >
                  Update True Reach
                </Button>
              </div>
            </div>
          )}

          {edge.phase === "ready" && edge.viewerAtEdge && !edge.updateAvailable && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Your team can open the statistics page at{" "}
              <span className="mono">https://{edge.domain}</span> — same sign-in as before.
            </p>
          )}

          {edge.records.map((r) => (
            <div key={r.purpose} className="card card-2 stack" style={{ marginBottom: 0, gap: 6 }}>
              <div className="spread">
                <div className="section-title" style={{ margin: 0 }}>
                  {r.purpose === "certificate-validation" ? "1 · Domain-ownership check" : "2 · Point your subdomain"}
                </div>
                {/* The record type is a dropdown pick in every DNS panel — show it,
                    don't offer to copy it (founder feedback). */}
                <span className="badge">{r.type}</span>
              </div>
              <RecordLine label="Name" value={r.name} />
              <RecordLine label="Value" value={r.value} />
            </div>
          ))}

          {edge.phase === "ready" && entitlement.entitled && (
            <div className="spread">
              <span className="badge ok">
                <span className="dot" /> Subscribed · {billingTarget}
              </span>
              {/* REQUIRED by the platform: a visible way to cancel / see what was paid. */}
              <button className="btn btn-sm" onClick={() => void entitlement.manage()}>
                Manage billing
              </button>
            </div>
          )}

          {edge.phase === "ready" && (
            <div className="spread">
              <span className="muted" style={{ fontSize: 12 }}>
                Removing True Reach keeps every number you've collected — collection just falls back to the AWS
                address.
              </span>
              {confirmingRemove ? (
                <span className="row">
                  <Button
                    className="btn btn-danger btn-sm"
                    busyLabel="Removing…"
                    onClick={async () => {
                      await api.edgeRemove();
                      setConfirmingRemove(false);
                    }}
                  >
                    Really remove
                  </Button>
                  <button className="btn btn-sm" onClick={() => setConfirmingRemove(false)}>
                    Keep it
                  </button>
                </span>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingRemove(true)}>
                  Remove
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RecordLine(props: { label: string; value: string }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="muted" style={{ fontSize: 12, width: 44 }}>
        {props.label}
      </span>
      <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
        {props.value}
      </code>
      <CopyButton text={props.value} label={props.label} />
    </div>
  );
}
