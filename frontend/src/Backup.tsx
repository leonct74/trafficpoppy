import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { isFirstPartyFor } from "../../shared/src/first-party";
import type { Site } from "./types";

/**
 * Back up & restore (2026-08-05) — the "teardown export" promised in DESIGN.md §12.
 * A backup keeps the sites (ids intact, snippets keep working) and every aggregate
 * number; it NEVER contains visitor hashes or the salt — those die with the table by
 * design. Restore is two-step confirmed: old rows replace same-key newer ones.
 */
export function Backup(props: { onlineDomains: string[] }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = "all unlocked"
  const [backups, setBackups] = useState<{ path: string; date: string; bytes: number }[]>([]);
  const [saved, setSaved] = useState<{
    path: string;
    rows: number;
    sites: number;
    counters: number;
    skippedSites: string[];
  } | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setBackups((await api.listBackups()).backups);
    } catch {
      /* listing is best-effort — the buttons still work */
    }
  };

  useEffect(() => {
    void refresh();
    api.listSites().then(({ sites: s }) => setSites(s)).catch(() => setSites([]));
  }, []);

  // The same first-party rule the sidecar enforces — shown here so the owner can SEE
  // which sites a backup would cover before pressing anything. The server re-derives it;
  // this list is for the eyes, never the gate.
  const unlocked = (sites ?? []).filter((s) => props.onlineDomains.some((d) => isFirstPartyFor(s.domain, d)));
  const locked = (sites ?? []).filter((s) => !unlocked.includes(s));
  const selected = unlocked.filter((s) => picked === null || picked.has(s.id));
  const toggle = (id: string) => {
    const next = new Set(picked ?? unlocked.map((s) => s.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <div className="card stack">
      <h2 className="section-title" style={{ margin: 0 }}>
        Back up &amp; restore
      </h2>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        A backup file keeps your numbers, so statistics survive a full removal and return after a
        fresh setup. Like the online dashboard, it covers the sites you've unlocked with Advanced
        Stats — one per site. It never contains anything about individual visitors: there is
        nothing of that kind to back up.
      </p>

      {err && <div className="banner err">{err}</div>}

      {/* Which sites a backup would cover — named BEFORE the button, never discovered
          after (founder feedback 2026-08-05). */}
      {sites !== null && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Sites to back up
          </div>
          {unlocked.length === 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              No site has Advanced Stats yet — unlock one in the Advanced stats tab to back it up.
            </p>
          )}
          {unlocked.map((s) => (
            <label key={s.id} className="row" style={{ gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={picked === null || picked.has(s.id)}
                onChange={() => toggle(s.id)}
                aria-label={s.domain}
              />
              <span className="mono" style={{ fontSize: 13 }}>
                {s.domain}
              </span>
            </label>
          ))}
          {locked.map((s) => (
            <div key={s.id} className="row" style={{ gap: 8, opacity: 0.45 }} title="Requires Advanced Stats">
              <input type="checkbox" checked={false} disabled aria-label={`${s.domain} (locked)`} />
              <span className="mono" style={{ fontSize: 13 }}>
                {s.domain} 🔒
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                needs Advanced Stats
              </span>
            </div>
          ))}
        </div>
      )}

      <div>
        <Button
          className="btn btn-primary"
          busyLabel="Backing up…"
          disabled={selected.length === 0}
          onClick={async () => {
            setErr(null);
            setRestored(null);
            try {
              setSaved(await api.backup(selected.map((s) => s.id)));
              await refresh();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {selected.length === 1
            ? `Back up ${selected[0]!.domain}`
            : `Back up ${selected.length} sites`}
        </Button>
      </div>

      {saved && (
        <div className="banner info stack" style={{ gap: 6 }}>
          <div>
            Saved <strong>{saved.sites}</strong> site{saved.sites === 1 ? "" : "s"} and{" "}
            <strong>{saved.counters}</strong> daily records.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>{saved.path}</code>
            <CopyButton text={saved.path} label="Path" />
          </div>
        </div>
      )}

      {/* Never a silent omission: a site left out of a backup must be NAMED, or its owner
          discovers the gap after a teardown, when it's too late. */}
      {saved && saved.skippedSites.length > 0 && (
        <div className="banner err stack" style={{ gap: 6 }}>
          <div>
            <strong>Not in this backup:</strong> {saved.skippedSites.join(", ")}. These sites don't have
            Advanced Stats, so their numbers stay only in your table — a removal would take them with
            it. Unlock a site in the Advanced stats tab to include it.
          </div>
        </div>
      )}

      {restored !== null && (
        <div className="banner info">
          Restored <strong>{restored}</strong> records — your dashboards have their history back.
        </div>
      )}

      {backups.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Your backup files
          </div>
          {backups.map((b) => (
            <div key={b.path} className="spread">
              <span className="mono" style={{ fontSize: 12 }}>
                {b.date} · {Math.max(1, Math.round(b.bytes / 1024))} KB
              </span>
              {confirming === b.path ? (
                <span className="row">
                  <Button
                    className="btn btn-danger btn-sm"
                    busyLabel="Restoring…"
                    onClick={async () => {
                      setErr(null);
                      setSaved(null);
                      try {
                        const r = await api.restore(b.path);
                        setRestored(r.restored);
                        setConfirming(null);
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  >
                    Really restore
                  </Button>
                  <button className="btn btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn btn-sm" onClick={() => setConfirming(b.path)}>
                  Restore
                </button>
              )}
            </div>
          ))}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Restoring writes the file's records back — where a day exists in both, the file's
            version wins. Use it after a fresh setup, not on top of newer numbers.
          </p>
        </div>
      )}
    </div>
  );
}
