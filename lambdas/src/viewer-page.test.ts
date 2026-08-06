import { describe, expect, it } from "vitest";
import { PASSWORD_POLICY, passwordRules } from "../../shared/src/password-policy";
import { dashboardHtml } from "./viewer-page";

/**
 * Founder feedback 2026-08-04: a too-short new password was rejected without the page
 * ever saying how long it had to be. The rule shown must be the rule enforced — both
 * sides read shared/password-policy.ts, and these tests pin the user-facing half.
 */
describe("password rules on the login page", () => {
  const page = dashboardHtml({ region: "eu-west-1", userPoolClientId: "client123" });

  it("states the full requirement under the new-password field", () => {
    expect(page).toContain(passwordRules());
  });

  it("the sentence carries every enforced requirement, in plain language", () => {
    const s = passwordRules();
    expect(s).toContain(`At least ${PASSWORD_POLICY.MinimumLength} characters`);
    expect(s).toContain("an upper-case letter");
    expect(s).toContain("a lower-case letter");
    expect(s).toContain("a number");
    // Symbols are NOT required — the sentence must not demand what Cognito doesn't.
    expect(s).not.toContain("symbol");
  });

  it("replaces Cognito's unhelpful policy error with the actual rule", () => {
    // The page script maps InvalidPasswordException onto the rules sentence.
    expect(page).toContain("InvalidPasswordException");
    expect(page).toContain("doesn't meet the requirements");
  });

  it("spells out symbols only when the policy requires them", () => {
    expect(passwordRules({ ...PASSWORD_POLICY, RequireSymbols: true })).toContain("and a symbol");
  });
});

/**
 * The professional dashboard (founder decision 2026-08-04): trend + traffic flow +
 * countries with flags, all hand-rolled SVG. These pin the page's self-containment —
 * a viewer's first paint must never wait on a third-party download.
 */
describe("dashboard v2 — professional and fully self-contained", () => {
  const page = dashboardHtml({ region: "eu-west-1", userPoolClientId: "client123" });

  it("carries its own favicon inline — no /favicon.ico round trip, no external fetch", () => {
    expect(page).toContain('rel="icon"');
    expect(page).toContain("data:image/svg+xml");
  });

  it("loads NOTHING from outside its own origin except Cognito's login endpoint", () => {
    const externals = page.match(/https:\/\/[a-z0-9.-]+/gi) ?? [];
    for (const url of externals) expect(url).toContain("cognito-idp.");
    expect(page).not.toMatch(/<script src|<link rel="stylesheet"|@import|fonts\./);
  });

  it("renders countries as flag + full name, derived purely from the stored code", () => {
    expect(page).toContain("0x1F1E6"); // regional-indicator emoji arithmetic
    expect(page).toContain("Intl.DisplayNames");
  });

  it("ships the trend chart and the traffic-flow chart", () => {
    expect(page).toContain("trendSvg");
    expect(page).toContain("flowSvg");
    expect(page).toContain("Traffic flow");
    // The flow view is explicit that it is aggregate-only — the §7d privacy posture.
    expect(page).toContain("never individual visitors");
  });

  it("colours flow direction: green ribbons in, red ribbons out (founder feedback)", () => {
    expect(page).toContain('x2,"var(--ok)")'); // inbound ribbons
    expect(page).toContain('x4-8,"#ff7b72")'); // outbound/leaving ribbons
    expect(page).toContain("traffic coming in"); // and the legend says so in words
    expect(page).toContain("going on or leaving");
  });

  it("shows new vs returning and pages-per-visit KPIs", () => {
    expect(page).toContain("New visitors");
    expect(page).toContain("Returning");
    expect(page).toContain("Pages per visit");
  });

  it("carries the polish pass: live card, deltas, movers, CSV export, custom range", () => {
    expect(page).toContain("Right now"); // last-30-minutes ticker card
    expect(page).toContain("function delta"); // Δ% vs the previous window
    expect(page).toContain("Top movers vs the previous period");
    expect(page).toContain("downloadCsv"); // every list exports client-side
    expect(page).toMatch(/type="date"/); // custom from–to picker
    expect(page).toContain("from="); // and it queries the explicit-range API
  });

  it("CSV export builds from rows already on the page — no re-fetch, no external call", () => {
    expect(page).toContain("URL.createObjectURL");
    expect(page).not.toMatch(/fetch\([^)]*csv/i);
  });

  it("sessions persist: refresh token stored, silently traded for fresh 60-minute tokens", () => {
    // Founder rule 2026-08-04: the login screen is for revoked or signed-out people,
    // not for the top of every hour.
    expect(page).toContain("REFRESH_TOKEN_AUTH");
    expect(page).toContain('localStorage.setItem("tp_rt"');
    expect(page).toContain("refreshSession"); // boot restore + the one mid-session retry
    expect(page).toMatch(/if\(!retried\)/); // 401 → refresh ONCE → retry, never a loop
    // Sign-out is a real revocation of the local session: both tokens cleared.
    expect(page).toContain('localStorage.removeItem("tp_rt")');
  });
});
