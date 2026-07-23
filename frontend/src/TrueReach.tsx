import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
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
          True Reach — your own domain
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
          <p style={{ margin: 0 }}>
            Collect on a subdomain of <strong>your own site</strong> instead of the AWS address: ad blockers stop
            hiding your visitors, and you get <strong>country statistics</strong> — both need your own domain.
          </p>
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
            <Button className="btn btn-primary" busyLabel="Starting…" onClick={deploy}>
              Set up True Reach
            </Button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            You'll be asked to add two DNS records at your domain host. AWS-side cost: cents — CloudFront's
            free tier covers typical sites.
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
            <p style={{ margin: 0 }}>
              Add this record at your DNS host to prove you own <strong>{edge.domain}</strong>. AWS checks
              automatically — this screen moves on by itself (checks continue even if you close the app).
            </p>
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
              <div className="section-title" style={{ margin: 0 }}>
                {r.purpose === "certificate-validation" ? "1 · Domain-ownership check" : "2 · Point your subdomain"}
              </div>
              <RecordLine label="Type" value={r.type} />
              <RecordLine label="Name" value={r.name} />
              <RecordLine label="Value" value={r.value} />
            </div>
          ))}

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
