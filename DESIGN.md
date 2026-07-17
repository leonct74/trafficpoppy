# DESIGN.md — TrafficPoppy

Source of truth for **TrafficPoppy**: privacy-first web analytics that run **entirely in the
site owner's own AWS account**. An AgentsPoppy extension ("poppy") built to the framework
(`~/Projects/agentspoppy/AGENTS.md` + `docs/INTEGRATION.md`). This doc records decisions and
rationale; update it whenever a decision changes.

> **Boundary:** TrafficPoppy is a standalone project. It runs *on* AgentsPoppy — it does not
> fork or clone it (FSL non-compete). It never touches the mailpoppy or vm-poppy repos.

---

## 1. What it is — and why it beats the SaaS analytics class

One-click deploys a **serverless collector** into the user's AWS, hands them a **~1 KB script
tag** for their websites, and the poppy's screen in AgentsPoppy is the **dashboard** (visitors,
pages, referrers, live view). Positioning against Plausible / Fathom / Simple Analytics — the
privacy-first tools, not GA:

1. **No vendor in the data path — at all.** Visitor data goes from the site straight into the
   owner's AWS. Olly Digital never sees a byte. The SaaS tools still say "trust our cloud";
   TrafficPoppy says "there is no one to trust but yourself." Same banner-free privacy design
   (see §6) — self-hosting doesn't waive GDPR/ePrivacy; the *design* does.
2. **First-party collection survives ad blockers.** Blocklists enumerate the SaaS domains
   (plausible.io, usesimpleanalytics.com…) and typically erase 20–40 % of traffic. A collector
   on the owner's own endpoint isn't on any list — TrafficPoppy measures traffic the SaaS class
   literally cannot see. (Even the default AWS execution URL is unenumerable; a custom
   `stats.<owner-domain>` CNAME — post-MVP — makes it bulletproof.)
3. **Cents, not subscriptions.** Serverless: ~$0 at idle, cents/month at realistic traffic vs
   €10–20+/month per site forever. Costs are SHOWN in-app (AGENTS.md §9 "Show the money" —
   TrafficPoppy should be the reference implementation of that rule).
4. **The data is an open surface, not a walled garden.** Because aggregates live in the owner's
   own DynamoDB/S3, TrafficPoppy exposes a documented, stable schema + a token-protected
   first-party read API — Athena/QuickSight/Grafana/any BI tool plugs straight in. Analysing
   and reporting the data on any other platform is a *feature*, not an export request.
   **(Core requirement, not nice-to-have — it's the founder's stated differentiator.)**
5. **Unlimited retention, no sampling, no plan limits** — it's just the owner's data in the
   owner's tables.

**Non-goals:** ad attribution, cross-site tracking, user-level profiles, session replay,
funnels (post-MVP at most). Anything that would require identifying a visitor is out — it
would break the entire compliance and brand position.

## 2. Architecture (serverless, one CloudFormation stack)

```
visitor's browser ── GET /t.js ──────────► collector Lambda (Function URL)
        │                                        │  serves the 1KB script (cached)
        └── POST /e {site,path,ref,w} ──────────►│
                                                 │  parse → validate → aggregate
                                                 ▼
                              DynamoDB `traffic` table (on-demand)
                                 counters: (site, day) × {page, referrer, browser…}
                                 uniques:  daily salted-hash conditional puts (TTL)
                                                 │
   AgentsPoppy poppy UI (dashboard) ◄── sidecar backend ── Query (scoped creds)
   site owner's BI tools           ◄── read API (token)  ──┘        │
                                                 (post-MVP) S3 daily rollups → Athena
```

- **Collector = one Lambda with a Function URL.** No API Gateway (cost + moving parts), no
  CloudFront in MVP. The Function URL both serves the script (`GET /t.js`, cache headers) and
  ingests events (`POST /e`). Custom domain via CloudFront + ACM is **post-MVP** (§9).
- **Storage = one DynamoDB table** (on-demand billing), single-table design:
  - `pk = site#<siteId>#day#<YYYY-MM-DD>`, `sk = <metric>#<value>`
    (e.g. `page#/download`, `ref#news.ycombinator.com`, `browser#firefox`, `total#views`)
    with an atomic `ADD count`. Reads for the dashboard are a handful of Query calls.
  - Uniques: `pk = site#<siteId>#uniq#<YYYY-MM-DD>`, `sk = <dailyHash>` conditional put;
    the count of items = unique visitors; TTL expires rows after ~40 days (raw hash rows are
    the most privacy-sensitive thing we hold — they must age out; the *counter* survives).
