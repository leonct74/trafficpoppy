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
  template + Lambda zip — the proven `backend-bundle.ts` approach), reads aggregates for the
  dashboard, manages sites, runs teardown.
  - **Implementation decision (P0): the template is hand-authored TypeScript, not cdk.**
    MailPoppy's generator shells out to `cdk synth`; our footprint is one table now and a
    table + Lambda + Function URL + role at P1 — small enough to author directly in
    `infra/src/template.ts` (a pure builder), which drops the cdk dependency tree and the
    synth step from the build. `scripts/build-backend-bundle.mjs` evaluates it to the same
    asset-free template JSON the sidecar embeds; nothing downstream changes.
  - **Implementation decision (P0): deploy via inline `TemplateBody`, no S3 deploy bucket
    yet.** With the template passed inline and no Lambda zip until P1, **P0 creates nothing
    outside its own stack** — so teardown is just DeleteStack and there's no out-of-stack
    residue to sweep. The per-account deploy bucket arrives with P1's Lambda zip; at that
    point it must be tagged and removed by the `/teardown` hook (it lives outside the stack).
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
  Digital is not a processor. The in-app privacy note explains this plainly (MailPoppy's
  AdminPrivacyNotice pattern: reassuring, not scary, "guidance not legal advice").
  **Say it precisely (2026-07-25):** the claim is *"your visitors' data never reaches us"* —
  NOT a blanket "nothing reaches us". Once the premium dashboard is served from our CDN
  (§7c), a viewer's browser does fetch page assets from us, so access logs exist. The data
  path stays owner's-AWS → owner's-browser and carries nothing to us; a technical buyer will
  check this, so the wording must survive the check.
- **Banner-free by design**: nothing stored/read on the visitor's device (ePrivacy clean);
  no personal data at rest (GDPR: anonymous aggregates are out of scope; the transient IP
  in-memory is ordinary server processing, same as any web server log — legitimate interest).
- **What we never do**: cookies, localStorage, fingerprinting, full-URL referrers (query
  strings can carry emails/tokens — hostname only), raw IP storage, cross-day linking,
  cross-site linking, data sale — and no "trust us": the mechanism is **source-available and
  publicly auditable** (PolyForm Shield, per `LICENSE`). Do not write "open source": Shield is
  not OSI open source, and technical buyers of a privacy product will call that out.
- GPC/DNT honored (§3). UA reduced to coarse browser+OS families before storage.

## 6b. Consent-gated retention windows (founder idea 2026-07-25)

**Status: the BASELINE TIER (1–7 days, owner-chosen, default 1, no banner) is DECIDED and
BUILT — founder 2026-08-04** ("let the owner decide how long the salt is maintained, under
their responsibility"). The selector lives on each site's dashboard with the §rule-4 plain
wording; both the registry write AND the collector clamp to 7, so no stored value can ever
exceed the consent-free ceiling. The **extended tier (beyond 7 days, consent-gated) stays
NOT DECIDED** — it still needs counsel (questions (a)–(e) below), and the geo-unlock shape
remains rejected exactly as recorded. The default posture in §4/§6 (1-day salt, banner-free)
stays the product's spine.

**The want:** returning-visitor / multi-day audience insight, which §4 makes cryptographically
impossible today. **The mechanism:** the salt-rotation window becomes owner-configurable, so a
longer-lived pseudonymous hash can dedupe across days.

**TWO TIERS (founder decision 2026-07-25) — the banner is optional, not required:**

| Tier | Window | Consent banner | Who it's for |
|---|---|---|---|
| **Baseline** | **1–7 days, owner-chosen, default 1** | **none needed** | everyone — works out of the box |
| **Extended** | beyond 7 days (30/90/365) | required | owners who already run a CMP |

**Why the baseline needs no banner — the load-bearing legal point.** §6's banner-free claim
rests on *nothing being stored on, or read from, the visitor's device* (ePrivacy Art. 5(3)).
The salt lives **server-side**; the device is never touched at 1 day or at 7. So window length
does not trigger ePrivacy at all, and GDPR sets **no numeric rule** for anonymous
returning-visitor counting — only storage limitation (Art. 5(1)(e), "no longer than
necessary"), a purpose judgement rather than a fixed number.

What *does* scale with the window is the GDPR-side claim in §6 that there is "no personal data
at rest": during a live window the hash can single out a visitor across days, which is
pseudonymous, not anonymous (Recital 26). That risk is bounded and proportional — hence the
**7-day hard cap on the consent-free tier and a default of 1 day**. Beyond 7 days the honest
answer is a consent banner.

This is why the module is useful even to owners who never want a banner: they get
returning-visitor data inside a short window and stay exactly as compliant as today.

**THE LOAD-BEARING RULE — consent is the trigger; geo only decides whether to ask.**
The founder's first shape (country alone unlocks a longer window — EU short, rest-of-world
long) is **rejected, and must not be reintroduced**, because:
- Country comes from IP geolocation, which VPNs/proxies defeat — *verified live on 2026-07-25:
  a UK founder via VPN registered as IE*. A German visitor on a US VPN would classify as US and
  be tracked for a year without consent. **The failure mode is inverted: the more
  privacy-conscious the visitor, the weaker the protection they get.**
- "Non-EU = unrestricted" is false and decaying (UK PECR, CH, BR, CA, US state laws). A shipped
  country list is a *legal claim we must maintain forever*; stale list ⇒ customers non-compliant.
- It converts a **structural guarantee** ("cryptographically incapable") into a
  **configuration-dependent** one, and moves liability toward us — we'd be shipping compliance
  logic, not a neutral tool.

Under the rule, geo misclassification fails **safe**: a misclassified visitor is merely *not
asked*, and stays on the baseline window (≤ 7 days) — which needs no consent anyway.

**Data model** (small delta — the day partition and all pageview counters are untouched):
- Salt rows generalize `pk="salt", sk=<day>` → `sk="<bucket>#<window>"`, where
  `window = floor(epochDay / saltDays)`. **Old salts are still destroyed on rotation** — the
  unlinkability claim depends on it and is non-negotiable.
- Dedup rows `site#<id>#uniq#<day>` → `site#<id>#uniq#<bucket>#<window>`, TTL'd to window end.
- **Free new-vs-returning:** the conditional put already tells us if the hash existed — if it
  did, the visitor is *returning within the window*. `total#new` / `total#returning` counters
  need no extra identity retention beyond what the window already implies.
- Per-site config row: buckets + `saltDays` + per-region mode; unknown country ⇒ strictest.

**What each visitor state does — consent NEVER gates basic measurement:**

| Visitor state | Salt window | Counted (views, daily uniques, referrers, geo…) | In "returning visitors" |
|---|---|---|---|
| Consents | extended (30/90/365 d) | yes | yes, across the long window |
| **Declines** | **baseline (1–7 d)** | **yes, fully** | **yes, within the baseline window** |
| Never asked (no banner / module off) | baseline (1–7 d) | yes | yes, within the baseline window |
| GPC / DNT | — | **nothing at all** (§3, non-overridable) | no |

A decline never costs the owner a visitor, and — unlike the first draft of this section — it
no longer costs them the metric either: it only **shortens the window** from months to ≤ 7
days. Totals stay complete and accurate. That is a hard advantage over cookie-based analytics,
where a decline makes the visitor vanish and the totals wrong. The floor is always "today's
product plus a short returning-visitor window"; consent only ever *widens* it. Sales line:
*"worst case, you still have everything you have today."*

**Fail-safe rules (all three mandatory):**
1. Undetectable/unknown country ⇒ **strictest bucket**.
2. **GPC/DNT still means count nothing** — never overridable by owner config.
3. Conservative defaults (**baseline = 1 day**). Raising it inside 1–7 days is a free choice
   needing no warning — it stays banner-free. Crossing **7 days** is a hard gate: explicit
   owner opt-in carrying the plain warning *"beyond 7 days you are responsible for a consent
   banner,"* and the extended window then applies **only** to visitors who consented.
4. The UI states the trade in plain words at the point of choice — e.g. *"7 days: you'll see
   visitors returning within a week; a visitor stays linkable for up to 7 days."*

**Tier split — note the baseline needs NO geo, so it is not True Reach-only:**
- **Baseline (1–7 d) works on the FREE tier.** It is pure server-side salt arithmetic: no
  country header, no consent signal, no banner. Every user gets returning-visitor data out of
  the box — a real broadening of the free product, not a premium gate.
- **Geo (deciding where a banner is even needed) requires `CloudFront-Viewer-Country` ⇒ True
  Reach only.** Same for the extended tier's regional targeting. Monetization alignment holds:
  the premium tier unlocks *long* windows and the geo smarts, not the basic metric.

The tracker's **~1 KB budget test** caps the consent-read to a few bytes (documented
localStorage key + a tiny global for CMPs to call; storing the visitor's *consent choice* is
itself consent-exempt). The baseline tier adds **zero** tracker bytes.

