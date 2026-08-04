import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { TRUE_REACH } from "./catalogue";
import { useEntitlement } from "./entitlement";
import { Purchase } from "./Purchase";
import type { EdgeStatus } from "./types";

/**
 * The True Reach card (DESIGN.md §12), MULTI-DOMAIN since 2026-08-04: each domain runs its
 * own small edge stack (own certificate, own distribution), so domains are added, updated
 * and removed independently — which is exactly the shape of the per-domain subscription.
 *
 * The flow is background + resumable (AGENTS.md §5): every state below is re-derived from
 * AWS on each poll, so closing the app mid-validation and coming back lands exactly where
 * things are. DNS stays manual: we show the records; the owner adds them wherever their
 * DNS lives.
 */
export function TrueReach(props: { suggestedDomain?: string; onStatus?: (edges: EdgeStatus[]) => void }) {
  const [edges, setEdges] = useState<EdgeStatus[] | null>(null);
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { onStatus } = props;

  const refresh = async () => {
    const { edges: e } = await api.edgeStatus();
    setEdges(e);
    onStatus?.(e);
    return e;
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const { edges: e } = await api.edgeStatus();
        if (alive) {
          setEdges(e);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStatus]);

  // §12: one paid unit = ONE DOMAIN — the add flow bills the domain being typed.
  const addTarget = domain.trim().toLowerCase() || (edges?.length ? "" : (props.suggestedDomain ?? ""));
  const entitlement = useEntitlement(addTarget || undefined);

  const addDomain = async () => {
    setErr(null);
    try {
      await api.edgeDeploy(addTarget);
      setDomain("");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (edges === null) return null; // don't flash a teaser before we know the real state

  return (
    <div className="card stack">
      <h2 className="section-title" style={{ margin: 0 }}>
        {TRUE_REACH.label}
      </h2>

      {err && <div className="banner err">{err}</div>}

      {edges.length === 0 && <p style={{ margin: 0 }}>{TRUE_REACH.pitch}</p>}

      {edges.map((edge) => (
        <EdgeDomain key={edge.domain} edge={edge} onChanged={refresh} onError={setErr} />
      ))}

      {/* Add the first — or one more — domain. Entitlement is checked per domain (§12). */}
      <div className="stack" style={{ gap: 10 }}>
        {edges.length > 0 && (
          <div className="section-title" style={{ margin: 0 }}>
            Add another domain
          </div>
        )}
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
            disabled={!addTarget || !entitlement.entitled}
            onClick={addDomain}
          >
            Set up your domain
          </Button>
        </div>
        {addTarget && !entitlement.entitled && (
          <Purchase
            entitlement={entitlement}
            target={addTarget}
            pitch={
              <>
                <strong>Your statistics page, on your own address</strong> — open and share it from any
                browser. And ad blockers stop hiding your visitors: collecting on your own subdomain
                makes them countable again, with visitor countries included.
              </>
            }
          />
        )}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {TRUE_REACH.caution}
        </p>
      </div>
    </div>
  );
}

/** One domain's whole lifecycle: status, DNS work, update, billing, removal. */
function EdgeDomain(props: { edge: EdgeStatus; onChanged: () => Promise<unknown>; onError: (m: string | null) => void }) {
  const { edge } = props;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const entitlement = useEntitlement(edge.domain);

  const act = async (fn: () => Promise<unknown>) => {
    props.onError(null);
    try {
      await fn();
      await props.onChanged();
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="spread">
        <strong className="mono" style={{ fontSize: 13 }}>
          {edge.domain}
        </strong>
        {edge.phase === "ready" && (
          <span className="badge ok">
            <span className="dot" /> live
          </span>
        )}
        {(edge.phase === "validating" || edge.phase === "deploying") && (
          <span className="badge">
            <span className="spinner" style={{ width: 10, height: 10 }} />{" "}
            {edge.phase === "validating" ? "waiting for your DNS record" : "setting up at the edge"}
          </span>
        )}
        {edge.phase === "removing" && <span className="badge">removing…</span>}
      </div>

      {edge.phase === "failed" && (
        <>
          <div className="banner err">
            The last attempt didn't finish.{" "}
            {edge.failureReason && <span className="mono" style={{ fontSize: 12 }}>{edge.failureReason}</span>}
          </div>
          <div>
            <Button className="btn" busyLabel="Removing…" onClick={() => act(() => api.edgeRemove(edge.domain!))}>
              Remove and start over
            </Button>
          </div>
        </>
      )}

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

      {/* Same contract as the core stack: shown, never auto-applied. */}
      {edge.phase === "ready" && edge.updateAvailable && (
        <div className="banner info stack" style={{ gap: 10 }}>
          <div>
            <strong>An update is ready for your custom domain.</strong> It puts your statistics page on this
            domain too — browsing <span className="mono">https://{edge.domain}</span> will show your
            dashboard instead of an error page. Collection keeps running while it applies, and your
            DNS records don't change.
          </div>
          <div>
            <Button
              className="btn btn-primary btn-sm"
              busyLabel="Updating…"
              onClick={() => act(() => api.edgeUpdate(edge.domain!))}
            >
              Update now
            </Button>
          </div>
        </div>
      )}

      {edge.phase === "ready" && edge.viewerAtEdge && !edge.updateAvailable && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Your team can open the statistics page at <span className="mono">https://{edge.domain}</span> —
          same sign-in as before.
        </p>
      )}

      {edge.phase === "ready" && entitlement.entitled && (
        <div className="spread">
          <span className="badge ok">
            <span className="dot" /> Subscribed · {edge.domain}
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
            Removing this domain keeps every number you've collected — its collection just falls back to
            the AWS address. Other domains aren't affected.
          </span>
          {confirmingRemove ? (
            <span className="row">
              <Button
                className="btn btn-danger btn-sm"
                busyLabel="Removing…"
                onClick={() =>
                  act(async () => {
                    await api.edgeRemove(edge.domain!);
                    setConfirmingRemove(false);
                  })
                }
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
