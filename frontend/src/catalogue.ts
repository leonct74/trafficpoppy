// The words the setup surface uses, in one place.
//
// AGENTS.md §9 requires the helper prompt to be GENERATED from the same catalogue the form
// renders — a hand-maintained second copy of this text would drift, and a helper that
// describes a field the form doesn't have is worse than no helper at all. So Sites.tsx and
// TrueReach.tsx render these constants, and helper-prompt.ts describes them. A field that
// changes here changes in both places, on the same commit.

export type SetupField = {
  key: string;
  /** The visible field label. */
  label: string;
  /** What it's for, in the plain words the prompt can hand to an outside AI. */
  explain: string;
  placeholder: string;
  required: boolean;
};

/** The "Add a site" form (DESIGN.md §7.1). Two fields — that's the whole install. */
export const SITE_FIELDS: SetupField[] = [
  {
    key: "name",
    label: "Name",
    explain: "What you'll call this site inside TrafficPoppy. Yours alone — visitors never see it.",
    placeholder: "Olly Digital",
    required: true,
  },
  {
    key: "domain",
    label: "Website address",
    explain:
      "The site's own address, without https:// — it's what decides whether the Online Dashboard can serve " +
      "first-party for this site, so a bare registrable domain is the useful answer.",
    placeholder: "ollydigital.com",
    required: false,
  },
];

/** The one-line install. Built here so the snippet the form shows and the snippet the prompt
 *  explains are the same string (§3: "one line, shown in the UI with a copy button"). */
export function buildSnippet(origin: string, siteId: string): string {
  return `<script defer src="${origin.replace(/\/+$/, "")}/t.js" data-site="${siteId}"></script>`;
}

export const SNIPPET_STEP = {
  title: "Paste this into your site's <head>",
  explain:
    "One <script> tag, about 1 KB, loaded with defer so it never delays the page. It counts a " +
    "view on load and on in-page navigation, so single-page apps work without extra wiring.",
};

/** The premium option (DESIGN.md §12). Rendered by TrueReach.tsx, described by the prompt. */
export const TRUE_REACH = {
  label: "Online Dashboard — your statistics on your own address",
  pitch:
    "Put your statistics page on your own address (stats.your-site.com) — open it from any " +
    "browser and share it with your team or clients. Collection moves to your subdomain too, " +
    "so ad blockers can't hide your visitors — and you see visitor countries.",
  caution:
    "You'll be asked to add two DNS records at your domain host. AWS-side cost: cents — " +
    "CloudFront's free tier covers typical sites.",
  /** Honest scoping — one custom subdomain is first-party for ONE registrable domain (§14, 2026-07-25). */
  scope:
    "A custom subdomain is first-party only for its own registrable domain: stats.example.com " +
    "makes example.com ad-blocker-immune and nothing else. Other sites stay on the free tier.",
  freeTierNote: "Free tier — served from your AWS address.",
};

/** What a visit actually records (DESIGN.md §3). Aggregate counters, nothing per-person. */
export const COLLECTED = [
  "which page was viewed (the path)",
  "the referrer HOSTNAME only — never the full URL, because query strings can carry emails and tokens",
  "the campaign tags utm_source, utm_medium and utm_campaign — exactly those three, everything else dropped",
  "a viewport size bucket, and a coarse browser + operating-system family",
  "with the Online Dashboard tier only: the visitor's country",
];

/** The privacy invariants (DESIGN.md §3, §4, §6; enforced in lambdas/src/core.ts and pinned by
 *  its tests). These are hard mechanisms, not settings — which is exactly why they belong in the
 *  prompt as constraints: the outside AI should plan within them AND be able to explain them. */
export const PRIVACY_PROMISES = [
  {
    label: "No cookies, no localStorage, no fingerprinting",
    what:
      "Nothing is stored on or read from the visitor's device, so there is no consent banner to show " +
      "under ePrivacy. This is structural, not a setting.",
  },
  {
    label: "The visitor's IP address is never written down",
    what:
      "It is seen in memory for one request, like any web server sees it, and never reaches storage.",
  },
  {
    label: "No visitor identifiers at rest",
    what:
      "A counting hash is salted with a random value that is rotated and destroyed on a schedule the " +
      "owner controls — every 24 hours by default, at most every 7 days. Once a window's salt is " +
      "destroyed, its visitors are permanently unlinkable to later ones. Tracking beyond the window, " +
      "and across sites, is cryptographically impossible, not merely disallowed.",
  },
  {
    label: '"Unique visitors" means DAILY uniques',
    what:
      "Weekly and monthly unique counts are not computable, by design — that is the price of destroying " +
      "the salt, and every privacy-first tool pays it. Don't promise me a monthly unique-visitor number.",
  },
  {
    label: "Global Privacy Control and Do Not Track are honoured",
    what:
      "Those visitors are not counted at all, not even anonymously. This is non-overridable — there is " +
      "no setting that turns it off.",
  },
  {
    label: "The data is yours and stays in your own AWS account",
    what:
      "One DynamoDB table of aggregate counters, in your account, in your region. Nobody else — including " +
      "the people who wrote TrafficPoppy — can see it, and one click removes all of it.",
  },
];