**Costs to accept, stated honestly:** an extended salt **is personal data at rest** (stable
pseudonymous ID + behaviour), pulling the owner into data-subject-rights territory they are
currently exempt from — incl. the Art. 11 problem that erasure can't be honoured without
recomputing the hash from an IP we never store. And "unique visitors" stops being one number:
the dashboard must label windows explicitly, never blend them.

**Open for counsel — (e) is now the priority question:**
(a) is the consent-exempt status of the consent-record key safe in every target market;
(b) does consent-gated extension trigger a DPIA for typical owners; (c) Art. 11 posture when
erasure is architecturally impossible; (d) can we ship *any* jurisdiction list without becoming
an advice-giver; **(e) is a 7-day server-side salt defensible as the consent-free ceiling** —
i.e. does the §6 "no personal data at rest / banner-free" claim survive a 7-day linkable
window, and is there a shorter number counsel would prefer (CNIL's audience-measurement
exemption is the nearest precedent). **The 7-day cap is a founder judgement pending this
answer; the 1-day default means a stricter ruling costs us nothing already shipped.**

**Recommendation on record:** two tiers — a **banner-free baseline of 1–7 days (default 1) on
every tier including free**, and a **consent-gated extended window** beyond 7 days; geo used
solely to suppress unnecessary banners, never to unlock tracking. This keeps "banner-free by
default" literally true for every customer who does not opt in — the claim the product rests
on — while making returning visitors available to *all* users, not just premium ones.

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

## 7b. Team access — the browser dashboard (two-plane model)

The poppy screen is the **admin plane** (behind the admin's AWS connection — desktop only).
Organizations need colleagues to see reports **from a browser, without AgentsPoppy and
without AWS credentials**. Solution = the MailPoppy admin/member split, reapplied:

- The stack additionally serves a **read-only dashboard SPA** at the collector's own address
  (`/dash`; on True Reach it becomes `stats.<company>.com/dash` — a premium-feeling URL).
- **Viewer accounts = a Cognito user pool in the owner's account** (MailPoppy-proven
  machinery: AdminCreateUser invites, EMAIL_ONLY self-service reset, revocation). The admin
  manages viewers from the poppy; viewers log in with email/password in any browser.
- The read API Lambda enforces **read-only scope server-side from the verified JWT**
  (tenant-isolation lesson: never trust the client). Viewers can never touch AWS, sites
  config, or teardown.
- Everything — SPA, auth, data — stays in the owner's cloud; Cognito free tier ≈ $0.
- **Per-site authorization (the agency case — founder requirement).** One pool, many sites,
  different audiences per site: viewers carry **site grants as Cognito groups** (`site:<id>`
  + an `all-sites` group), which appear in the verified JWT. Admin UI = email + site
  checkboxes (or "all sites" for staff). The read API enforces grants **server-side from
  claims** (403 on any ungranted site — the MailPoppy tenant-isolation discipline); the SPA
  additionally hides ungranted sites entirely (client A never learns client B exists).
  Product story this unlocks: an agency deploys once in ITS AWS, adds every client site,
  and offers "private analytics included" — each client sees only their own dashboard; no
  analytics vendor holds anyone's data. For agencies, True Reach's natural extension is
  per-SITE custom domains (`stats.client-a.com`) — same single subscription.
