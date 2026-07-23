import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { LiveStats, RangeStats, Site } from "./types";

/**
 * The per-site dashboard, P3 quality bar (DESIGN.md §13): range picker, headline metrics
 * with Δ% vs the previous window and sparklines, an SVG daily chart, hour-of-day heat
 * strip, top movers, live last-30-minutes ticker, ranked breakdowns and the cost line.
 *
 * All charts are hand-rolled SVG on the design-kit CSS variables — one visual system,
 * light/dark correct by construction, no chart library, nothing loaded from a CDN.
 * Everything shown derives from the aggregate counters; there is nothing more detailed
 * anywhere to show (the privacy model's whole point).
 */
const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

const POLL_MS = 30_000;
const LIVE_POLL_MS = 10_000;

export function Dashboard(props: { site: Site; onBack: () => void; onIntegrate?: () => void }) {
  const { site } = props;
  const [days, setDays] = useState<number>(7);
  const [range, setRange] = useState<RangeStats | null>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [monthViews, setMonthViews] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The picked range, kept live.
  useEffect(() => {
    let alive = true;
    setRange(null);
    const tick = async () => {
      try {
        const { range: r } = await api.rangeStats(site.id, days);
        if (alive) {
          setRange(r);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [site.id, days]);

  // The last-30-minutes ticker, on its own faster poll.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const { live: l } = await api.liveStats(site.id);
        if (alive) setLive(l);
      } catch {
        /* transient — keep the last value */
      }
    };
    void tick();
    const t = window.setInterval(tick, LIVE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [site.id]);

  // A 30-day read, once, purely for the cost line ("Show the money", AGENTS.md §9).
  useEffect(() => {
    let alive = true;
    void api
      .rangeStats(site.id, 30)
      .then(({ range: r }) => alive && setMonthViews(r.views))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [site.id]);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
          <div className="row">
            {/* The way back to the sites list (add/manage other websites) — a REAL bordered
                button: as a ghost button it was invisible enough that the founder reported
                it missing. */}
            <button className="btn btn-sm" onClick={props.onBack} aria-label="Back to your sites">
              ← Your sites
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
          <div className="row" style={{ flexWrap: "wrap" }}>
            {props.onIntegrate && (
              <button className="btn btn-ghost btn-sm" onClick={props.onIntegrate} title="Query this data with your own tools">
                Integrate
              </button>
            )}
            <LivePulse live={live} />
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
        </div>

        {err && <div className="banner err">{err}</div>}

        {range === null ? (
          <Skeleton />
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
            <div className="row" style={{ gap: 32, flexWrap: "wrap", alignItems: "flex-start" }}>
              <Metric
                label={days === 1 ? "Page views today" : "Page views"}
                value={range.views}
                prev={range.prev?.views}
                series={range.days.map((d) => d.views)}
              />
              <Metric
                label="Visitors"
                value={range.uniques}
                prev={range.prev?.uniques}
                series={range.days.map((d) => d.uniques)}
                hint={days > 1 ? "Each visitor counts once per day — days can't be linked, by design." : undefined}
              />
              {days > 1 && <Metric label="Views / day" value={Math.round(range.views / days)} />}
            </div>
            {days > 1 && <AreaChart series={range.days} />}
            <HeatStrip hours={range.hours} />
          </>
        )}
      </div>

      {range?.receiving && (
        <>
          <Movers current={range.topPages} prev={range.prev?.topPages} what="pages" />
          {range.countries.length > 0 && (
            <BarList
              title="Countries"
              rows={range.countries.map((c) => ({ ...c, key: countryLabel(c.key) }))}
              empty="—"
            />
          )}
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

/** Animate a number to its target — the "premium feel" count-up, cheap and interruption-safe. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 450);
      const eased = 1 - (1 - k) * (1 - k);
      setShown(Math.round(from + (target - from) * eased));
      if (k < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

function Metric(props: { label: string; value: number; prev?: number; series?: number[]; hint?: string }) {
  const shown = useCountUp(props.value);
  return (
    <div title={props.hint} style={{ minWidth: 110 }}>
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <span style={{ fontSize: 28, fontWeight: 650, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
          {shown.toLocaleString()}
        </span>
        {props.prev !== undefined && <Delta now={props.value} prev={props.prev} />}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </div>
      {props.series && props.series.length > 1 && <Sparkline values={props.series} />}
    </div>
  );
}

/** Δ% vs the previous same-length window. prev=0 with traffic now reads "new", not "+∞%". */
function Delta(props: { now: number; prev: number }) {
  const { now, prev } = props;
  if (now === prev) return null;
  const up = now > prev;
  const label = prev === 0 ? "new" : `${up ? "+" : ""}${Math.round(((now - prev) / prev) * 100)}%`;
  return (
    <span
      title={`Previous period: ${prev.toLocaleString()}`}
      style={{ fontSize: 12, fontWeight: 650, color: up ? "var(--poppy-ok)" : "var(--poppy-danger)" }}
    >
      {up ? "↑" : "↓"} {label}
    </span>
  );
}

/** A tiny inline trend line — shape only, no axes (the chart below carries the detail). */
function Sparkline(props: { values: number[] }) {
  const { values } = props;
  const max = Math.max(1, ...values);
  const W = 96;
  const H = 24;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * (W - 2) + 1).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden style={{ display: "block", marginTop: 4 }}>
      <polyline points={pts} fill="none" stroke="var(--poppy-accent)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** The daily views chart — hand-rolled SVG area, design-kit colors, per-day hover titles. */
function AreaChart(props: { series: { day: string; views: number }[] }) {
  const { series } = props;
  const max = Math.max(1, ...series.map((d) => d.views));
  const W = 640;
  const H = 120;
  const PAD = 4;
  const x = (i: number) => PAD + (i / Math.max(1, series.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const line = series.map((d, i) => `${x(i).toFixed(1)},${y(d.views).toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${(W - PAD).toFixed(1)},${H - PAD}`;
  return (
    <figure style={{ margin: 0 }} role="img" aria-label={`Views per day, peaking at ${max.toLocaleString()}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        preserveAspectRatio="none"
      >
        <polygon points={area} fill="var(--poppy-accent)" opacity="0.14" />
        <polyline points={line} fill="none" stroke="var(--poppy-accent)" strokeWidth="2" strokeLinejoin="round" />
        {series.map((d, i) => (
          <circle key={d.day} cx={x(i)} cy={y(d.views)} r="7" fill="transparent">
            <title>{`${d.day} — ${d.views.toLocaleString()} views`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="spread muted" style={{ fontSize: 11 }}>
        <span>{series[0]?.day}</span>
        <span>{series[series.length - 1]?.day}</span>
      </figcaption>
    </figure>
  );
}

/** When your visitors come, over the 24 UTC hours — intensity as accent opacity. */
function HeatStrip(props: { hours: number[] }) {
  const max = Math.max(...props.hours);
  if (max === 0) return null;
  return (
    <div>
      <div className="row" style={{ gap: 2 }} role="img" aria-label="Views by hour of day (UTC)">
        {props.hours.map((v, h) => (
          <div
            key={h}
            title={`${String(h).padStart(2, "0")}:00 UTC — ${v.toLocaleString()} views`}
            style={{
              flex: 1,
              height: 14,
              borderRadius: 3,
              background: "var(--poppy-accent)",
              opacity: v === 0 ? 0.08 : 0.15 + 0.85 * (v / max),
            }}
          />
        ))}
      </div>
      <div className="spread muted" style={{ fontSize: 11, marginTop: 2 }}>
        <span>00:00</span>
        <span>Busiest hours (UTC)</span>
        <span>23:00</span>
      </div>
    </div>
  );
}

/** The live ticker: a pulsing badge when the last half hour saw traffic. */
function LivePulse(props: { live: LiveStats | null }) {
  const v = props.live?.views ?? 0;
  return (
    <span
      className={`badge${v > 0 ? " ok" : ""}`}
      title="Views in the last 30 minutes, updated every 10 seconds"
    >
      <span className="dot" /> {v > 0 ? `${v.toLocaleString()} live` : "quiet now"}
    </span>
  );
}

/** "IT" → "🇮🇹 Italy" — flag from regional-indicator pairs, name from the platform locale data. */
export function countryLabel(code: string): string {
  const flag = String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return `${flag} ${name ?? code}`;
  } catch {
    return `${flag} ${code}`;
  }
}

/** Pages rising and falling vs the previous window — the "what changed?" read. */
export function computeMovers(
  current: { key: string; count: number }[],
  prev: { key: string; count: number }[],
): { key: string; delta: number; count: number }[] {
  const before = new Map(prev.map((p) => [p.key, p.count]));
  const seen = new Set(current.map((c) => c.key));
  const all = [
    ...current.map((c) => ({ key: c.key, count: c.count, delta: c.count - (before.get(c.key) ?? 0) })),
    ...prev.filter((p) => !seen.has(p.key)).map((p) => ({ key: p.key, count: 0, delta: -p.count })),
  ];
  return all.filter((m) => m.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
}

function Movers(props: { current: { key: string; count: number }[]; prev?: { key: string; count: number }[]; what: string }) {
  if (!props.prev || props.prev.length === 0) return null;
  const movers = computeMovers(props.current, props.prev);
  if (movers.length === 0) return null;
  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="section-title" style={{ margin: 0 }}>
        Top movers <span className="muted" style={{ fontWeight: 400 }}>vs previous period</span>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
        {movers.map((m) => (
          <span key={m.key} className="chip" title={`${m.count.toLocaleString()} now`}>
            <span style={{ color: m.delta > 0 ? "var(--poppy-ok)" : "var(--poppy-danger)", fontWeight: 650 }}>
              {m.delta > 0 ? "↑" : "↓"} {Math.abs(m.delta).toLocaleString()}
            </span>{" "}
            {m.key}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Loading placeholder that sketches the layout instead of a lone spinner. */
function Skeleton() {
  const block = (w: string, h: number) => (
    <div className="skeleton" style={{ width: w, height: h, borderRadius: 6 }} />
  );
  return (
    <div className="stack" aria-label="Loading" role="status">
      <div className="row" style={{ gap: 32 }}>
        {block("110px", 46)}
        {block("110px", 46)}
        {block("110px", 46)}
      </div>
      {block("100%", 120)}
      {block("100%", 14)}
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
