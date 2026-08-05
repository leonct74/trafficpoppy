import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { TRUE_REACH } from "./catalogue";
import { useEntitlement, type Entitlement } from "./entitlement";
import { host, ADVANCED_STATS_PRODUCT } from "./host";
import { isFirstPartyFor } from "../../shared/src/first-party";
import { Purchase } from "./Purchase";
import type { EdgeStatus, Site } from "./types";

/**
 * The Advanced Stats card (DESIGN.md §12), SITE-FIRST since 2026-08-05 (founder: "if I
 * add stats.A but I want to unlock B, how do I specify that?"). What's sold is a SITE
 * going online, so the card is a list of the tracked sites: each row is either live,
 * mid-setup, or shows an Unlock button. The address is derived — a subdomain prefix in
 * front of the site's own domain — so a wrong domain can't be typed at all, and the
 * subscription is keyed on the site's domain, surviving any later address rename.
 *
 * Each live site still runs its own small edge stack (own certificate, own
 * distribution) — added, updated and removed independently, matching the per-site
 * subscription. But every address serves the SAME dashboard: one login lists every
 * unlocked site, so ten sites never mean ten pages to check.
 *
 * The flow is background + resumable (AGENTS.md §5): every state below is re-derived
 * from AWS on each poll, so closing the app mid-validation and coming back lands
 * exactly where things are. DNS stays manual: we show the records; the owner adds them
 * wherever their DNS lives.
 */

/** A site's address the way isFirstPartyFor sees it: bare hostname, no www/protocol/path. */
function normalizeSite(siteDomain: string): string {
  return siteDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/:].*$/, "");
}