- **Pricing position (REVISED 2026-07-25, founder): team access is PAID** — it is the reason
  the browser dashboard exists (a desktop-only view can't be shared with a team). Superseded
  the original "team access is FREE" line. The heritage rule survives intact because we charge
  **per capability, never per seat: unlimited viewers**. Unlocked by holding ≥ 1 active
  per-domain subscription (§12), and then covering all the owner's sites. Public share links
  (per-site anyone-with-the-link toggle) remain the free, unauthenticated sibling.
- **Sequencing: first item after P5** — essential for org adoption, not for the solo-dev MVP.
- **Where the premium reports actually live: see §7c.** The built-in dashboard the viewer
  Lambda serves is the FREE tier; the polished reports ship in an externally hosted client so
  they are not deployed into the customer's own account.

## 7c. The external client — how a Verified poppy still monetises (founder decision 2026-07-25)

> **AMENDED AGAIN (founder, 2026-08-04, later the same day): the browser dashboard is
> PAID — the free tier is desktop-only.** With the tier renamed "Online Dashboard", the
> founder chose to make the name literally true (and to match §7b's original instinct:
> "webpage analytics with premium quality diagrams and controlled access is payware").
> The gate is enforced **in the viewer Lambda, server-side, from the edge records in the
> owner's own table**: a site is served online only when its domain is covered by a
> deployed Online Dashboard edge — and an edge can only come to exist through the
> entitlement-gated setup. Never client-side filtering (the MailPoppy lesson), and never
> an entitlement call from the customer's Lambda to the platform (the privacy line below
> holds: nothing leaves the owner's AWS). Direct reads with a known site id 404 the same
> as listings; the page's empty state distinguishes "nothing shared with you" from "the
> upgrade isn't set up". The "plain built-in dashboard = free tier" row below is VOID.

> **AMENDED (founder, 2026-08-04): the built-in viewer IS the professional dashboard.**
> "TrafficPoppy must become a serious, compliant alternative to Google Analytics" — a plain
> free page failed that bar, so the viewer Lambda's page now carries the professional
> rendering (trend chart, traffic-flow chart, countries with flags, new-vs-returning), all
> hand-rolled SVG, still dependency-free. Consequence accepted with eyes open: that code is
> deployed into the customer's AWS and is copyable — **monetisation does NOT rest on chart
> quality; it rests on True Reach** (custom domain, geo, per-domain subscription). The
> external client below stays a valid future play (hosted convenience, branding loop,
> mobile UX) but is parked, not a prerequisite. The table's "plain built-in dashboard"
> row reads accordingly.

## 7d. Traffic flow — the "money flow" of visits (founder ask 2026-08-04)

Where visits come IN (sources), which pages they move THROUGH, and where they LEAVE —
rendered as a three-column flow chart. **The data model is aggregate-only and this is a
privacy line, not an implementation detail:**

- Two new counter families in the day partition: `entry#<source>#<landing-path>` (source =
  external referrer HOSTNAME or `direct`) and `edge#<from-path>#<to-path>` (same-site
  transitions). Counts only: **no visitor attached, no session id, no chain longer than one
  adjacent pair** — a path CANNOT be replayed per person, only summed per pair.
- The split between "entry" and "internal step" happens **in t.js**: many sites share one
  collector, so only the browser knows the site's own host. A same-site referrer becomes a
  `v` (previous path); the external-referrer invariant (hostname only) is untouched. An
  event is entry OR step, never both; a reload is neither.
- Exits are DERIVED at render time (arrivals into a page minus departures from it) — never
  collected. "Pages per visit" = views / entries.
- GPC/DNT still means nothing is counted; the tracker stayed under its size budget.

**The problem this solves.** The premium value is beautiful reports. If they ship inside the
poppy, they are (a) public in a Verified repo and (b) **deployed into the customer's own AWS**,
so the code lands in their possession and can be read straight out of their Lambda. No
obfuscation or entitlement check fixes that in a BYO-cloud product.

**The split.** Premium rendering moves OUT of the customer's cloud into an **externally hosted
client** (private repo) — the MailPoppy mobile-client precedent, and the platform's documented
majority pattern (`docs/IN_APP_PURCHASES.md` §3a "cross-app entitlement", ✅ already built:
`GET /api/entitlement?poppyId&productId&target` returns the unlock to an outside app).

| Stays in the poppy — public, auditable, **Verified** | External client — private |
|---|---|
| collector, tracker, salt + privacy mechanism | premium charts and reports |
| Cognito pool + **the read API** (it holds AWS access — exactly what must be auditable) | polished/mobile UX |
| a plain built-in dashboard = **the free tier** | |

**The rule that keeps the privacy pitch intact: the client talks to the customer's OWN API
directly and never proxies through us.** We ship rendering; data flows owner's-AWS →
owner's-device. (Hence the §6 wording fix — assets reach us, data does not.)

**Branding is the monetisation lever, and the mechanism already exists.** Free tier is served
from an agentspoppy subdomain, so every shared dashboard advertises the platform (the
Calendly loop — and the audience seeing a TrafficPoppy dashboard is teammates and agency
clients, i.e. exactly the profile that becomes AgentsPoppy users). Paid tier serves the same
client from the customer's own domain — **True Reach already does custom domains**, so
"remove our branding" needs no new machinery. It also sharpens the agency case: an agency
showing dashboards to its clients will pay specifically to not carry someone else's brand.

**⚠ Platform note (applies to AgentsPoppy, not this poppy).** TrafficPoppy is first-party, so
an `*.agentspoppy.com` subdomain is safe here. Do **not** extend that to third-party
developers: subdomains share the registrable domain, so any cookie scoped to
`.agentspoppy.com` is readable by every subdomain, putting outside developers' JS inside the
accounts/billing cookie boundary — and inviting `billing.agentspoppy.com`-style phishing.
Third-party clients belong on a separate registrable domain (the `googleusercontent.com` /
`githubusercontent.com` pattern), ideally on the Public Suffix List. The viral benefit comes
from a visible "Powered by AgentsPoppy" badge, not from the DNS name, so nothing is lost.

**Why this needs no change to the Verified policy.** Verified requires *auditability, not
price*: public, build-bound source so anyone can audit what the poppy does with the access it
is granted. A paid poppy satisfies it as long as the part touching AWS is readable — which is
exactly the split above. `DEVELOPER_TERMS.md` already names PolyForm/FSL (restrictive-use
licences) as acceptable, so the policy contemplates paid + public today.

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
6. **Returning visitors.** Impossible across days under the pure design (daily salt kills
   cross-day linking — deliberately; within-day repeat visits are already countable). Three
   paths, decided lean = (b) as opt-in, default OFF:
   (a) monthly salt rotation — no device storage but a 30-day-stable pseudonymous hash;
       grey under GDPR, dilutes the headline claim → rejected as default;
   (b) a NON-identifying first-party marker (`first_seen: <month>` — a cohort value shared
       by every same-month visitor, not an ID) → new-vs-returning % + retention cohorts with
       zero personal data; the residual issue is ePrivacy device-storage: formally exempted
       for first-party audience measurement in some markets (FR/IT style), consent-leaning
       in others (DE) → ship as per-site opt-in with a plain-language market note;
   (c) consent-gated precise metric for sites that already run a banner → post-MVP hook.
7. **Jurisdiction-aware policy engine (founder idea, post-MVP — no competitor has it).**
   Per-visitor-country rules — but NOT "strict for EU, track the rest": (i) for EU-established
   owners GDPR Art 3(1) covers ALL their processing regardless of visitor location, so
   geo-switching only truly helps non-EU owners (Art 3(2) reaches only visitors in the EU);
   (ii) the "no rules" map shrinks yearly (Thailand PDPA, Brazil LGPD, Japan APPI…).
   Buildable version: the aggregates-only pipeline + daily salt stay an INVARIANT FLOOR
   everywhere (the brand); geography gates only grey-zone opt-ins — e.g. the §10.6 cohort
   marker auto-on in exempting markets (FR/IT class), off elsewhere (DE class). Needs visitor
   country → free via CloudFront-Viewer-Country once the custom-domain tier ships (§9);
   sequence after it. UI framing: owner is the controller; guidance, not legal advice.
   Nearest existing art is CMP geo-targeted consent banners + GA4's regional ad toggles —
   nobody does an in-analytics per-country policy engine.

## 11. Decisions locked (founder, 2026-07-17)

- **Name: TrafficPoppy** (`com.trafficpoppy.desktop`). §10.1 closed.
- **utm allowlist**: exactly `utm_source/medium/campaign`, everything else dropped. §10.2.
- **Abuse cap**: per-site daily write cap, ON by default, generous; dashboard warning when
  tripped. §10.3.
- **Teardown**: type-to-confirm offers "download your data as JSON first". §10.4.
- **Site ids**: random short ids. §10.5.
- **Returning visitors**: cohort-marker opt-in, default OFF (§10.6). **Geo policy engine**:
  post-MVP, invariant floor (§10.7).
- **Quality bar (founder)**: premium-quality data reports and premium look & feel — the
  free tier must FEEL like a paid product. See P3 in the plan.

## 12. Monetization (decided direction)

**Free forever:** the entire core — unlimited sites, unlimited retention, full dashboard,
read API/schema, teardown export. The user hosts their own data; charging for the basics
would betray the BYO-cloud story and the marketplace's goodwill economics.
*(Amended 2026-08-05: "teardown export" moved to the paid tier — see the Back up & restore
entries in §14. The data itself stays open: it sits in the owner's own DynamoDB table with
a documented schema, readable with their own credentials at any time, so there is no
lock-in — the paid part is the convenience of one-click backup/restore in the app.)*

**Premium = "True Reach" (one flagship feature, subscription):** the custom-domain tier.
Deploys CloudFront + ACM certificate + Route53 record (`stats.<their-domain>`) in their AWS
and moves collection first-party:

1. **Ad-blocker-immune measurement** — blocklists can't enumerate the owner's own subdomain.
   The dashboard makes the value visceral: a "True Reach" report showing measured traffic
   vs. the blocker-suppressed baseline ("+X% you couldn't see before"). This is the moment
   worth paying for.
2. **Geography reports** (country/city) — only the CloudFront tier carries
   `CloudFront-Viewer-Country`; structurally impossible in the free Function-URL tier, so
   the gate is honest, not artificial.
3. Later rides the same infra: the §10.7 jurisdiction policy engine.

**Mechanics:** AgentsPoppy in-app checkout (first-party product, `kind=subscription`,
owner's Stripe via the platform, flat 5% on processed sales; the standard purchase button
ships the mandatory "Manage billing" control for free). **Entitlement is PER DOMAIN** (founder decision
2026-07-25, superseding the earlier per-deployment/unlimited shape): each True Reach domain is
a paid unit, so the price scales with the value delivered and the founder keeps a single lever
— raise the per-domain price — to monetise harder later without repackaging. This also keeps
the house rule **"per domain, never per seat"** literally true. Indicative price **$14.99 per
domain / month**, deliberately low to drive AgentsPoppy adoption; **the founder sets the real
price in the platform, as for any owned poppy — it is not a code constant.** The AWS costs
(CloudFront/ACM ≈ cents) stay the owner's own, and unlimited *traffic* stays free because we
host nothing: competitors must meter pageviews, we structurally never have to.

**What the paid unit buys, and what it does not:** a paid domain = True Reach (first-party,
ad-blocker-immune collection + geo) for that domain. The **browser/team dashboard (§7b) is
unlocked by holding ≥ 1 active domain subscription and then covers all the owner's sites** —
priced per capability, never per viewer (unlimited viewers). The free tier keeps unlimited
sites, unlimited retention, and the desktop dashboard.

**Amended 2026-08-04 (gate 2):** the browser dashboard covers only sites whose own domain is
unlocked — a site without the upgrade never appears online, for anyone (§7c). "Covers all the
owner's sites" above is superseded.

**Amended 2026-08-05 (site-first):** the paid unit is unchanged — one subscription per
domain — but the **entitlement `target` is the SITE's registrable domain** (`example.com`),
never the stats hostname (`stats.example.com`). The customer buys "advanced stats for site
B"; the address under it is an implementation detail they may rename without touching the
subscription. The UI sells it that way too: a per-site list with an Unlock button, the
address derived afterwards (editable name in front of a fixed `.<site-domain>` suffix), so
paying for the wrong domain is structurally impossible. Pre-08-05 checkouts (none completed
live) would be keyed on the hostname; the UI honours either key so no one is charged twice.

**⚠ Two dependencies this pricing creates — both must be respected:**
1. **Platform has no quantity field.** `Pricing = {kind, amountMinor, currency, interval}` is a
   flat price (verified in `agentspoppy-web/src/app/developer/page.tsx`), so "N × $14.99" is
   not expressible today. Ship **tiered SKUs** instead (1 / 3 / 10 domains as separate flat
   products — the founder can price each freely, which satisfies the flexibility goal). A true
   per-unit quantity in the platform is the cleaner long-term fix, but TrafficPoppy must not
   block on it.
2. **Multi-domain True Reach becomes a prerequisite for any tier above 1** — the edge model is
   a single-domain singleton today (`edgeStackName`, one `EdgeStatus.domain`), so domain #2
   cannot be sold until it ships. **This does NOT block launch:** sell only the 1-domain tier
   first (honest and complete), and let multi-domain unlock the 3/10 tiers as the natural
   upsell. No external paywall or
steering (marketplace rule); source stays open — the subscription gates entitlement, not
secrecy (MailPoppy precedent).

**Explicitly not monetized:** the read API / BI surface (it IS the openness pitch — §1.4),
site counts, retention, or "advanced" cuts of the free reports.

## 13. Development plan (phased; each phase ends green: typecheck + tests + certify where it applies)

**P0 — Walking skeleton (the lifecycle before the product).**
Scaffold vm-poppy layout (`frontend/ backend/ infra/ scripts/`); manifest + permissionSet
(verify against the REAL assessor — substring trap); embedded-template deploy pipeline
(MailPoppy `backend-bundle` pattern) deploying an EMPTY stack (table only); `/teardown`
hook; `npm run certify` green on deploy→teardown; dev-install runs in AgentsPoppy.
*Acceptance: stack up, stack gone, zero residue, poppy visible in the container.*

**P1 — Collector core (data before pixels).**
`t.js` (SPA-aware, GPC/DNT, utm allowlist) + `POST /e` on the Function URL Lambda;
single-table aggregation writes (pure, unit-tested like mailbox.ts); daily-salt uniques w/
TTL; site registry (random ids); per-site daily cap. Live-verify on a real deploy: script
on a test page → counters correct → teardown.
*Acceptance: real pageviews land as correct aggregates; salt rotates; cap trips.*

**P2 — Dashboard MVP (the free tier exists).**
Sites screen (add → snippet + CopyButton → receiving-state), dashboard v1 (today/7d/30d:
views, uniques, top pages, referrers, browser/OS, viewport), empty states that teach,
cost line (approx-labeled), design-kit skin + accent. Injectable clients; component tests.
*Acceptance: a non-technical owner installs the snippet and reads real numbers unaided.*

**P3 — Premium-quality reports & polish (the founder's quality bar).**
- **Reports**: period-over-period comparisons (Δ% vs previous 7/30d), sparkline trends per
  metric, "top movers" (pages/referrers rising & falling), hour-of-day heat strip, live
  "last 30 minutes" ticker. All computed from the same counters — no new collection.
- **Charts**: bundled, dependency-light (hand-rolled SVG or uPlot — NO CDN; sandboxed
  webview). Consult the dataviz design method before the first chart: one visual system,
  light/dark correct, accessible.
- **Look & feel**: skeleton loading, animated count-ups, refined empty/error states, keyboard
  nav; the bar is "screenshot-ready for the Store listing".
- **Integrate screen**: API token, endpoint, schema doc, copy-paste curl + Athena examples.
*Acceptance: side-by-side with Plausible, TrafficPoppy's dashboard looks and reads better.*

**P4 — Hardening, dogfood, catalogue.**
Retention TTLs verified live; abuse cap surfaced; `certify` full cycle re-run;
**deploy on agentspoppy.com as the first production user** (dogfood + listing demo);
pack darwin-arm64 + win32-x64 (day-one, pipeline exists); catalogue listing v0.1.0
(icon, screenshots from the dogfood deployment).
*Acceptance: agentspoppy.com's real traffic visible in the founder's AgentsPoppy.*

**P5 — True Reach (the premium tier).**
AgentsPoppy checkout integration (first-party product + entitlement + purchase button w/
Manage billing); custom-domain flow (ACM DNS validation + CloudFront + Route53 — background
+ resumable, cert validation takes minutes); geo reports (country/city); the True Reach
comparison report; script cutover default-URL → custom domain with zero data loss.
*Acceptance: a paying owner sees blocked-traffic recovery and geography on their own subdomain.*

**P6 — Team access (first post-premium item; §7b).**
Read-only browser dashboard SPA served by the stack + Cognito viewer accounts with
**per-site grants (groups-in-JWT)** managed from the poppy + claims-scoped read API.
*Acceptance: a colleague with no AgentsPoppy and no AWS access reads live dashboards in a
browser; a viewer granted site A gets 403 on site B and never sees B in the UI; the admin
revokes per site in one click.*

**P7+ (backlog, ordered):** custom events + conversion goals · public share links ·
S3 rollups + Athena guide · weekly SES email report · §10.6 cohort marker opt-in ·
§10.7 geo policy engine · Linux poppy packages if the container's Linux user base
materializes.

## 13b. Planned, not built (founder-parked)

- **Tighten the online-dashboard gate (found 2026-08-06, deferred by the founder).** The
  viewer treats "a cert row exists" as "this domain is unlocked" ([viewer.ts] `edgeDomains`),
  and that row is written the moment the certificate is REQUESTED ([edge.ts] `deployEdge`) —
  so a setup that is merely *started*, never finished and never paid for, already unlocks
  browser access for that domain. The sidecar's deploy route verifies no entitlement either;
  the only barrier is the disabled button in the desktop UI, and the sidecar is reachable on
  loopback by the machine's owner. Consequence: pay for one domain, start (and abandon)
  setups for ninety-nine more, and all hundred appear in the browser dashboard — precisely
  what per-site pricing exists to prevent. Two fixes, in order:
  1. **Gate on a READY edge.** Stamp the cert row when the stack reaches CREATE_COMPLETE
     (`domain|arn|stack|ready`) and have the viewer require the stamp. Small, stays
     server-side, kills the abandoned-setup hole.
  2. **Make entitlement itself server-side.** Point the platform's purchase-notification
     URL (§12) at the *collector Lambda* — the one public endpoint a desktop poppy has —
     have it write an entitlement row per domain, and gate the viewer on that. Then a
     lapsed or absent subscription removes browser access with no UI in the loop.

## 14. Status

- 2026-07-17 — **Planning COMPLETE.** DESIGN.md drafted; §10 open questions answered by the
  founder (locked in §11); monetization decided (§12: free core + "True Reach" custom-domain
  subscription via AgentsPoppy checkout); phased plan in §13. Roadmap entry #8 in
  `agentspoppy/docs/ROADMAP.md` records the strategic rationale.
- 2026-07-18 — **P0 in progress.** Scaffold, manifest, template, sidecar and frontend all
  built and unit-green (38 tests; typecheck clean). Manifest rating asserted in CI against
  the REAL `assessPermissionSet`: **amber, both grants scoped, no risks to other resources**
  — cloudformation scoped to `stack/TrafficPoppyStack/*`, dynamodb to `table/TrafficPoppy*`.
  Two implementation decisions recorded in §2 (hand-authored template, no cdk; inline
  TemplateBody, no deploy bucket in P0). Remaining P0 gate: dev-install + rating check in the
  container, then a live deploy→teardown and `npm run certify` green — **pausing for founder
  confirmation before the first AWS write.**
- Next after P0: **P1 collector core** (t.js + POST /e Lambda, aggregation writes, daily-salt
  uniques, site registry, per-site cap).
- 2026-07-21 — **P0 + P1 COMPLETE, live-verified and CERTIFIED.** Real pageviews from
  ollydigital.com land as counters through the deployed collector. Three live-only bugs
  found and permanently fixed with regression tests: (1) public Function URLs need BOTH
  invoke permissions since Oct 2025 (§2 template carries both); (2) CORS is owned solely
  by the URL config — a handler that also emits CORS duplicates the header and browsers
  hard-reject; (3) sendBeacon bodies must be plain strings — a typed application/json Blob
  forces a credentialed CORS preflight that silently drops the beacon. Also learned on the
  first stack UPDATE: stack-tag changes make CloudFormation read every resource's tags, so
  the manifest carries the tag-READ grants + ContinueUpdateRollback (recovery updates the
  stack in place — never delete: that would burn the Function URL under installed
  snippets). `npm run certify` green: real deploy→use→teardown, 5 tagged resources before,
  **zero residuals** after our own hook (host cleanup off).
- 2026-07-21 — **P2 Dashboard MVP shipped.** Range read (`/sites/:id/range`, one Query per
  UTC day merged in memory), dashboard screen (today/7d/30d tabs, daily bars strip, ranked
  pages/referrers/browsers/OS/sizes + campaign source/campaign panels from the allowlisted
  utm counters), cost line from real 30-day usage (AGENTS.md §9). Range "visitors" is the
  sum of DAILY uniques — cross-day identity is impossible by design (§4) and the UI says so.
- Current: **P3 — premium-quality reports & polish** (§13). Owed observation: first daily
  salt rotation (uniques reset at UTC midnight) — check next session.
- 2026-07-23 — **P3 complete** (Integrate screen shipped; salt rotation observed live:
  per-day uniques reset across two UTC midnights). **P4 partial:** win32-x64 cross-build +
  both platform packages proven; abuse cap surfaced; mailpoppy.com live as second site
  (multi-site verified); agentspoppy.com registered, snippet pending. Owed before listing:
  certify re-run + screenshots + zip hosting.
- 2026-07-23 — **P5 (True Reach) STARTED — implementation decisions:**
  (1) **Edge stack** `TrafficPoppyEdgeStack` deploys to **us-east-1** (the only region
  CloudFront accepts ACM certs from): certificate (DNS-validated) + distribution fronting
  the collector Function URL. (2) **DNS is manual-first**: the app shows the two CNAMEs
  (ACM validation, stats.<domain> → *.cloudfront.net) with copy buttons — works with any
  DNS host, no Route53 grants; auto-Route53 can come later. (3) **tagged-as-self scoping**:
  acm/cloudfront ARNs are unguessable, so those grants use the SDK's `tagged-as-self`
  sentinel (session policy conditions on our attribution tag; stack tags propagate to cert
  + distribution) — rating stays amber, no beyond-own findings. (4) The distribution uses
  legacy **ForwardedValues, not an OriginRequestPolicy**: ORPs can't be tagged, so
  tagged-as-self could never authorize mutating them; the whitelist (content-type, UA,
  origin, dnt, sec-gpc, cloudfront-viewer-country — never Host) lives inside the taggable
  distribution. (5) The owner's public hostname reaches the collector via the static
  **`x-tp-host` origin header** (Host must stay the Function URL's own for routing);
  originOf() prefers it so t.js posts first-party. (6) **Country counters** `country#XX`
  from CloudFront-Viewer-Country only — strictly validated alpha-2, ZZ dropped, never an
  IP lookup; dashboard Countries panel renders only when geo data exists. (7) Checkout/
  entitlement DECOUPLED: mechanics ship first for founder dogfood; §12 checkout wraps
  later. Shipped so far: country pipeline + edge template + manifest (amber). Next: sidecar
  edge deploy/status/teardown + True Reach screen (hostname, CNAMEs, background-resume).
- 2026-07-25 — **P5 (True Reach) LIVE-VERIFIED end-to-end on ollydigital.com.** Real browser
  on the live site: first-party snippet in the DOM, `https://stats.ollydigital.com/t.js`
  serves over HTTPS with an ACM cert whose SAN is the domain, `sendBeacon` to
  `stats.ollydigital.com/e` returns 204, no GPC/DNT → the hit counts, and served t.js posts
  first-party (no cloudfront.net / lambda-url leaks). Country accumulation confirmed live —
  two VPN exits (NL, IE) show side-by-side in the Countries panel; `country#XX` rows ADD
  independently, never overwrite, no TTL. Two gotchas cost real time and are now locked:
  (a) **CloudFormation's ACM handler requests the certificate WITHOUT tags** (CloudTrail:
  `invokedBy cloudformation.amazonaws.com`, no RequestTag), so the birth-tag session-policy
  condition can never be satisfied via CFN → the **sidecar requests the cert itself**
  (born-tagged, IdempotencyToken) and passes the ARN to the distribution stack as a
  `CertificateArn` parameter; the edge template is CloudFront-only. (b) **Local OS DNS cache
  lags public resolvers by minutes** — `dig @1.1.1.1` resolved while the same machine's
  `curl`/browser still couldn't; verify first-party endpoints with `--resolve` until the
  stub cache refreshes, and tell owners their browser may lag too.
- 2026-07-25 — **Per-domain snippet fix (bug found in founder review).** True Reach is
  per-registrable-domain: `stats.ollydigital.com` is first-party ONLY for ollydigital.com.
  The Sites list had applied the live True Reach origin as a **blanket origin for every
  site**, so mailpoppy.com / agentspoppy.com were shown a snippet pointing at
  `stats.ollydigital.com` — cross-domain (third-party, ad-blockable), domain-conflating, and
  falsely premium-looking. Fixed: each site's snippet uses the True Reach origin only when
  `isFirstPartyFor(site.domain, edgeDomain)` (edge domain === or a subdomain of the site's
  registrable domain; suffix-spoofing guarded), else the free Function URL; the row shows a
  **"True Reach" badge** when first-party and a free-tier/upsell hint otherwise. Frontend-only
  (no redeploy); 6 tests added, suite green. **Open:** the edge model holds ONE domain
  (`edgeStackName` singleton, single `EdgeStatus.domain`) — giving other sites geo needs
  **multi-domain True Reach** (one cert+distribution per premium domain), a P5+ build to be
  designed alongside the §12 per-domain-vs-per-account pricing decision.
- 2026-07-25 — **P6a: entitlement wired (§12).** True Reach setup is now gated on a
  per-domain subscription: `host.isPurchased("true-reach", { target: <domain> })`, which maps
  §12's per-domain pricing straight onto the platform's existing `target` mechanism (MailPoppy's
  model) — no machinery of our own. Decisions: (1) the gate **fails CLOSED** — a commerce error,
  offline host, or missing capability yields "not entitled", never an accidental unlock, and the
  hook starts `undefined` so the UI shows neither state while checking. (2) The host verifies
  ownership **server-side**; we re-ask after checkout rather than trusting the value `buyProduct`
  resolves with. (3) Price is read live from `purchaseInfo` and never hard-coded, so the founder
  sets it in the platform (§12) and the UI follows. (4) ⚠️ **We render our OWN purchase button**,
  because this repo inlines the bridge rather than depending on `@agentspoppy/extension-sdk`
  (host.ts) — so the SDK's free "Manage" link does not apply and the platform's REQUIRED
  visible "Manage billing" control falls on us. It is rendered wherever the paid feature lives
  and is covered by a test named after the rule; **omitting it is grounds for de-listing.**
  Manifest gains the `commerce:purchase` capability; rating unchanged (medium, no beyond-own).
  Open: the product id `true-reach` must exist in the developer dashboard before checkout works.
- 2026-07-25 — **§7c recorded: premium rendering moves to an EXTERNAL CLIENT** (founder
  decision). Anything shipped inside the poppy is deployed into the customer's own AWS and can
  be read out of their Lambda, so premium charts live in a private, externally hosted client
  instead; the poppy keeps the collector, the privacy mechanism, the Cognito pool, the read API
  and a plain built-in dashboard as the free tier — all public, so **Verified is still earned**.
  Uses the platform's already-built cross-app entitlement. Free tier served from an agentspoppy
  subdomain (viral loop), paid served from the customer's own domain via **True Reach, which
  already exists** — "remove our branding" needs no new machinery. Also recorded: the §6 wording
  must be *"your visitors' data never reaches us"*, not a blanket "nothing reaches us" (CDN
  assets do), and "open source" is replaced by "source-available" (PolyForm Shield is not OSI).
  Platform note: never give third-party developers `*.agentspoppy.com` subdomains — shared
  registrable domain puts their JS inside the accounts/billing cookie boundary.
  **Consequence for P6a:** the built-in dashboard is now scoped as the FREE tier; the polished
  React reports are no longer destined for the Lambda — they belong to the external client.
- 2026-07-25 — **P6a STARTED — the viewer plane (§7b browser dashboard), backend complete.**
  Shipped green (219 tests): Cognito user pool + client and a SEPARATE viewer Lambda in the
  stack (a dashboard fault must never be able to drop a pageview; both handlers share ONE
  content-addressed zip); dependency-free RS256 JWT verification (`lambdas/src/auth.ts`, 17
  tests covering alg:none, HS256 confusion, wrong key/issuer/audience, expiry, tampering);
  the read API with **server-side per-site authorization from verified claims only**, using
  **404-not-403 so the API cannot enumerate which sites exist** (the agency requirement); a
  vanilla-JS dashboard page incl. the NEW_PASSWORD_REQUIRED first-login flow. Implementation
  decisions: (1) the range/live reduction moved to **`shared/src/range.ts`, imported by both
  the sidecar and the viewer Lambda** — two implementations of "what the dashboard shows"
  would drift silently and the two planes would disagree; the 62 existing backend tests pass
  unchanged against it, which is the evidence the extraction was faithful. (2) The viewer's
  execution role is **read-only on the table** (GetItem/Query only) — a total compromise
  cannot alter a counter. (3) `USER_PASSWORD_AUTH`, not SRP: hand-rolled SRP is exactly the
  crypto that goes subtly wrong, and the page carries no SDK. (4) The pool is **born tagged**
  from new stack parameters rather than trusting stack-tag propagation — a pool ARN embeds a
  random id, so its grant can ONLY be tag-scoped (the P5 ACM lesson, now load-bearing).
  **Permission budget — MEASURED, risk downgraded.** The manifest went 65 → **84 declared
  actions**, which raised the vm-poppy DR5 spectre (a vend rejected at 118% of the STS
  packed-policy budget). Measured by running the broker's own `sessionPolicyForConnection`
  over this manifest and deflating the result: the **live, known-good P5 config packs to
  ~1000 chars; P6a packs to ~1188 — a +18.8% increase over a configuration that demonstrably
  works in production today** (13 statements, 3927 chars plaintext). So the action *count* was
  the wrong thing to fear — what costs budget is statement and ARN length, and tagged-as-self
  grants share one condition block. Caveat: AWS's exact packing is not documented, so this is
  a ratio against a known-good baseline, not a proof; the real `PackedPolicySize` still gets
  checked on the first live vend, and the cognito action list is the thing to trim if it
  overflows. Repeatable: `scripts` in the scratchpad bundle `policy.ts` and diff the two.
  **Still to build:** the desktop "Viewers" admin UI, entitlement gating (§12), and porting
  the polished React reports to replace the minimal page.
- 2026-07-25 — **§6b recorded: consent-gated retention windows (PROPOSED, not decided).**
  Founder idea for multi-day/returning-visitor insight. Load-bearing rule: **consent is the
  trigger, geo only decides whether to ask** — the geo-alone variant is rejected on record
  (VPN misclassification inverts protection; "non-EU = unrestricted" is false and decaying; it
  would turn a structural guarantee into a configuration). **Founder decision same day: TWO
  TIERS** — a banner-free **baseline of 1–7 days (default 1)** available on **every tier
  including free** (pure server-side salt arithmetic: no device storage ⇒ ePrivacy untouched at
  any window, and GDPR sets no numeric rule), plus a **consent-gated extended window** beyond
  7 days. Returning visitors therefore ship to *all* users, not just premium; True Reach still
  gates geo + long windows. Needs founder go/no-go **and counsel (esp. the 7-day ceiling)**
  before any code.
- 2026-07-30 — **Helper prompt shipped (new platform requirement, AGENTS.md §9 + §10
  checklist).** The primary creation surface must hand the user a prompt that IS the
  onboarding: "Copy the helper prompt" → paste into any AI → add one sentence about what you
  want → get back exactly what to type and tick. Banner variant on the **"Add a site"** card
  (`Sites.tsx`), `btn btn-primary poppy-helper-pulse`, pulsing until first use, `Copied ✓`
  feedback, copying via the resilient `copyText` fallback (the host webview may not delegate
  `clipboard-write`, and a silent copy failure is a dead button). Compliance with the four
  rules: (1) **generated, never hand-written** — new `catalogue.ts` is now the single source
  for the add-site field labels/explanations, the `<script>` snippet builder, the snippet-step
  wording and the True Reach pitch/caution/scope; `Sites.tsx` + `TrueReach.tsx` **render** it
  and `helper-prompt.ts` **describes** it, so a field cannot drift from its description.
  (2) The **privacy invariants (§3, §4, §6) are the constraints** — and here they double as
  the pitch: the prompt tells the outside AI to explain back what will *never* be collected,
  and to refuse per-person analytics (session recordings, cross-day funnels) rather than
  invent it. Daily-only uniques and non-overridable GPC/DNT are stated so no AI promises a
  monthly unique count. (3) Fixed 7-item answer shape mapping onto the form, ≤3 clarifying
  questions first. (4) Ends mid-sentence on `WHAT I WANT TO MEASURE: `. True Reach appears
  with its **honest per-registrable-domain scope** (the 2026-07-25 fix above), and the
  snippet carries this install's real collector origin — first-party once True Reach is live.
  Also re-vendored the design kit's `.poppy-helper-pulse` into `frontend/src/poppy.css`.
  Frontend-only, no AWS surface touched; 9 new tests (`helper-prompt.test.ts`), suite green
  (187 across the four workspaces).
- 2026-08-04 — **Update banner shipped (a P1-era gap found live).** The backend has reported
  `updateAvailable` since P1, but nothing ever rendered it outside the technical-details
  panel — so a deployment missing new features looked broken rather than merely out of date
  (found when the founder asked "I don't see the update?"). `App.tsx` now shows a banner +
  "Update now" button through the normal deploy path; 4 regression tests in `App.test.tsx`.
- 2026-08-04 — **P6a first live vend: Cognito sub-resource creates CANNOT be birth-tagged —
  cognito grant split.** The stack update created the tagged user pool fine, then IAM denied
  `cognito-idp:CreateUserPoolClient` and CloudFormation rolled back cleanly. Cause: the
  broker's `tagged-as-self` compiler puts every `Create*` action behind an
  `aws:RequestTag/agentspoppy:app` condition (the birth-tag rule), but `CreateUserPoolClient`
  and `CreateGroup` create **sub-resources of a pool and their APIs take no tags**, so the
  condition can never match — exactly the corollary documented in the broker's `policy.ts`.
  Fix (manifest-only, mechanism untouched): those two actions moved to a second cognito grant
  scoped `arn:aws:cognito-idp:*:*:userpool/*` — the tightest AWS allows, since pool ids are
  random (no `TrafficPoppy*` name-scoping possible) and Cognito can't tag-gate them. Honest
  caveat: within a vended session those two calls would work against ANY user pool in the
  owner's account; every *other* cognito action (delete/update/admin/user ops) stays pinned
  to tagged-as-self pools, which bounds the blast radius to "could add a client/group to a
  foreign pool", not read or change one. Assessor: still **medium**. Budget: 13 → 14
  statements, 3927 → 4021 plaintext chars (+2.4% vs the 2026-07-31 measurement) — noise.
  Rule of thumb for future grants: any `Create*` whose API cannot carry tags at creation
  needs an ARN-scoped grant, not tagged-as-self (Lambda's `CreateFunctionUrlConfig` only
  works today because the lambda grant is name-scoped). Scope change supersedes the
  connection — the founder must re-approve TrafficPoppy's permissions before the retry.
- 2026-08-04 — **P6a LIVE-VERIFIED: the viewer plane is up in the founder's AWS.** After the
  grant split + connection re-approval, the stack update completed on the first retry:
  Cognito pool + viewer Lambda + Function URL created, templates in lockstep
  (`template-15208481a038a030`), update banner cleared itself. Live checks: `GET /` serves
  the dashboard with the full header set (`text/html`, `x-frame-options: DENY`, `nosniff`,
  `no-referrer`, `no-store`); `GET /api/sites` without a token → 401. The corner is now
  documented platform-wide (agentspoppy `AGENTS.md` §3 sub-resource block + §10 checklist
  line, commit 441ba14). Nit found while smoke-testing: `HEAD /` returns the JSON 404 (the
  router only matches `GET`) — harmless for browsers, not worth a statement. Next: invite
  the first viewer through Team access and complete the temp-password → dashboard flow
  end-to-end on a phone.
- 2026-08-04 — **Viewer flow verified end-to-end by the founder** (invite email → temp
  password → new password → dashboard; wrong email correctly rejected). Two founder UX
  fixes from that run: (1) ready screen is now **tabbed** (Your sites / Team access /
  True Reach) — with several sites both cards sat below the fold; inactive panels stay
  mounted so True Reach polling keeps feeding snippet origins. (2) The login page now
  **states the password rules** ("At least 12 characters, including an upper-case letter,
  a lower-case letter and a number") under the new-password field and replaces Cognito's
  raw `InvalidPasswordException` with that sentence — policy lives ONCE in
  `shared/password-policy.ts`, imported by both the template and the page, with tests
  pinning both sides so told-vs-enforced can never drift.
- 2026-08-04 — **The statistics page rides the True Reach domain (founder decision).**
  Browsing `stats.<domain>` was a bare 404 (it was only ever the collection endpoint) —
  now the edge routes `/t.js` + `/e` to the collector via pinned cache behaviors and
  EVERYTHING ELSE to the viewer Lambda as a second origin, so the dashboard lives at a
  memorable first-party address (`https://stats.ollydigital.com`) instead of the raw
  `*.lambda-url.*.on.aws`. Design points: (1) collection paths are pinned FIRST — a slow
  or broken page can never break beacon ingestion; (2) `ViewerUrlHost` is an optional
  parameter behind a `HasViewer` condition, so an edge stack deployed against a pre-P6a
  core still validates and a collector-only setup never nags; (3) the poll only DETECTS
  the pending edge update (`updateAvailable` from the edge template-key tag + parameter
  drift) — applying it is an owner click (`POST /truereach/update` → "Update True Reach"
  banner), the same never-auto contract as the core stack; (4) `authorization` is
  forwarded only in the HasViewer branch (legacy ForwardedValues, TTL 0 everywhere);
  (5) the Team access panel hands out the pretty address once `viewerAtEdge` is true —
  both URLs keep working. Trade-off accepted: the login page shares the domain visitors'
  browsers beacon to, and the free-tier page rides a premium feature. No new grants.
  Weighed and rejected: separate `dash.<domain>` (second cert + two more DNS records for
  no isolation gain — same account, same origin Lambda either way).
- 2026-08-04 — **The GA-alternative build: professional dashboard + traffic flow + the §6b
  baseline shipped.** Founder framing: *"TrafficPoppy must become a serious, compliant
  alternative to Google Analytics."* Three pieces, one release:
  (1) **Viewer dashboard v2** (§7c amendment above): trend chart (views area + visitors
  line; hour bars for Today), the **traffic-flow chart** (§7d: sources → pages → onward/
  left-the-site, ribbon widths = counts), countries as **flag + full name** (emoji
  regional-indicator arithmetic + `Intl.DisplayNames` — zero assets), new-vs-returning and
  pages-per-visit KPIs. Hand-rolled SVG; the page still loads nothing from outside its own
  origin except Cognito (test-pinned).
  (2) **Traffic-flow collection** (§7d): `entry#`/`edge#` counters; entry-vs-step decided
  in t.js (only the browser knows the site's host — this also stops same-site referrers
  polluting `ref#`); tracker stayed under budget (2048-char test) by trimming comments.
  (3) **§6b BASELINE decided + built**: per-site `saltDays` 1–7 (default 1) on the registry
  row; salt keys `w#<days>#<n>` for multi-day windows (1-day keeps the `YYYY-MM-DD` key so
  live deployments roll over without a salt reset); salt + hash rows TTL to window end +2d
  — **hash retention SHORTENED from the old fixed 40 days**; `total#new`/`total#returning`
  from one extra window-scoped conditional put (same hash, no extra identity); clamped to 7
  in BOTH the registry write and the collector; GPC/DNT untouched at every setting. The
  desktop selector card carries the rule-4 wording verbatim. Note for §14 readers: counters
  written before this release have no entry/edge/new rows — the dashboards show "—" or hide
  the card rather than implying zeros. Collector Lambda code + t.js changed ⇒ next stack
  update ships it (updateAvailable watches the code key).
- 2026-08-04 — **Dashboard polish pass (founder: "still feels quite basic").** Viewer page
  gains: a **"Right now" card** (per-minute views, last 30 min — the ticker partition was
  already served, just unused); **Δ% chips** on views/visitors vs the previous same-length
  window (`prev` was also already computed, unused); a **Top movers** card (biggest page
  gains/losses); **collapsible lists + one-click CSV export** on every list (client-side
  Blob, no re-fetch — fine here because this is a normal browser tab, not the sandboxed
  poppy frame); and a **custom from–to range**: the viewer API now accepts `from`/`to`
  (inclusive, 90-day clamp, never past today, same-length prev window; junk falls back to
  the rolling default). Shared rank caps raised (pages/referrers 50, utm 25, countries 250)
  — caps bound the payload, dashboards fold long lists; the desktop BarList folds at 12
  with "Show all". Still parked as a DESIGN decision, not a polish item: cross-dimension
  drill-down (segments) — needs per-combination counters, a real data-model cost.
- 2026-08-04 — **MULTI-DOMAIN True Reach: one small edge stack per domain.** The last
  functional blocker before per-domain pricing can sell domain #2. Decision (implementation,
  recorded): **each domain gets its own stack** (`TrafficPoppyEdge-<sanitized-domain>`, own
  sidecar-requested certificate, own distribution) rather than one shared distribution with
  many aliases — distributions cost nothing to exist (billing is per request either way),
  each domain validates its own cert instead of re-issuing a shared SAN cert on every add,
  domain #3 cannot break domains #1–2, and add/remove stays surgical, which is exactly the
  per-domain subscription's shape. Mechanics: the cert store becomes a per-domain registry
  (`cert#<domain>` → `domain|arn|stackName`); **the v1 single-domain row (fixed key
  `truereach`, 2-part value) migrates silently on first read and keeps v1's stack name**,
  so the live ollydigital deployment is never re-created and its DNS never changes. API:
  `GET /truereach → {edges: []}`, `POST` adds a domain, `DELETE /truereach/<domain>` and
  `POST /truereach/update {domain}` act on one domain; teardown with no domain sweeps all.
  UI: the True Reach card lists every domain with its own lifecycle (records, update
  banner, subscription badge + Manage billing, type-to-confirm remove) + an add-another-
  domain flow gated per domain (§12); Sites picks the first-party domain per site from the
  ready list; Team access hands out the first `viewerAtEdge` address. Entitlement was
  already per-domain — nothing to change there. No manifest changes (stack names stay
  under `TrafficPoppy*`). 325 tests green.
- 2026-08-04 — **Tier renamed ("True Reach" → "Online Dashboard", product id
  `online-dashboard`) and the browser dashboard GATED behind it** (founder decisions; §7c
  amendment block). Naming: "True Reach" didn't say what you buy; the founder's ranking of
  benefits is (1) open + share the statistics page from any browser on your own address,
  (2) ad blockers can't hide visitors, (3) countries — the pitch now leads in that order,
  and a test pins the order. Gate: `viewer.ts` filters sites to domains covered by a
  deployed edge (cert rows read from the owner's table; value's first `|`-part, so the
  gate is correct pre- and post- the v1 row migration); `/api/sites` carries `gated` for
  the honest empty state; the Team access panel hands out a link only when the tier
  exists, and explains the upgrade otherwise. Also fixed in passing: the privacy-promise
  copy still claimed a fixed 24-hour salt — now owner-controlled, 24 h default, 7-day max
  (§6b). Internal identifiers (routes, component names, `TRUE_REACH` consts) keep the old
  name deliberately. 328 tests green.
- 2026-08-04 — **Final naming + shape of the paid tier: "Advanced Stats", one tab, team
  access inside the paywall** (three founder decisions in sequence). (1) Tier renamed
  once more, Online Dashboard → **Advanced Stats** (product id **`advanced-stats`** —
  still nothing created in /admin, so id churn stays free); the founder's benefit order
  is pinned in the pitch (share online first, ad-block second, countries third).
  (2) **Team access joined the paywall**: the invite flow exists only once ≥1 domain has
  the tier — "otherwise they activate a service they cannot use." Deliberate exception:
  existing viewers stay listed and REMOVABLE with no active tier (a lapsed subscription
  must never lock the owner out of revoking access; test-pinned). (3) The two paid
  surfaces (domain setup + team access) merged into ONE **"Advanced stats" tab** — one
  product behind one name; tabs are now Your sites / Advanced stats. The viewer page's
  gated empty state says the same name. 332 tests green.
- 2026-08-04 — **Checkout live-verified to the Stripe page (founder; purchase deliberately
  not completed).** The full commercial chain now works: TrafficPoppy registered as
  first-party in the commerce plane (0%, `agentspoppy-web` `fee.ts`), product
  `advanced-stats` created in /admin ($9.99/year, 15-day trial — founder will tune the
  price; changes affect new checkouts only), the app's purchase card reads the live price
  (yearly shown as its monthly equivalent + "billed yearly · $9.99, after the free trial"
  + trial badge — the documented MailPoppy display rule, now in `displayPrice()`), and
  Unlock opens Stripe checkout with the domain as target. Entitlement API answers
  per-domain. Still to verify with a real purchase: entitlement flip + edge deploy under
  a live subscription. Also: the Team access site picker now badges each site
  online / not-online-yet with the grant-vs-purchase rule stated at the point of choice.
- 2026-08-04 — **Tab merge REVERTED (founder: "I lead you to the wrong direction").**
  Granting people all-domain access inside the purchase surface muddled both jobs. Final
  shape: **three tabs — Your sites / Advanced stats / Team access** (team on the right),
  with the Team access tab **locked (🔒, aria-disabled, dimmed) until Advanced Stats is
  live on ≥1 domain**. The locked tab stays pressable: it opens a modal — "To set up a
  team, Advanced Stats must be activated" — whose primary action jumps to the Advanced
  stats tab (founder UX rule: a dead control reads as broken; a lock must explain
  itself). All prior gating stands (viewer Lambda server-side, invite flow, removable
  lapsed viewers). 337 tests green.
- 2026-08-04 — **Viewer sessions persist until removed (founder rule: "the login screen
  is for revoked or signed-out people, not for the top of every hour").**
  RefreshTokenValidity 3650 days; id/access tokens stay 60 minutes so revocation still
  bites within the hour. The stats page stores the refresh token (localStorage `tp_rt`),
  silently trades it for fresh tokens at boot and once on any 401, and clears both on
  sign-out. Revocation = the existing Remove button (AdminDeleteUser kills the refresh
  token instantly). Needed `cognito-idp:UpdateUserPoolClient` in the manifest — the
  first-ever pool-client UPDATE; the third and last Cognito lifecycle verb to surface
  live (create/update/delete now all exercised).
- 2026-08-05 — **The add-domain field explains itself and blocks the two paid mistakes
  (founder: "should I add my domain, or stats., or any domain I have access to?").**
  Answer, now stated under the field: type a SUBDOMAIN of a tracked site — any name
  (stats., insights., …), it becomes the statistics page's address. The field validates
  live against the owner's sites using the same `isFirstPartyFor` matcher as the viewer
  gate: the bare website address is refused (visitors would land on the stats page
  instead of the site — suggests `stats.<domain>`), an unrelated domain is refused (it
  would bill per §12 yet put no site online), no sites yet points at "Your sites" first,
  and a valid subdomain confirms which site it will put online. Pasted URLs are
  normalized (protocol/path stripped). Desktop-only change; helper prompt updated.
  SUPERSEDED same day by site-first (below) — the free-text field is gone entirely.
- 2026-08-05 — **Advanced stats goes SITE-FIRST (founder: "if I add stats.A but I want to
  unlock B, how do I specify that?" — then approved the per-site-list proposal).** The
  tab now lists every tracked site: live sites show their address, DNS records, update
  banner, billing and remove; locked sites show an Unlock button that checks out FOR THAT
  SITE. Only after unlocking does the owner pick the address — an editable name in front
  of a fixed `.<site-domain>` suffix (stats pre-filled; www refused — that's the website
  itself). Entitlement target re-keyed to the site's registrable domain (§12 amendment);
  legacy hostname-keyed subscriptions honoured so nobody pays twice. Orphan edges (no
  tracked site under them) stay listed and removable. The card also states the
  one-dashboard rule up top once a page is live: every address serves the same dashboard,
  one login lists every unlocked site — ten sites never mean ten pages (founder concern,
  answered in-UI). Helper prompt + catalogue scope rewritten to match.
- 2026-08-05 — **Subscription-lapse handling (the last §12 gap before catalogue).** When
  the platform answers "no active subscription" under either key for a site with a live
  edge, the row shows a lapse notice: subscription ended, page and collection still
  running in YOUR AWS, renew (checkout for the site's domain) or remove (data stays,
  collection falls back to the AWS address). Deliberately no automatic teardown and no
  server-side cut-off: the stack is the owner's infrastructure, and the poppy never
  deletes resources on a billing signal — enforcement is the visible nag, v1 by design.
- 2026-08-05 — **Back up & restore shipped (the §12 "teardown export", built for the
  certify run — founder: "I would love to save the current captured statistics").**
  Sidecar `POST /backup` scans the table and writes one deterministic JSON per day to
  ~/Documents (frontends can't download — platform rule); `GET /backups` lists;
  `POST /restore` puts rows back (idempotent, file's version wins on key collision,
  two-step confirmed in the UI; only filenames matching ours are readable — never a
  generic file reader). THE WHITELIST IS THE PRIVACY CONTRACT and is re-applied on
  restore so an edited file can't smuggle rows in: kept = site registry (ids intact,
  snippets keep working) + aggregate day counters; never = salt, visitor-hash rows,
  live ticker, cert rows. Honest cost: after a restore, returning visitors count as new
  once per window. Card lives in "Your sites". Manifest gained `dynamodb:Scan`
  (TrafficPoppy* table only, rating still medium) → restart + re-approval owed.
- 2026-08-05 — **Back up & restore becomes a paid tab (founder: "we need motivations to
  convert into paid users, we are already giving nice free stats on the desktop").**
  Fourth tab "Back up", locked exactly like Team access (🔒, pressable, explaining modal
  → Open Advanced stats) until Advanced Stats is live on ≥ 1 domain; the panel renders
  nothing while locked. Supersedes §12's free-teardown-export line (amended in place):
  no lock-in is preserved because the data stays in the owner's table with a documented
  schema — the paid part is the one-click convenience.
- 2026-08-05 — **Backups are gated PER SITE, not per account (founder: "unlocked by
  domain, similarly to the advanced stats… to prevent users from downloading the dataset
  and building their own online stats").** A backup contains only sites whose domain is
  unlocked; their counters follow. The gate is derived in the sidecar from the deployed
  edge domains — the same source the viewer Lambda's online gate reads — so it can't be
  widened by anything the frontend sends (MailPoppy isolation lesson). Excluded sites are
  returned in `skippedSites` and NAMED in the card ("Not in this backup: …, a removal
  would take them with it"): a silent omission would be discovered only after a teardown,
  which is the one moment it cannot be fixed. The founder's own framing stands — a
  determined owner can always read their own table; the tier sells convenience, not
  access.
- 2026-08-05 — **Backup gets a per-site picker; removal gets its own (5th) tab.** Founder:
  the button said "Back up all statistics now" without ever showing WHICH sites were
  covered, and the remove panel — rendered below the tab strip, so it appeared under
  whichever tab was open — was hard to find. Now: the card lists sites before the button
  (unlocked = ticked checkbox, locked = disabled + 🔒 "needs Advanced Stats"), the button
  names what it will do ("Back up ollydigital.com" / "Back up 3 sites"), and the pick
  rides to the sidecar as `siteIds` which can only NARROW the server-side gate, never
  widen it. Removal moved into a 5th tab, **deliberately unlocked** — "you can always
  remove everything" is a platform promise that outranks the paywall, and burying it
  inside a paid tab would have broken it for free-tier users.
- 2026-08-06 — **Restore can no longer leave a website listed twice** (founder: "confirm
  restore doesn't create duplicates any more, otherwise we need to remove it"). The
  earlier fix only absorbed an EMPTY twin and reported a data-holding one as a conflict —
  which is still a duplicate, just a documented one. Now the twin is always absorbed: no
  counters ⇒ delete the placeholder row and keep the restored id; counters ⇒ merge the
  restored history ONTO the twin (it is the record the live snippet feeds) and drop the
  restored row. Exactly one record per domain survives either way, and it is always the
  one already receiving traffic, so no website ever needs its tag edited. `conflicts` is
  now always empty and kept only for API compatibility.
- 2026-08-06 — **The statistics page carries its own favicon**, inline as an SVG data URI:
  the page stays entirely self-contained (nothing ever leaves for a third party) and a
  missing `/favicon.ico` no longer 404s through the edge on every visit.
- 2026-08-06 — **Whitespace can never survive a copy from the UI (the `\040` lesson).**
  A validation CNAME pasted into Route 53 with ONE leading space is stored as a
  different name (`\040_3d47…`), served as authoritative NXDOMAIN, and looks perfectly
  normal in every console — it cost a live debugging session tracing "the record exists
  but doesn't resolve" all the way to Route 53's own test tool before the escape showed.
  Three layers now: `copyText` trims everything it puts on the clipboard, `RecordLine`
  trims what it renders AND sets `user-select: all` so a manual click selects exactly
  the value (a drag can't grab a neighbouring space), and the sidecar trims ACM's
  name/value at the source. Founder: "this mistake can happen to other users."
- 2026-08-05 — **Merge two records of the same website (the repair for the rebuild
  mess).** The restore-side fix below only absorbs an EMPTY twin; the founder's real
  situation had data on both sides — restored history in one record, live traffic in the
  other, three websites over. Deleting either would have destroyed real numbers, so the
  app now merges: `mergeSites(from, into)` adds every `count` onto the target day's row
  (arithmetic, never overwrite), deletes each source row as it lands, and removes the
  source site row LAST so a crash leaves the merge re-runnable. "Your sites" detects
  same-domain duplicates (bare-domain match, so `www.` differences count) and offers one
  button, defaulting to keeping the NEWEST id — that is the one the deployed snippet
  carries, so merging never asks the owner to edit a website again.
- 2026-08-05 — **Restore MERGES by domain instead of duplicating** (founder, on the real
  rebuild: "it created a duplication of the website records… I see 2 instances of each
  website, one with backup stats and one with the current one"). A restore after a rebuild
  lands beside sites the owner re-created while their history sat in the file. Restore now
  reads the existing sites first and, for every domain it brings back, deletes the OTHER
  site row for that domain **only when it holds no counters** — an empty twin is the
  placeholder the merge was supposed to absorb. A twin with real data is never deleted
  silently: it comes back as a `conflicts` entry and the card tells the owner to choose.
  Keeping the restored id (not the twin's) is deliberate — the snippet already deployed on
  the website carries it, so merging this way leaves the live tag working untouched.
- 2026-08-05 — **Packaged for the catalogue on the SHARED runtime (rule R1).** The SEA
  sidecar is retired as a shipping artifact: `backend/index.cjs` (esbuild → CJS, built by
  `scripts/build-backend.mjs`) plus `"runtime": "node22"` in the manifest's backend block.
  The platform provides Node. Result: **2.7 MB, one platform-neutral "any" package**
  instead of 114 MB darwin + 89 MB win32 — and the darwin/win32 cross-build machinery is
  no longer needed for releases. R1 forbids third-party runtimes and service binaries,
  not the poppy's own artifacts, so the embedded CloudFormation template + collector zip
  are untouched (and so is the stale-build trap: rebuild + full restart after any infra
  change). `minHost` is **0.3.0** — the host release that carries the shared runtime.
- 2026-08-05 — **Backup's gate corrected: the SUBSCRIPTION, not the deployed edge**
  (founder: "even if I unlock 3 domains subscriptions, I can only backup
  ollydigital.com"). The first cut derived everything from the cert registry, which meant
  a paid domain whose DNS wasn't finished was excluded — holding back numbers someone had
  already paid for, the worst direction to get this wrong. Now a site is backable when the
  host says it's subscribed OR an edge is live for it (the second keeps a lapsed
  subscription from stranding numbers that are still being collected). One `PaidProbe`
  per site in App feeds both the tab lock and the picker, so the Back up tab opens on a
  subscription alone. Trade-off accepted knowingly: only the host can answer "is this
  subscribed?", so that half arrives from the frontend and is convenience-gating, not
  security — which matches the founder's own framing (the table is the owner's; the tier
  sells convenience). The sidecar still derives deployed edges itself.