- **The sidecar backend** (Node SEA, MailPoppy pipeline) deploys/updates the stack (embedded
  synthesized template + Lambda zip — the proven `backend-bundle.ts` approach), reads
  aggregates for the dashboard, manages sites, runs teardown.
- **The poppy frontend** = dashboard + site management + the script-tag snippet with copy
  button (VM-Poppy's CopyButton pattern) + cost line.

## 3. The script (what runs on the visitor's page)

~1 KB, framework-free, no dependencies:

- Sends: site id, path, referrer hostname (not full URL), viewport bucket, and the page's
  own hostname. Fires on load + on History API navigation (SPA support).
- Sends **nothing identifying**: no cookie read/write, no localStorage, no canvas/font
  fingerprinting, no full IP handling client-side (the server sees the IP transiently as any
  server does).
- Respects `navigator.doNotTrack`/GPC? **DR7:** yes for GPC (it's CCPA-relevant and cheap);
  DNT is obsolete but honoring it costs one `if` — honor both. Counts nothing for those
  visitors (not even anonymously) — the honest reading of the signal.
- `<script defer src="https://<collector>/t.js" data-site="SITE_ID"></script>` — one line,
  shown in the UI with a copy button.

## 4. Uniques without identity (the compliance-critical mechanism)

Same design class as Plausible/Fathom, implemented honestly:

- Lambda computes `hash = sha256(dailySalt + ip + userAgent + siteId)` **in memory**; the IP
  is never written anywhere. The hash row (conditional put) counts the visitor once per day.
- `dailySalt` is a random value in the table, **rotated and destroyed every 24 h** by the
  Lambda itself (first request of a new UTC day rotates; no scheduler needed). Yesterday's
  hashes become permanently unlinkable — cross-day tracking is cryptographically dead.
- Consequence, stated in the UI and docs: "unique visitors" = *daily* uniques; weekly/monthly
  uniques are not computable, **by design**. That's the price of the privacy position and
  every privacy-first tool pays it.

## 5. Permission set & rating (eyes open)

TrafficPoppy deploys a CloudFormation stack containing a Lambda — and **a Lambda needs an
execution role**, so unlike VM-Poppy this poppy cannot be IAM-free. Same class as MailPoppy:

- Grants (draft): `cloudformation:*` scoped to `TrafficPoppyStack-*`; `lambda`, `dynamodb`,
  `logs`, `s3` creates + `tagged-as-self`/name-scoped mutations; `iam:CreateRole/PutRolePolicy/
  PassRole/DeleteRole…` **name-scoped to `TrafficPoppy*`** roles only; `pricing:GetProducts`
  (read-only, for live cost quotes). Everything stamped with the three attribution tags.
- **DR1 — accept a MailPoppy-class rating** (amber with scoped-IAM findings), not VM-Poppy's
  IAM-free amber. Mitigation = narrow name scoping + the transparency dashboard. Verify with
  the REAL `assessPermissionSet` before first release, and remember the **substring trap**
  (action names containing put/set/create/delete rate as writes — see vm-poppy DESIGN DR3).
- Declare ONLY actions the backend calls (STS packed-policy budget — vm-poppy DR5 lesson).

## 6. Privacy & compliance posture (the product's spine)

- **The site owner is the data controller.** TrafficPoppy is self-hosted software; Olly
  Digital is not a processor (nothing reaches us). The in-app privacy note explains this
  plainly (MailPoppy's AdminPrivacyNotice pattern: reassuring, not scary, "guidance not
  legal advice").
- **Banner-free by design**: nothing stored/read on the visitor's device (ePrivacy clean);
  no personal data at rest (GDPR: anonymous aggregates are out of scope; the transient IP
  in-memory is ordinary server processing, same as any web server log — legitimate interest).
- **What we never do**: cookies, localStorage, fingerprinting, full-URL referrers (query
  strings can carry emails/tokens — hostname only), raw IP storage, cross-day linking,
  cross-site linking, data sale — and no "trust us": the mechanism is open source.
- GPC/DNT honored (§3). UA reduced to coarse browser+OS families before storage.

## 7. Dashboard (MVP screens)

1. **Sites** — add a site (name + domain) → get the snippet (copy button); per-site status
   (receiving data? last event time); delete site (type-to-confirm, explains what's kept).
2. **Dashboard** per site — range picker (today / 7d / 30d): pageviews, daily uniques, top
   pages, top referrers, browsers/OS split, viewport split. Live-ish (30 s poll).
   Empty state teaches the snippet install.
3. **Cost line** (always visible, per AGENTS.md §9): "This month so far: ~$0.02 — Lambda
   requests + DynamoDB. Nothing running when nobody visits." Live Price List quote where
   feasible; *approx*-labeled fallback otherwise.
4. **Integrate** — the read-API token + endpoint, the table schema, copy-paste `curl` and
   Athena examples. (The founder's API story, made visible as a first-class screen.)

## 8. Reuse from the existing poppies (do NOT reinvent)

- **Deploy pipeline**: MailPoppy's asset-free CFN pattern — synthesized template + one
  Lambda zip embedded in the SEA sidecar (`backend-bundle.ts` generator), Create/UpdateStack
  from the sidecar, `NO_CHANGE`-vs-`lambdaCodeKey` cross-check. ⚠ Inherit the **stale-sidecar
  gotcha**: after any Lambda/template change, rebuild the sidecar or deploys silently no-op.
- **SEA build**: vm-poppy's `build-sidecar.mjs` incl. `--win32` cross-target (day-one
  win32-x64 + darwin-arm64 packages; the packer + host already support both).
- **UI**: poppy design kit (`poppy.css`), `poppyAccent("com.trafficpoppy.desktop")`,
  CopyButton, type-to-confirm teardown, background-resume (deploys keep running; reopening
  reconstructs state from CloudFormation — never a dead spinner).
- **Teardown**: `/teardown` hook → DeleteStack (+ any RETAINed data cleanup) → run
  `npm run certify` (leaves-no-trace) against a real deploy→collect→teardown cycle **before
  the first catalogue listing** (a lesson VM-Poppy learned late).

## 9. MVP cut vs post-MVP (ship small, honest defaults)

**MVP (v0.1.x):** one-click deploy · script tag (pageviews, SPA navigation, referrer
hostname, browser/OS, viewport bucket) · daily uniques · multi-site · dashboard (7/30d) ·
snippet + copy · cost line (approx) · read-API token + documented schema · teardown + certify.

**Post-MVP, in rough order:**
- **Custom first-party domain** (`stats.<owner-domain>`: CloudFront + ACM + Route53 — the
  adblock-bulletproof tier; also unlocks `CloudFront-Viewer-Country` → **geo/country stats**,
  which the MVP deliberately lacks because a Function URL carries no geo header).
- Custom events API (`tp("signup")`) · S3 daily rollups + Athena/QuickSight guide · public
  share links · weekly email report (SES) · live Price List quotes everywhere.

**Deliberately never:** individual visitor timelines, cross-site anything, IP logs, UTM-level
marketing attribution beyond referrer hostname + `utm_source` (decide at implementation —
query strings are a privacy minefield; if kept, allowlist exactly `utm_source/medium/campaign`).

## 10. Open questions (resolve before coding)

1. **Name.** "TrafficPoppy" (working title; founder's word). Checks: ends in "Poppy" ✓,
   unique in directory ✓. Alternatives considered: AnalyticsPoppy (clinical), CountPoppy.
   → Confirm with the founder, then reserve `com.trafficpoppy.desktop`.
2. **utm_source allowlist in MVP?** (see §9 "never" caveat).
3. **Rate limiting / abuse**: a public Function URL can be spammed → per-site daily write cap
   in the Lambda (protects the owner's bill; surfaced in the dashboard when tripped).
4. **Data on teardown**: delete everything (leaves-no-trace default) vs offer a final S3
   export first. Leaning: type-to-confirm offers "download a JSON export first" link.
5. **Site id**: random short id vs domain-derived. Random (domain can change; id is in the
   public script tag — must not be guessable-sequential).

## 11. Status

- 2026-07-17 — **Planning.** This DESIGN.md drafted; roadmap entry #8 in
  `agentspoppy/docs/ROADMAP.md` records the strategic rationale. Next: founder review of the
  open questions (§10) → scaffold repo (vm-poppy layout: `frontend/` + `backend/` + `infra/`
  + `scripts/`) → walking skeleton (deploy an empty stack + teardown + certify) → collector.
