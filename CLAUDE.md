# CLAUDE.md — TrafficPoppy

Operating guide for working in this repo. **`DESIGN.md` is the source of truth** — read it
fully before any work; when a design decision changes, update DESIGN.md in the same change.

> **Boundary:** TrafficPoppy is a standalone project that runs *on* AgentsPoppy (never forks
> it — FSL non-compete). The mailpoppy and vm-poppy repos are READ-ONLY reference material:
> copy patterns from them, never modify them from here.

## What this is

Privacy-first web analytics running **entirely in the site owner's own AWS**: a 1 KB script
tag → one collector Lambda (Function URL) → aggregate-only DynamoDB counters, deployed as
ONE CloudFormation stack by the poppy's sidecar; the poppy screen in AgentsPoppy is the
admin dashboard. Free core + one premium subscription ("True Reach": custom domain →
ad-blocker-immune collection + geo). Full rationale, phases P0–P7, and locked founder
decisions: `DESIGN.md` §11–13.

## Read these before coding (in order)

1. `DESIGN.md` (this repo) — the product, the privacy invariants, the plan.
2. `~/Projects/agentspoppy/AGENTS.md` — the framework contract (rating rules, teardown,
   manifest, design kit, plain language, "Show the money"). Its rules are hard requirements.
3. Reference implementations to REUSE, not reinvent:
   - `~/Projects/vm-poppy` — repo layout (`frontend/ backend/ scripts/`), manifest shape,
     SEA sidecar build (`scripts/build-sidecar.mjs`, incl. the `--win32` cross-target),
     `CopyButton`, packing/release/catalogue flow, DESIGN.md's DR1–DR6 lessons.
   - `~/Projects/mailpoppy/apps/desktop/node-sidecar` — the **embedded-template CFN deploy
     pipeline** (`scripts/build-backend-bundle.mjs` → `src/generated/backend-bundle.ts`:
     synthesized template + content-addressed Lambda zip baked into the SEA binary;
     Create/UpdateStack from the sidecar; no cdk for end users). This is P0's core pattern.
   - `~/Projects/agentspoppy/scripts/pack-extension.mjs` — packaging (darwin + win32).

## Non-negotiables (digest — AGENTS.md is authoritative)

- **Privacy invariants (never violate, in any commit):** no visitor identifiers at rest;
  daily-rotating salt destroyed every 24 h; IP never written; referrer HOSTNAME only;
  utm allowlist exactly `utm_source/medium/campaign`; GPC + DNT honored (count nothing).
- **Rating:** MailPoppy-class amber accepted (Lambda needs an execution role) — IAM
  name-scoped to `TrafficPoppy*` only. Verify the manifest against the REAL
  `assessPermissionSet` (the assessor matches action names by SUBSTRING — "GetConsoleOutput"
  →"put" class false-reds; see vm-poppy DESIGN DR3).
- **Declare only actions the backend actually calls** — STS packed-policy budget overflows
  otherwise (vm-poppy DR5: 31 actions = vend rejected at "118%"; 18 = fine).
- Every create carries the three attribution tags; **teardown hook required** and
  `npm run certify` (leaves-no-trace) must pass a real deploy→use→teardown cycle **before
  any catalogue listing**.
- **Costs visible in-app** (AGENTS.md §9 "Show the money") — TrafficPoppy should be the
  reference implementation of that rule.
- Design kit (`poppy.css`), plain language, background+resume, type-to-confirm destructive
  actions, `poppyAccent("com.trafficpoppy.desktop")`.

## Gotchas inherited from the poppy family (each cost real debugging time)

1. **🪤 Stale SEA sidecar masks Lambda/template changes.** The sidecar EMBEDS the CFN
   template + Lambda zip. After ANY change to backend/infra code: rebuild the sidecar and
   fully restart the app, or deploys silently report NO_CHANGE with old code. (Bit both
   MailPoppy and the family repeatedly.)
2. **Never `git add -A` after building binaries** — an 86 MB sidecar once landed in
   VM-Poppy's git history. `.gitignore` every build artifact FIRST (sidecar binaries,
   `*.exe`, `release/`, `build/`, `dist/`, generated bundles).
3. **Idempotency rule for any re-runnable writer:** deterministic keys, never `new Date()`
   as a sort-key fallback (MailPoppy importer lesson).
4. Tenant/site isolation is enforced **server-side from verified claims**, never by
   client-side filtering (MailPoppy security lesson; applies to the P6 viewer API).

## Working agreements (live AWS)

- **Explicit founder confirmation before any AWS command that creates/changes/deletes
  resources.** Read-only calls are fine.
- Live tests run in the founder's account → **tear down afterwards and verify clean**.
- The founder decides product questions; implementation questions get decided here and
  recorded in DESIGN.md.

## Commands (fill in as scaffolded — mirror vm-poppy's package.json)

- `npm install` · `npm run typecheck` · `npm run test` · `npm run build:sidecar` ·
  `npm run validate-manifest` · `npm run install-dev` (dev-install into AgentsPoppy)

## Status

P0–P2 complete (DESIGN.md §14): collector live-verified on a real site, leaves-no-trace
**certified** (zero residuals), dashboard MVP shipped. **Current phase: P3 — premium-quality
reports & polish.**
Remote: `https://github.com/leonct74/trafficpoppy.git`. Before the repo ever goes public,
run the pre-public checklist in `agentspoppy/docs/ROADMAP.md` (history secret scan, FSL
headers, no personal paths).