export function TrueReach(props: { onStatus?: (edges: EdgeStatus[]) => void }) {
  const [edges, setEdges] = useState<EdgeStatus[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { onStatus } = props;

  useEffect(() => {
    api.listSites().then(({ sites: s }) => setSites(s)).catch(() => setSites([]));
  }, []);

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

  if (edges === null || sites === null) return null; // don't flash a teaser before we know the real state

  const edgeFor = (site: Site) => edges.find((e) => e.domain && isFirstPartyFor(site.domain, e.domain));
  // An edge no tracked site lives under (site was deleted, or a pre-site-first setup) —
  // it must stay manageable, or its stack and subscription would be unreachable.
  const orphans = edges.filter((e) => e.domain && !sites.some((s) => isFirstPartyFor(s.domain, e.domain!)));
  const dashboard = edges.find((e) => e.phase === "ready" && e.viewerAtEdge && e.domain);

  return (
    <div className="card stack">
      <h2 className="section-title" style={{ margin: 0 }}>
        {TRUE_REACH.label}
      </h2>

      {err && <div className="banner err">{err}</div>}

      {edges.length === 0 && <p style={{ margin: 0 }}>{TRUE_REACH.pitch}</p>}

      {dashboard && (
        <p style={{ margin: 0 }}>
          Your statistics page: <span className="mono">https://{dashboard.domain}/</span> — one login
          there shows every site you've unlocked, for you and everyone under Team access.
        </p>
      )}

      {sites.length === 0 && (
        <p className="muted" style={{ margin: 0 }}>
          First add your website under “Your sites” — advanced stats are unlocked per site.
        </p>
      )}

      {sites.map((site) => (
        <SiteRow key={site.id} site={site} edge={edgeFor(site)} onChanged={refresh} onError={setErr} />
      ))}

      {orphans.map((edge) => (
        <div key={edge.domain} className="stack" style={{ gap: 6 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            No site you track lives under <span className="mono">{edge.domain}</span> — you can remove it
            below (add the site under “Your sites” if this is unexpected).
          </p>
          <EdgeCard edge={edge} entitlement={null} onChanged={refresh} onError={setErr} />
        </div>
      ))}

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {TRUE_REACH.caution}
      </p>
    </div>
  );
}

/**
 * One tracked site's row: live / mid-setup / locked. The subscription is checked under
 * the SITE's domain (the key since 2026-08-05) and, for setups made before that, under
 * the stats hostname — either one counts as subscribed, so nobody is asked to pay twice.
 */
function SiteRow(props: {
  site: Site;
  edge: EdgeStatus | undefined;
  onChanged: () => Promise<unknown>;
  onError: (m: string | null) => void;
}) {
  const { site, edge } = props;
  const siteDomain = normalizeSite(site.domain);
  const [prefix, setPrefix] = useState("stats");
  const entitlement = useEntitlement(siteDomain);
  const legacy = useEntitlement(edge?.domain);
  const owned: Entitlement | null = entitlement.entitled ? entitlement : legacy.entitled ? legacy : null;

  if (edge) {
    // Lapse handling (§12): the platform says the subscription ended, but the edge is
    // still running in the owner's AWS. We never tear anything down by ourselves —
    // that's the owner's infrastructure — so the honest move is a visible notice with
    // the two real options: renew, or remove the address (data is kept either way).
    // Both checks must have ANSWERED false — while loading, assume good standing.
    const lapsed = entitlement.entitled === false && legacy.entitled === false;
    return (
      <div className="stack" style={{ gap: 8 }}>
        {lapsed && (
          <div className="banner err stack" style={{ gap: 10 }}>
            <div>
              <strong>The subscription for {siteDomain} has ended.</strong> Its statistics page and
              first-party collection are still running in your AWS. Renew to keep them — or remove the
              address below: every number you've collected stays, and collection falls back to your
              AWS address.
            </div>
            <div>
              <Button
                className="btn btn-primary btn-sm"
                busyLabel="Opening checkout…"
                onClick={async () => {
                  await host.buyProduct(ADVANCED_STATS_PRODUCT, { target: siteDomain });
                  await entitlement.refresh();
                }}
              >
                Renew
              </Button>
            </div>
          </div>
        )}
        <EdgeCard edge={edge} entitlement={owned} onChanged={props.onChanged} onError={props.onError} />
      </div>
    );
  }

  // "www" would collide with the website itself; empty is not an address.
  const cleanPrefix = prefix.trim().toLowerCase();
  const prefixOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(cleanPrefix) && cleanPrefix !== "www";
  const address = `${cleanPrefix}.${siteDomain}`;

  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="spread">
        <strong className="mono" style={{ fontSize: 13 }}>
          {siteDomain}
        </strong>
        <span className="badge">not online</span>
      </div>

      {!owned ? (
        <Purchase
          entitlement={entitlement}
          target={siteDomain}
          pitch={
            <>
              <strong>Put {siteDomain} online</strong> — its statistics page on your own address, open
              and shareable from any browser. And ad blockers stop hiding its visitors: collecting on
              your own subdomain makes them countable again, with visitor countries included.
            </>
          }
        />
      ) : (
        <>
          <div className="spread">
            <span className="badge ok">
              <span className="dot" /> Subscribed · {siteDomain}
            </span>
            {/* REQUIRED by the platform: a visible way to cancel / see what was paid. */}
            <button className="btn btn-sm" onClick={() => void owned.manage()}>
              Manage billing
            </button>
          </div>
          <p style={{ margin: 0 }}>
            Choose the address for its statistics page — any name in front of your domain works
            (most people keep <span className="mono">stats</span>).
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="row" style={{ gap: 0 }}>
              <input
                className="input mono"
                style={{ width: 110, textAlign: "right" }}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
                aria-label="subdomain name"
              />
              <span className="mono" style={{ fontSize: 13 }}>
                .{siteDomain}
              </span>
            </span>
            <Button
              className="btn btn-primary"
              busyLabel="Starting…"
              disabled={!prefixOk}
              onClick={async () => {
                props.onError(null);
                try {
                  await api.edgeDeploy(address);
                  await props.onChanged();
                } catch (e) {
                  props.onError((e as Error).message);
                }
              }}
            >
              Put it online
            </Button>
          </div>
          {cleanPrefix === "www" && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--poppy-danger)" }}>
              www is your website's own address — pick a different name, like stats.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One live (or in-flight) address: status, DNS work, update, billing, removal. */
function EdgeCard(props: {
  edge: EdgeStatus;
  /** The owning subscription, if one is visible — null hides the billing line only. */
  entitlement: Entitlement | null;
  onChanged: () => Promise<unknown>;
  onError: (m: string | null) => void;
}) {
  const { edge, entitlement } = props;
  const [confirmingRemove, setConfirmingRemove] = useState(false);

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
        <>
          <p style={{ margin: 0 }}>
            <strong>Domain verified.</strong> AWS is now copying your collector to its edge locations
            around the world. This usually takes 20–40 minutes, and on a busy day it can take a few
            hours — that is normal, and there is nothing you can do to speed it up.
          </p>
          {/* Founder 2026-08-05, twice: first "the UI is not showing the new DNS, I see only a
              spinner", then — after a much longer wait than our copy promised — "tell the user it
              can take a few hours … otherwise they will redo the setup multiple times". An
              understated estimate doesn't just annoy: it makes people tear the thing down and
              restart, which only restarts the wait. */}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <strong>Close the app if you like</strong> — the work happens in your AWS account, not
            here, and this screen picks it up wherever it has got to when you come back. Please
            don't remove and set it up again: starting over throws away the progress and begins the
            same wait from zero. There's no DNS record to add yet either — the address you'll point
            your domain at doesn't exist until this finishes, and it appears here by itself.
          </p>
        </>
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

      {edge.phase === "ready" && entitlement && (
        <div className="spread">
          <span className="badge ok">
            <span className="dot" /> Subscribed
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
            Removing this address keeps every number you've collected — its collection just falls back to
            the AWS address. Other sites aren't affected.
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
  // Trimmed at every layer, and `user-select: all` makes a manual click select EXACTLY
  // the value — a drag can't pick up a neighbouring space. One leading space in a DNS
  // name becomes a different name (`\040…`, NXDOMAIN) while looking normal everywhere.
  const value = props.value.trim();
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="muted" style={{ fontSize: 12, width: 44 }}>
        {props.label}
      </span>
      <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap", userSelect: "all" }}>
        {value}
      </code>
      <CopyButton text={value} label={props.label} />
    </div>
  );
}
