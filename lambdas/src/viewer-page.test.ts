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
