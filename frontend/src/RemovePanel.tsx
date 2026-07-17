import { useEffect, useRef, useState } from "react";

/**
 * The scoped destructive control (AGENTS.md §4). Removing TrafficPoppy wipes its whole
 * footprint, so it earns the full ceremony:
 *
 *  - two distinct steps — the button opens a dialog, a second action destroys;
 *  - the blast radius is named in plain language, not "Are you sure?";
 *  - type-to-confirm arms the button, so it can't happen on autopilot;
 *  - Cancel is focused and the danger button is not the easy default, so a stray
 *    Enter or double-click can't destroy anything.
 */
const CONFIRM_WORD = "TrafficPoppy";

export function RemovePanel(props: { disabled?: boolean; onRemove: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped("");
    setErr(null);
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await props.onRemove();
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-2">
      <h2 className="section-title">Remove TrafficPoppy</h2>
      <div className="spread">
        <p className="muted" style={{ margin: 0, maxWidth: "46ch" }}>
          Deletes everything TrafficPoppy made in your AWS account, including the statistics it has
          collected. Your AWS account itself isn't touched.
        </p>
        <button className="btn btn-danger" disabled={props.disabled} onClick={() => setOpen(true)}>
          Remove…
        </button>
      </div>

      {open && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="remove-title">
          <div className="modal stack">
            <h3 id="remove-title" style={{ margin: 0 }}>
              Remove TrafficPoppy from your AWS account?
            </h3>
            <p style={{ margin: 0 }}>This deletes, permanently:</p>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>the storage holding your website statistics — every visit ever counted</li>
              <li>everything else TrafficPoppy created to run</li>
            </ul>
            <p style={{ margin: 0 }}>
              <strong>This can't be undone.</strong> You can set TrafficPoppy up again later, but the numbers
              it has already collected will be gone.
            </p>
            <label className="field" style={{ margin: 0 }}>
              <span>
                Type <strong>{CONFIRM_WORD}</strong> to confirm
              </span>
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {err && <div className="banner err">{err}</div>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" ref={cancelRef} onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={typed !== CONFIRM_WORD || busy} onClick={() => void remove()}>
                {busy ? "Removing…" : "Remove everything"}
              </button>
            </div>
            {busy && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                This can take a couple of minutes. It keeps going even if you leave this tab.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
