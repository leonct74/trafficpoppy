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
import type { Goal } from "../../shared/src/goals";
import type { Site } from "./types";

/**
 * The Conversions tracker's own helper prompt (§7e): the owner has just created a goal and
 * now has to add one attribute to the right element on their site. That edit is the single
 * place this feature can go wrong, so it ships as a prompt for whatever AI already edits
 * their website — the same "onboarding is a prompt" rule as the site setup above.
 */
export function buildGoalPrompt(goal: Goal, site: Site): string {
  const attr = `data-tp-goal="${goal.name}"`;
  return `I use TrafficPoppy for privacy-first website statistics on ${site.domain || site.name}, and I've just created a conversion called "${goal.name}". I need you to mark the right element on my site so it gets counted.

WHAT TO DO:
1. Find the button or link on my site that represents "${goal.name}" — ask me which one if there is any doubt, and never guess between two candidates.
2. Add this attribute to that element, keeping everything else about it exactly as it is:
   ${attr}
   So it ends up looking like: <a href="/download" ${attr}>Download</a> — the attribute goes on the clickable element itself (a, button, or whatever wraps the click).
3. If the same action exists in several places (a header button and a footer link, say), tell me, and add it to every one of them if I say so — they all count towards the same total.
4. Tell me the exact file(s) you changed, and how I can check it worked: TrafficPoppy's "Conversions tracker" tab shows a green "Working" badge on the first press.

RULES:
- Do NOT add any script, tag manager, pixel or library. TrafficPoppy's existing snippet already handles this; the attribute is the entire change.
- Do NOT change the element's href, onclick, text, classes or styling.
- The attribute value must be exactly ${goal.name} — the name is what TrafficPoppy counts, and an unregistered name is silently ignored.
- Nothing about the visitor is recorded — the press is a counter. Don't add anything that identifies people, and don't suggest it.

If the element you need doesn't exist yet, say so plainly instead of inventing one.`;
}

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
    ? `Advanced Stats is ALREADY LIVE on ${opts.trueReachDomain} for its own domain. ${TRUE_REACH.scope}`
    : `Advanced Stats is NOT set up yet. ${TRUE_REACH.pitch}`;

  return `You are helping me set up website statistics in TrafficPoppy — privacy-first web analytics that runs entirely inside my own AWS account, with no cookies and no consent banner. I will describe my website and what I want to learn from it, in my own words. Your job: tell me exactly what to enter in TrafficPoppy's "Add a site" form, where to paste the snippet, and whether the Advanced Stats upgrade is worth it for me. If my description is ambiguous or missing something important, ask me at most three short questions first.

THE FORM I WILL FILL IN — "Add a site":
${fieldLines}

THEN THE INSTALL STEP — "${SNIPPET_STEP.title}":
- ${SNIPPET_STEP.explain}
- TrafficPoppy generates the line for me once the site is added; it looks like this:
  ${exampleSnippet}
- I paste it into the <head> of every page I want counted. Tell me WHERE that is for my particular setup — a WordPress theme header or a header plugin, a Shopify theme.liquid, a Wix/Squarespace custom-code box, a Next.js or Astro layout file, Google Tag Manager, whatever fits what I describe. Be specific about the file or screen; that is the step people get stuck on.
- Nothing appears in the dashboard until the first real visit lands. The site row switches from "Waiting for first visit" to "Receiving data" on its own.

WHAT I'LL SEE, on every tier (the app has six tabs: "Your sites", "Advanced stats", "Team access" 🔒, "Conversions tracker" 🔒, "Back up" 🔒, "Remove" — the locked ones need the upgrade and explain themselves when pressed):
- Page views, daily unique visitors, and new-vs-returning visitors within a recognition window I control (1–7 days, default 1 — set on each site's dashboard).
- Top pages, referrers, campaign tags, browsers, operating systems, screen sizes, views by hour, and a live last-30-minutes ticker.
- Ranges: Today, 7 days, 30 days, or custom dates; every list exports to CSV.

THE OPTIONAL UPGRADE — "${TRUE_REACH.label}" (the "Advanced stats" tab):
- ${trueReachState}
- ${TRUE_REACH.caution}
- ${TRUE_REACH.scope}
- The free tier collects everything and shows it in the TrafficPoppy desktop app. The upgrade adds the ONLINE part: a statistics page on my own address (stats.my-site.com) that I and people I invite can open from any browser or phone — with a traffic-flow chart (green ribbons where visits come in, red where they move on or leave), plus ad-blocker-immune counting and visitor countries.
- How unlocking works (site-first): the Advanced stats tab lists every site I track, each with an Unlock button. I unlock the SITE I want (that's what the subscription is for — one per site, keyed on the site's own domain), and only then pick a name for its statistics address: any word in front of my domain (stats is pre-filled; insights, analytics… also work — but not www, that's the website itself). The domain part is fixed to the site being unlocked, so there is no way to pay for the wrong domain.
- Ten sites never mean ten dashboards: every unlocked address serves the SAME statistics page — one login at any of them lists every unlocked site.
- Setting the address up is slow and that is normal: AWS copies the collector to its edge locations worldwide, usually 20–40 minutes and sometimes a few hours. It runs in my AWS account, not in the app, so I can close the app and come back. If I ask why it's taking so long, tell me to wait — never to remove it and start again, which only restarts the same wait.
- The one real setup failure: choosing an address that is already in use somewhere else (an old CloudFront distribution, another service). AWS refuses to attach a taken name, and the card will show the exact error and keep retrying. The fix is to remove the other use of that name — or pick a different name — never to redo the setup.
- If a subscription ends, nothing is torn down behind my back: the address keeps working in my AWS, and the app shows a notice with the two options — renew, or remove the address (all collected numbers stay either way; collection falls back to the AWS address).
- It also unlocks the "Team access" tab (locked until a domain is live): invite people by email — AWS sends them a temporary password — and grant all sites or only specific ones (the agency case). They can only read, their accounts live in my own AWS, and access is revocable at any time. Sites without the upgrade never appear in the browser, for anyone.
- And it unlocks the "Conversions tracker" tab: I say what counts as a conversion for a site — either "someone reaches a page" (give the address, e.g. /thank-you — this one works backwards, counting visits already recorded) or "someone presses a button or link" (I name it, then paste one attribute like data-tp-goal="download" onto that button; the app hands me a prompt to give to whatever AI edits my site, and the goal's card turns green on the first press). Conversions then show up on the dashboards next to everything else: how many, how many different visitors, and the share of visitors. Still counters only — never who pressed.
- And it unlocks the "Back up" tab: tick the sites to include and save their numbers to a local file, then restore them after a fresh setup — statistics survive a full removal. A subscription alone is enough (the statistics address doesn't have to be set up yet); sites without the upgrade are listed but not selectable, and any site left out of a backup is named on screen. Backups never contain anything about individual visitors.
- Removing TrafficPoppy has its own "Remove" tab (always available, never locked): it deletes everything it created in my AWS. Back up first if I want to keep the numbers.
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
4. Advanced Stats: "yes — because …" or "not yet — the free tier covers this because …"
5. What I'll be able to see: … (the numbers that answer what I said I wanted, named as the dashboard names them)
6. What TrafficPoppy will NOT collect: … (the short honest version, in plain words I could paste into my own privacy page)
7. Anything I asked for that this tool can't do: … with the closest aggregate alternative, or "nothing"

WHAT I WANT TO MEASURE: `;
}
