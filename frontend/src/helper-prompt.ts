// The AI helper prompt (AGENTS.md §9, REQUIRED — founder 2026-07-30): onboarding is a
// prompt, not a manual. Instead of teaching people the setup screen, hand them a prompt that
// IS the teaching. They paste it into whatever AI they already talk to, add one sentence about
// their site, and get back exactly what to type, what to paste into their pages, and whether
// True Reach is worth it for them.
//
// Built LIVE from ./catalogue.ts — the same constants Sites.tsx and TrueReach.tsx render — so
// the prompt can never describe a field the form doesn't have.
//
// TrafficPoppy's twist on the pattern: its hard rules are a SELLING POINT. The privacy
// invariants go in not just so the outside AI plans within them, but so it can explain to the
// owner what will never be collected — the answer to "do I need a cookie banner?" is part of
// the onboarding, not a footnote.

import { COLLECTED, PRIVACY_PROMISES, SITE_FIELDS, SNIPPET_STEP, TRUE_REACH, buildSnippet } from "./catalogue";

export function buildHelperPrompt(opts: { collectorUrl: string; trueReachDomain?: string }): string {
  const fieldLines = SITE_FIELDS.map(
    (f, i) =>
      `${i + 1}. ${f.label}${f.required ? "" : " (optional, but fill it in)"} — ${f.explain} Example: "${f.placeholder}".`,
  ).join("\n");

  const collectedLines = COLLECTED.map((c) => `  - ${c}`).join("\n");
  const promiseLines = PRIVACY_PROMISES.map((p) => `- ${p.label} — ${p.what}`).join("\n");

  // The real origin, so the snippet in the answer is the one this install actually serves.
  const exampleSnippet = buildSnippet(
    opts.trueReachDomain ? `https://${opts.trueReachDomain}` : opts.collectorUrl,
    "YOUR_SITE_ID",
  );

  const trueReachState = opts.trueReachDomain
    ? `The Online Dashboard is ALREADY LIVE on ${opts.trueReachDomain} for its own domain. ${TRUE_REACH.scope}`
    : `The Online Dashboard is NOT set up yet. ${TRUE_REACH.pitch}`;

  return `You are helping me set up website statistics in TrafficPoppy — privacy-first web analytics that runs entirely inside my own AWS account, with no cookies and no consent banner. I will describe my website and what I want to learn from it, in my own words. Your job: tell me exactly what to enter in TrafficPoppy's "Add a site" form, where to paste the snippet, and whether the Online Dashboard upgrade is worth it for me. If my description is ambiguous or missing something important, ask me at most three short questions first.

THE FORM I WILL FILL IN — "Add a site":
${fieldLines}

THEN THE INSTALL STEP — "${SNIPPET_STEP.title}":
- ${SNIPPET_STEP.explain}
- TrafficPoppy generates the line for me once the site is added; it looks like this:
  ${exampleSnippet}
- I paste it into the <head> of every page I want counted. Tell me WHERE that is for my particular setup — a WordPress theme header or a header plugin, a Shopify theme.liquid, a Wix/Squarespace custom-code box, a Next.js or Astro layout file, Google Tag Manager, whatever fits what I describe. Be specific about the file or screen; that is the step people get stuck on.
- Nothing appears in the dashboard until the first real visit lands. The site row switches from "Waiting for first visit" to "Receiving data" on its own.

THE OPTIONAL UPGRADE — "${TRUE_REACH.label}":
- ${trueReachState}
- ${TRUE_REACH.caution}
- ${TRUE_REACH.scope}
- The free tier collects everything and shows it in the TrafficPoppy desktop app. The upgrade adds the ONLINE part: a statistics page on my own address (stats.my-site.com) that I and people I invite can open from any browser or phone — with charts including a traffic-flow view (where visits come in, which pages they move through, where they leave), plus ad-blocker-immune counting and visitor countries.
- Recommend it if what I described involves any of these, in this order of weight: (1) checking stats away from one desktop computer, or sharing them with a team, a client, or an agency; (2) ad blockers likely hiding a meaningful share of my audience; (3) wanting country statistics. Otherwise say the free tier is enough — full collection, just desktop-only viewing.

WHAT A VISIT RECORDS (this is the whole list — there is nothing more detailed anywhere):
${collectedLines}

HARD RULES OF THE PRODUCT — these are mechanisms, not settings. Never suggest working around them, and DO explain the relevant ones back to me, because they are the reason to use this thing:
${promiseLines}

Two things that follow, and that you should tell me plainly if my description brushes against them:
- If I ask for anything per-person — session recordings, a funnel following one visitor across days, "who visited", individual user journeys — say clearly that TrafficPoppy cannot do it and will never be able to, and then tell me what aggregate numbers answer the same business question instead.
- If I ask whether I need a cookie banner for TrafficPoppy: nothing is stored on the visitor's device, so this tool does not itself require one. Say that this is guidance and not legal advice, and that anything else on my site (ad pixels, embedded video, chat widgets) is judged on its own.

ANSWER IN EXACTLY THIS SHAPE:
1. Name: … (one line why)
2. Website address: …
3. Where to paste the snippet: … (the exact file or screen for my setup, and how to check it worked)
4. Online Dashboard: "yes — because …" or "not yet — the free tier covers this because …"
5. What I'll be able to see: … (the numbers that answer what I said I wanted, named as the dashboard names them)
6. What TrafficPoppy will NOT collect: … (the short honest version, in plain words I could paste into my own privacy page)
7. Anything I asked for that this tool can't do: … with the closest aggregate alternative, or "nothing"

WHAT I WANT TO MEASURE: `;
}
