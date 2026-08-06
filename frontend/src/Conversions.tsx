import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { CopyButton, copyText } from "./CopyButton";
import { buildGoalPrompt } from "./helper-prompt";
import { isFirstPartyFor } from "../../shared/src/first-party";
import { MAX_GOALS, normalizeGoalName, normalizeGoalPath, type Goal } from "../../shared/src/goals";
import type { GoalStats, RangeStats, Site } from "./types";

/**
 * The Conversions tracker (DESIGN.md §7e) — paid, per site, same gate as Advanced Stats.
 *
 * The UX rule this screen is built on: the user never meets the words "event", "selector"
 * or "attribute" until after they've answered ONE plain question — what do you want to
 * count? Everything else (the counter name, the snippet, the verification) follows from
 * their answer, and every goal proves for itself that it is working, so nobody has to
 * wonder whether their edit landed.
 */
const RANGE_DAYS = 30;

export function Conversions(props: {
  /** Domains with a deployed statistics address. */
  onlineDomains: string[];
  /** Domains the host confirms are subscribed — either one unlocks a site here. */
  paidDomains: string[];
}) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { sites: s } = await api.listSites();
      setSites(s);
      setSiteId((cur) => cur ?? s.find((x) => unlockedBy(x, props))?.id ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onlineDomains.join(","), props.paidDomains.join(",")]);

  useEffect(() => {
    void load();
    const again = () => void load();
    document.addEventListener("tp:sites-changed", again);
    document.addEventListener("tp:data-restored", again);
    return () => {
      document.removeEventListener("tp:sites-changed", again);
      document.removeEventListener("tp:data-restored", again);
    };
  }, [load]);

  // The numbers behind each goal, and the "is it working yet?" answer. 30 days, because a
  // goal that fired once last week must not read as broken.
  const loadRange = useCallback(async () => {
    if (!siteId) return;
    try {
      const { range: r } = await api.rangeStats(siteId, RANGE_DAYS);
      setRange(r);
    } catch {
      /* the setup surface still works without numbers */
    }
  }, [siteId]);

  useEffect(() => {
    setRange(null);
    void loadRange();
  }, [loadRange]);

  const unlocked = (sites ?? []).filter((s) => unlockedBy(s, props));
  const locked = (sites ?? []).filter((s) => !unlockedBy(s, props));
  const site = unlocked.find((s) => s.id === siteId) ?? null;

  const save = async (goals: Goal[]) => {
    if (!site) return;
    setErr(null);
    const { goals: saved } = await api.updateSiteGoals(site.id, goals);
    setSites((prev) => (prev ?? []).map((s) => (s.id === site.id ? { ...s, goals: saved } : s)));
    await loadRange();
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h2 className="section-title" style={{ margin: 0 }}>
          Conversions tracker
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          A conversion is the thing you actually want visitors to do — reach a thank-you page, press
          a download or buy button, follow a contact link. Tell TrafficPoppy what counts and it keeps
          a running total, next to the rest of your statistics. Counts only: who pressed is never
          recorded, and visitors who opted out (GPC or Do Not Track) are never counted at all.
        </p>

        {err && <div className="banner err">{err}</div>}

        {sites !== null && unlocked.length === 0 && (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            No site has Advanced Stats yet — unlock one in the Advanced stats tab to track conversions
            for it.
          </p>
        )}

        {/* The site picker, in the same shape as the Back up tab: what's covered is named
            before anything is set up, never discovered afterwards. */}
        {unlocked.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {unlocked.map((s) => (
              <button
                key={s.id}
                className={`tab${s.id === siteId ? " active" : ""}`}
                onClick={() => setSiteId(s.id)}
              >
                {s.domain || s.name}
              </button>
            ))}
            {locked.map((s) => (
              <span
                key={s.id}
                className="tab"
                style={{ opacity: 0.45, cursor: "default" }}
                title="Requires Advanced Stats"
              >
                {s.domain || s.name} 🔒
              </span>
            ))}
          </div>
        )}
      </div>

      {site && <SiteGoals key={site.id} site={site} range={range} onSave={save} onError={setErr} />}
    </div>
  );
}

/** Advanced Stats on this site — a subscription alone counts, a live address counts too. */
function unlockedBy(site: Site, props: { onlineDomains: string[]; paidDomains: string[] }): boolean {
  return (
    props.paidDomains.includes(site.domain) ||
    props.onlineDomains.some((d) => isFirstPartyFor(site.domain, d))
  );
}

