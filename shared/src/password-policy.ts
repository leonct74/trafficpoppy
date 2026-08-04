/**
 * The viewer pool's password policy — the single source for BOTH the CloudFormation
 * template (what Cognito enforces) and the login page (what the user is told).
 *
 * Founder feedback 2026-08-04: a too-short password was rejected without the page ever
 * saying how long it had to be. Keeping the numbers and the sentence in one module means
 * the rule shown can never drift from the rule enforced.
 */
export interface PasswordPolicyShape {
  MinimumLength: number;
  RequireLowercase: boolean;
  RequireUppercase: boolean;
  RequireNumbers: boolean;
  RequireSymbols: boolean;
}

export const PASSWORD_POLICY: PasswordPolicyShape = {
  MinimumLength: 12,
  RequireLowercase: true,
  RequireUppercase: true,
  RequireNumbers: true,
  // Symbols stay optional: length is what buys entropy, and symbol demands are what
  // drive people to Password1! patterns.
  RequireSymbols: false,
};

/** The policy above as one plain-language sentence, shown under the new-password field. */
export function passwordRules(p: PasswordPolicyShape = PASSWORD_POLICY): string {
  const needs = [
    p.RequireUppercase && "an upper-case letter",
    p.RequireLowercase && "a lower-case letter",
    p.RequireNumbers && "a number",
    p.RequireSymbols && "a symbol",
  ].filter((x): x is string => Boolean(x));
  const last = needs.pop();
  const list = needs.length > 0 ? `${needs.join(", ")} and ${last}` : last;
  return `At least ${p.MinimumLength} characters, including ${list}.`;
}
