// Conversion goals (DESIGN.md §7e) — the ONE definition of what a goal is.
//
// SHARED because four places must agree exactly, and a drift between any two of them is a
// silently wrong number: the desktop app (where goals are created), the sidecar (which
// validates and stores them on the site row), the collector Lambda (which refuses to count
// a goal that isn't registered), and the read model (which turns counters into a report).
//
// PRIVACY: a goal is a COUNTER, like everything else in TrafficPoppy. Registering one adds
// two aggregate rows per day — how many conversions, and how many distinct visitors within
// the site's salt window converted. Nothing about WHO converted exists anywhere, at any
// point, and a goal event carries no path, no referrer and no identifiers of its own.

/** What a goal counts. Two kinds, because users think in exactly these two questions. */
export type GoalKind =
  /** "Someone reached a page" — matched server-side against the pageview's path. */
  | "page"
  /** "Someone pressed a button or link" — carried by t.js from a data-tp-goal attribute. */
  | "event";

export interface Goal {
  /** Stable, lowercase, URL-safe. It is the counter key AND the attribute value. */
  name: string;
  kind: GoalKind;
  /** Page goals only: the exact path that counts, e.g. "/thank-you". */
  path?: string;
  /** ISO day the goal was created — the UI says "counting since …" instead of guessing. */
  createdAt?: string;
}

/**
 * The name grammar. Deliberately narrow: the name travels in a public HTML attribute and
 * becomes a DynamoDB sort key, so anything exotic is a footgun (and '#' would break the
 * `goal#<name>` sort-key grammar outright).
 */
export const GOAL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Per site. A soft product limit, enforced server-side: 20 goals is already a lot. */
export const MAX_GOALS = 20;

/** Tidy a user-typed name into the grammar, or undefined when nothing usable is left. */
export function normalizeGoalName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "")
    .slice(0, 40);
  return GOAL_NAME_RE.test(s) ? s : undefined;
}

/** A goal's path, in the same shape the collector stores pageview paths in. */
export function normalizeGoalPath(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const raw = v.trim();
  if (!raw) return undefined;
  // Accept a pasted full URL as well as a path — people copy from the address bar.
  const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/i, "");
  const p = (withoutOrigin.split(/[?#]/)[0] || "/").slice(0, 512);
  const path = p.startsWith("/") ? p : `/${p}`;
  // A trailing slash is the same page to a visitor but a different counter key; keep the
  // owner's literal choice EXCEPT for the root, which is always "/".
  return path;
}

/** Validate + normalize a list of goals coming from the UI. Throws a sentence, not a code. */
export function parseGoals(input: unknown): Goal[] {
  if (!Array.isArray(input)) return [];
  const out: Goal[] = [];
  for (const raw of input) {
    const g = raw as Partial<Goal>;
    const name = normalizeGoalName(g?.name);
    if (!name) {
      throw new Error(
        "A goal name can use lowercase letters, numbers, dashes and underscores — for example “download”.",
      );
    }
    if (out.some((o) => o.name === name)) {
      throw new Error(`You already have a goal called “${name}”. Give this one a different name.`);
    }
    const kind: GoalKind = g?.kind === "page" ? "page" : "event";
    const path = kind === "page" ? normalizeGoalPath(g?.path) : undefined;
    if (kind === "page" && !path) {
      throw new Error(`Which page should “${name}” count? Give its address, for example /thank-you.`);
    }
    out.push({
      name,
      kind,
      ...(path ? { path } : {}),
      ...(typeof g?.createdAt === "string" && g.createdAt ? { createdAt: g.createdAt } : {}),
    });
  }
  if (out.length > MAX_GOALS) {
    throw new Error(`${MAX_GOALS} goals per site is the limit — remove one before adding another.`);
  }
  return out;
}

/** Read the goals off a site's registry row (stored as one JSON string attribute). */
export function readGoals(json: unknown): Goal[] {
  if (typeof json !== "string" || !json) return [];
  try {
    return parseGoals(JSON.parse(json));
  } catch {
    // A malformed value must never take the collector down — it just means "no goals".
    return [];
  }
}

/** The counter sort keys a goal writes into the day partition. */
export const goalSk = (name: string) => `goal#${name}`;
export const goalUniqueSk = (name: string) => `goalu#${name}`;
/** The TTL'd partition the once-per-window converter check writes into. */
export const goalUniqPk = (siteId: string, day: string) => `site#${siteId}#uniqg#${day}`;