function SiteGoals(props: {
  site: Site;
  range: RangeStats | null;
  onSave: (goals: Goal[]) => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const goals = props.site.goals ?? [];
  const stats = new Map((props.range?.goals ?? []).map((g) => [g.name, g]));
  const [adding, setAdding] = useState<Goal["kind"] | null>(null);
  const atLimit = goals.length >= MAX_GOALS;

  return (
    <div className="stack">
      {goals.length === 0 && adding === null && (
        <div className="card card-2 stack">
          <div className="section-title" style={{ margin: 0 }}>
            What do you want to count on {props.site.domain || props.site.name}?
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Pick one to get started — you can add more later, up to {MAX_GOALS}.
          </p>
          <KindChoice onPick={setAdding} />
        </div>
      )}

      {goals.map((g) => (
        <GoalCard
          key={g.name}
          goal={g}
          stats={stats.get(g.name)}
          uniques={props.range?.uniques ?? 0}
          site={props.site}
          onRemove={async () => {
            try {
              await props.onSave(goals.filter((x) => x.name !== g.name));
            } catch (e) {
              props.onError((e as Error).message);
            }
          }}
        />
      ))}

      {adding !== null && (
        <AddGoal
          kind={adding}
          site={props.site}
          existing={goals}
          onCancel={() => setAdding(null)}
          onAdd={async (goal) => {
            await props.onSave([...goals, goal]);
            setAdding(null);
          }}
        />
      )}

      {goals.length > 0 && adding === null && (
        <div className="card card-2 stack">
          <div className="section-title" style={{ margin: 0 }}>
            Add another conversion
          </div>
          {atLimit ? (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {MAX_GOALS} conversions is the limit for one site — remove one to add another.
            </p>
          ) : (
            <KindChoice onPick={setAdding} />
          )}
        </div>
      )}
    </div>
  );
}

/** Step 1 — the only question the user has to understand. Two answers, no jargon. */
function KindChoice(props: { onPick: (kind: Goal["kind"]) => void }) {
  return (
    <div className="grid-2">
      <button className="card card-2 stack" style={choiceStyle} onClick={() => props.onPick("page")}>
        <strong>📄 Someone reaches a page</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          A thank-you page, an order confirmation, a "welcome aboard" page.
        </span>
      </button>
      <button className="card card-2 stack" style={choiceStyle} onClick={() => props.onPick("event")}>
        <strong>🖱️ Someone presses a button or link</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          A download button, a buy button, a contact or booking link.
        </span>
      </button>
    </div>
  );
}

const choiceStyle: React.CSSProperties = {
  marginBottom: 0,
  textAlign: "left",
  cursor: "pointer",
  alignItems: "flex-start",
  gap: 4,
};

/** Step 2 — one field for a page goal, one for a button goal. Nothing else to decide. */
function AddGoal(props: {
  kind: Goal["kind"];
  site: Site;
  existing: Goal[];
  onAdd: (goal: Goal) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const isPage = props.kind === "page";
  // A page goal names itself from its address, so the usual case is one field, one click.
  const suggested = isPage ? normalizeGoalName(path.replace(/^\//, "") || "page") : undefined;
  const finalName = normalizeGoalName(name) ?? suggested;

  const add = async () => {
    setErr(null);
    if (!finalName) {
      setErr("Give this conversion a short name — lowercase letters, numbers and dashes.");
      return;
    }
    if (props.existing.some((g) => g.name === finalName)) {
      setErr(`You already have a conversion called “${finalName}”.`);
      return;
    }
    const cleanPath = normalizeGoalPath(path);
    if (isPage && !cleanPath) {
      setErr("Which page? Give its address, for example /thank-you.");
      return;
    }
    try {
      await props.onAdd({ name: finalName, kind: props.kind, ...(isPage ? { path: cleanPath } : {}) });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card card-2 stack">
      <div className="section-title" style={{ margin: 0 }}>
        {isPage ? "Which page counts as a conversion?" : "Which button or link should be counted?"}
      </div>

      {isPage ? (
        <label className="field">
          <span>Page address</span>
          <input
            className="input mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/thank-you"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      <label className="field">
        <span>Name it{isPage ? " (optional)" : ""}</span>
        <input
          className="input mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isPage ? suggested || "signup-complete" : "download"}
          autoCapitalize="off"
          spellCheck={false}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {isPage
            ? "What you'll call it in your statistics."
            : "Lowercase letters, numbers and dashes. You'll paste this name into your page in a moment."}
        </span>
      </label>

      {err && <div className="banner err">{err}</div>}

      <div className="row">
        <Button className="btn btn-primary" busyLabel="Saving…" onClick={add}>
          {isPage ? "Start counting this page" : "Create and show me what to paste"}
        </Button>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {isPage
          ? "Page conversions work backwards too: visits already recorded for that address are counted straight away."
          : "Nothing changes on your website until you add the small attribute we'll show you next."}
      </p>
    </div>
  );
}

/** A live goal: what it counts, whether it's working, and its numbers. */
function GoalCard(props: {
  goal: Goal;
  stats?: GoalStats;
  uniques: number;
  site: Site;
  onRemove: () => Promise<void>;
}) {
  const { goal, stats } = props;
  const [confirming, setConfirming] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const conversions = stats?.conversions ?? 0;
  const converters = stats?.converters ?? 0;
  const working = conversions > 0;
  const rate = props.uniques > 0 ? ((converters || conversions) / props.uniques) * 100 : null;

  return (
    <div className="card card-2 stack">
      <div className="spread">
        <div>
          <strong>
            {goal.kind === "page" ? "📄" : "🖱️"} {goal.name}
          </strong>{" "}
          <span className="muted mono" style={{ fontSize: 12 }}>
            {goal.kind === "page" ? goal.path : `data-tp-goal="${goal.name}"`}
          </span>
        </div>
        {/* The self-check: a button goal proves its own setup, so nobody has to guess
            whether their edit landed. */}
        {working ? (
          <span className="badge ok" title={`${conversions.toLocaleString()} in the last ${RANGE_DAYS} days`}>
            <span className="dot" /> Working
          </span>
        ) : (
          <span className="badge">
            <span className="dot" />{" "}
            {goal.kind === "page" ? "No visits yet" : "Waiting for the first press"}
          </span>
        )}
      </div>

      <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
        <Figure label={`Conversions · ${RANGE_DAYS} days`} value={conversions} prev={stats?.prevConversions} />
        <Figure
          label="Different visitors"
          value={converters}
          hint="Counted once per visitor within this site's recognition window."
        />
        {rate !== null && (
          <div>
            <div style={{ fontSize: 24, fontWeight: 650 }}>{rate < 10 ? rate.toFixed(1) : Math.round(rate)}%</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Of your visitors
            </div>
          </div>
        )}
      </div>

      {goal.kind === "event" && (
        <>
          {!working && <SetupSteps goal={goal} site={props.site} />}
          {working && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowSetup((v) => !v)}>
                {showSetup ? "Hide setup" : "Show what to paste"}
              </button>
              {showSetup && <SetupSteps goal={goal} site={props.site} />}
            </>
          )}
        </>
      )}

      {goal.kind === "page" && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Nothing to install: visits to <span className="mono">{goal.path}</span> are counted from your
          existing tracking snippet, including the ones already recorded.
        </p>
      )}

      <div className="spread">
        <span className="muted" style={{ fontSize: 12 }}>
          {goal.createdAt ? `Added ${goal.createdAt}` : ""}
        </span>
        {confirming ? (
          <span className="row">
            <span className="muted" style={{ fontSize: 12 }}>
              Stop counting this? The numbers you already have stay.
            </span>
            <Button className="btn btn-danger btn-sm" busyLabel="Removing…" onClick={props.onRemove}>
              Remove
            </Button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What to paste, with the two ways people actually do it: by hand, or by handing the job to
 * the AI that already edits their website (AGENTS.md §9 — onboarding is a prompt, not a
 * manual).
 */
function SetupSteps(props: { goal: Goal; site: Site }) {
  const attr = `data-tp-goal="${props.goal.name}"`;
  const example = `<a href="/download" ${attr}>Download</a>`;
  const [copied, setCopied] = useState(false);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="section-title" style={{ margin: 0 }}>
        Add this to the button or link you want counted
      </div>
      <div className="row" style={{ alignItems: "stretch" }}>
        <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap", padding: "8px 10px" }}>
          {attr}
        </code>
        <CopyButton text={attr} label="attribute" />
      </div>
      <div className="row" style={{ alignItems: "stretch" }}>
        <code className="chip" style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap", padding: "8px 10px" }}>
          {example}
        </code>
        <CopyButton text={example} label="example" />
      </div>
      <div className="banner info">
        <div className="spread">
          <span>
            <strong>Or let your AI do it.</strong> Copy this prompt into whatever AI edits your website —
            it explains exactly which element to change and how to check it worked.
          </span>
          <Button
            className="btn btn-primary"
            onClick={async () => {
              const ok = await copyText(buildGoalPrompt(props.goal, props.site));
              setCopied(ok);
              window.setTimeout(() => setCopied(false), 2500);
            }}
          >
            {copied ? "Copied ✓" : "✨ Copy the prompt"}
          </Button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Presses count from about a minute after you save the page — this card turns green on the first
        one. It works on anything you can click: buttons, links, images. Your tracking snippet already
        does the rest, so nothing else needs installing.
      </p>
    </div>
  );
}

function Figure(props: { label: string; value: number; prev?: number; hint?: string }) {
  const { value, prev } = props;
  const up = prev !== undefined && value > prev;
  const down = prev !== undefined && value < prev;
  return (
    <div title={props.hint}>
      <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
        <span style={{ fontSize: 24, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
          {value.toLocaleString()}
        </span>
        {prev !== undefined && prev > 0 && (up || down) && (
          <span
            style={{ fontSize: 12, fontWeight: 650, color: up ? "var(--poppy-ok)" : "var(--poppy-danger)" }}
            title={`Previous ${RANGE_DAYS} days: ${prev.toLocaleString()}`}
          >
            {up ? "↑" : "↓"} {Math.round(Math.abs((value - prev) / prev) * 100)}%
          </span>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </div>
    </div>
  );
}
