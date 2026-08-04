import { describe, expect, it } from "vitest";
import { COLLECTED, PRIVACY_PROMISES, SITE_FIELDS, TRUE_REACH } from "./catalogue";
import { buildHelperPrompt } from "./helper-prompt";

// The helper prompt IS the user's training, pasted into a foreign AI (AGENTS.md §9). Its one
// job is to never disagree with the form: every field the form renders appears, in the form's
// own words, and nothing is invented. These tests fail the moment the catalogue and the prompt
// drift apart — which is the only way a generated prompt can go wrong.
describe("the helper prompt", () => {
  const URL = "https://abc123.lambda-url.eu-west-1.on.aws";

  it("carries every form field with the label and explanation the form renders", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    for (const f of SITE_FIELDS) {
      expect(p).toContain(f.label);
      expect(p).toContain(f.explain);
      expect(p).toContain(f.placeholder);
    }
  });

  it("shows the snippet with this install's real collector origin", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p).toContain(`<script defer src="${URL}/t.js" data-site="YOUR_SITE_ID"></script>`);
  });

  it("serves the snippet first-party once True Reach is live", () => {
    const p = buildHelperPrompt({ collectorUrl: URL, trueReachDomain: "stats.ollydigital.com" });
    expect(p).toContain('src="https://stats.ollydigital.com/t.js"');
    expect(p).toContain("ALREADY LIVE on stats.ollydigital.com");
    // Honest scoping: one subdomain is first-party for ONE domain (DESIGN §14, 2026-07-25).
    expect(p).toContain(TRUE_REACH.scope);
  });

  it("advises the upgrade with the founder's benefit order: share/browser first, ad-block second, countries third", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    const share = p.indexOf("sharing them with a team");
    const adblock = p.indexOf("ad blockers likely hiding");
    const countries = p.indexOf("wanting country statistics");
    expect(share).toBeGreaterThan(-1);
    expect(share).toBeLessThan(adblock);
    expect(adblock).toBeLessThan(countries);
    // And it is honest that the free tier is desktop-only viewing, not crippled collection.
    expect(p).toContain("full collection, just desktop-only viewing");
  });

  it("knows returning visitors exist within the owner's 1–7 day window (§6b)", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p).toContain("new-vs-returning visitors");
    expect(p).toContain("1–7 days");
    // The monthly-uniques impossibility stays stated — the window doesn't soften it.
    expect(p).toContain("monthly unique counts are not computable");
  });

  it("pitches True Reach with the card's own words when it isn't set up", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p).toContain(TRUE_REACH.pitch);
    expect(p).toContain(TRUE_REACH.caution);
    expect(p).toContain("NOT set up yet");
  });

  it("lists everything a visit records, and nothing more exists to list", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    for (const c of COLLECTED) expect(p).toContain(c);
  });

  it("states every privacy invariant as a hard rule to plan within", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    for (const promise of PRIVACY_PROMISES) {
      expect(p).toContain(promise.label);
      expect(p).toContain(promise.what);
    }
    expect(p).toMatch(/mechanisms, not settings/);
    expect(p).toMatch(/Never suggest working around them/);
  });

  it("makes the AI refuse per-person analytics instead of inventing it", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p).toMatch(/session recordings/);
    expect(p).toMatch(/cannot do it and will never be able to/);
  });

  it("demands a fixed answer shape and allows a few questions first", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p).toMatch(/at most three short questions first/);
    expect(p).toMatch(/ANSWER IN EXACTLY THIS SHAPE/);
  });

  it("ends mid-sentence so the user's next words are the goal", () => {
    const p = buildHelperPrompt({ collectorUrl: URL });
    expect(p.endsWith("WHAT I WANT TO MEASURE: ")).toBe(true);
  });
});
