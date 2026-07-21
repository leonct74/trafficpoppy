import { useEffect, useState } from "react";
import { api } from "./api";
import type { RangeStats, Site } from "./types";

/**
 * The per-site dashboard (DESIGN.md §7.2): range picker (today / 7d / 30d), the headline
 * numbers, a daily bars strip, and ranked breakdowns — pages, referrers, browsers, OS,
 * screen sizes. Live-ish: re-reads every 30 s. All of it comes from the aggregate counters
 * in the owner's own table; there is nothing more detailed anywhere to show.
 */
const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

const POLL_MS = 30_000;

export function Dashboard(props: { site: Site; onBack: () => void }) {
  const { site } = props;
  const [days, setDays] = useState<number>(7);
  const [range, setRange] = useState<RangeStats | null>(null);
  const [monthViews, setMonthViews] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The picked range, kept live.
  useEffect(() => {
    let live = true;
    setRange(null);
    const tick = async () => {
      try {
        const { range: r } = await api.rangeStats(site.id, days);
        if (live) {
          setRange(r);
          setErr(null);
        }
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };
    void tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [site.id, days]);

  // A 30-day read, once, purely for the cost line ("Show the money", AGENTS.md §9).
  useEffect(() => {
    let live = true;
    void api
      .rangeStats(site.id, 30)
      .then(({ range: r }) => live && setMonthViews(r.views))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [site.id]);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread">
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={props.onBack}>
              ← All sites
            </button>
            <div>
              <strong>{site.name}</strong>{" "}
              {site.domain && (
                <span className="muted mono" style={{ fontSize: 12 }}>
                  {site.domain}
                </span>
              )}
            </div>
          </div>
          <div className="tabs" role="tablist" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                role="tab"
                aria-selected={days === r.days}
                className={`tab${days === r.days ? " active" : ""}`}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {err && <div className="banner err">{err}</div>}

        {range === null ? (
          <div className="row">
            <span className="spinner" /> <span className="muted">Reading your numbers…</span>
          </div>
        ) : !range.receiving ? (
          <div className="stack">
            <p style={{ margin: 0 }}>No visits recorded {days === 1 ? "today" : `in the last ${days} days`} yet.</p>
            <p className="muted" style={{ margin: 0 }}>
              If the snippet is installed, numbers appear within seconds of the next visit. If it isn't yet, go
              back to your sites list and copy it from there.
            </p>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
              <Metric label="Page views" value={range.views} />
              <Metric
                label="Visitors"
                value={range.uniques}
                hint={days > 1 ? "Each visitor counts once per day — days can't be linked, by design." : undefined}
              />
              {days > 1 && <Metric label="Views / day" value={Math.round(range.views / days)} />}
            </div>
            {days > 1 && <DayBars series={range.days} />}
          </>
        )}
      </div>

      {range?.receiving && (
        <>
          <div className="grid-2">
            <BarList title="Top pages" rows={range.topPages} empty="No pages yet" />
            <BarList title="Referrers" rows={range.topReferrers} empty="Direct visits only so far" />
          </div>
          <div className="grid-2">
            <BarList title="Browsers" rows={range.browsers} empty="—" />
            <BarList title="Operating systems" rows={range.os} empty="—" />
          </div>
          <div className="grid-2">
            <BarList
              title="Campaign sources"
              rows={range.utmSources}
              empty="Tag your links with ?utm_source=newsletter and arrivals show up here."
            />
            <BarList
              title="Campaigns"
              rows={range.utmCampaigns}
              empty="Add ?utm_campaign=spring-launch to a tagged link to name the campaign."
            />
          </div>
          <div className="grid-2">
            <BarList title="Screen sizes" rows={range.sizes} empty="—" />
            <CostCard monthViews={monthViews} />
          </div>
        </>
      )}
    </div>
  );
}

function Metric(props: { label: string; value: number; hint?: string }) {
  return (
    <div title={props.hint}>
      <div style={{ fontSize: 28, fontWeight: 650, lineHeight: 1.1 }}>{props.value.toLocaleString()}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </div>
    </div>
  );
}

/** The daily views strip — hand-rolled flex bars, no chart library (DESIGN.md P3 does charts). */
function DayBars(props: { series: { day: string; views: number }[] }) {
  const max = Math.max(1, ...props.series.map((d) => d.views));
  return (
    <div
      className="row"
      style={{ alignItems: "flex-end", gap: 3, height: 64 }}
      role="img"
      aria-label="Views per day"
    >
      {props.series.map((d) => (
        <div
          key={d.day}
          title={`${d.day} — ${d.views.toLocaleString()} views`}
          style={{
            flex: 1,
            minWidth: 4,
            height: `${Math.max(3, Math.round((d.views / max) * 100))}%`,
            borderRadius: 3,
            background: d.views > 0 ? "var(--poppy-accent)" : "var(--poppy-border)",
            opacity: d.views > 0 ? 0.9 : 0.6,
          }}
        />
      ))}
    </div>
  );
}

/** A ranked list with proportional bars — the Plausible-style read, design-kit colors. */
function BarList(props: { title: string; rows: { key: string; count: number }[]; empty: string }) {
  const max = Math.max(1, ...props.rows.map((r) => r.count));
  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="section-title" style={{ margin: 0 }}>
        {props.title}
      </div>
      {props.rows.length === 0 ? (
        <span className="muted" style={{ fontSize: 13 }}>
          {props.empty}
        </span>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {props.rows.map((r) => (
            <div key={r.key} style={{ position: "relative", padding: "4px 8px" }}>
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${Math.round((r.count / max) * 100)}%`,
                  background: "var(--poppy-accent)",
                  opacity: 0.16,
                  borderRadius: 4,
                }}
              />
              <div className="spread" style={{ position: "relative", gap: 12 }}>
                <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.key}
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {r.count.toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Show the money" (AGENTS.md §9): what this actually costs in the owner's AWS, from real
 * usage, always visible from the dashboard. Approximate by necessity and labeled so.
 */
export function costApprox(views30: number): string {
  // Per view, roughly: 2 Lambda requests + ~100 ms compute at 128 MB + ~8 DynamoDB
  // on-demand writes. ≈ $0.000012/view. Storage at these volumes is fractions of a cent.
  const usd = views30 * 0.000012;
  if (views30 === 0) return "$0.00";
  return usd < 0.01 ? "less than $0.01" : `~$${usd.toFixed(2)}`;
}

function CostCard(props: { monthViews: number | null }) {
  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="section-title" style={{ margin: 0 }}>
        What this costs you
      </div>
      {props.monthViews === null ? (
        <span className="muted" style={{ fontSize: 13 }}>
          Working it out…
        </span>
      ) : (
        <>
          <div style={{ fontSize: 20, fontWeight: 650 }}>{costApprox(props.monthViews)}</div>
          <span className="muted" style={{ fontSize: 12 }}>
            Last 30 days, in your own AWS — Lambda requests + DynamoDB writes for{" "}
            {props.monthViews.toLocaleString()} views. Approximate; the AWS free tier often covers it
            entirely. Nothing runs when nobody visits.
          </span>
        </>
      )}
    </div>
  );
}
