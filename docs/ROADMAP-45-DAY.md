# ZoQ — 45-Day Launch Roadmap

_Start: 2026-09-18 (Day 1). Launch: 2026-11-01 (Day 45), one week before
Diwali (2026-11-08) — the festival calendar is the launch hook. Budget:
5 hrs/day × 45 = ~225 hrs. Solo. All three lanes are **sellable** at launch
with a scoped MVP each; the realtime clone is the one explicit post-launch
item. Every task references `MARKET-STRATEGY.md` (lanes, P1–P8) and
`TESTING-PLAN.md` (T-phases). Update `STATUS-TODO.md` as items close._

---

## Guiding rules

1. **Real pixels before features.** Week 1 ends with a real Aanya still and
   video shoot or nothing else moves.
2. **Automated tests land with the feature, not after.** Each week's
   deliverable includes its `TESTING-PLAN.md` phase. Manual testing is limited
   to the list in `TESTING-PLAN.md §8`.
3. **Long-lead items start Day 1** (Meta app review, YouTube audit, lawyer,
   Razorpay test keys, public S3). They gate launch, not code.
4. **Pending decisions (P1–P8) are decided by Day 10** so pricing code is
   written once.
5. **Scope down, never slip.** If a week overruns, cut the lane's optional
   items (marked ◇), not the launch date.

Hour estimates are for Claude-Code-assisted work and include tests.

---

## Week 1 — Foundation + first real pixels (Days 1–7, ~35 h)

| # | Task | Lane | Est. | Notes |
|---|---|---|---|---|
| 1.1 | Repo hygiene: delete `*.bak` files, `server.js.bak`; add `CLAUDE.md`; `.env` reconciled (one `APP_URL`, audience origins) | — | 2 h | |
| 1.2 | **CI skeleton** (T-A): GitHub Actions running `npm test` on backend, `next build` on frontend, Postgres service container, migrations 001–055 applied on a fresh DB | — | 4 h | Gate for every later PR |
| 1.3 | Re-cull Aanya to a balanced ~18 (**you: taste**) | 1 | 2 h | `recull-aanya.js` |
| 1.4 | Embed → train → calibrate Aanya on real fal spend | 1 | 4 h | Mac (insightface) |
| 1.5 | **First real still shoot**, then first video shoot end to end (prompt → still → QC → motion → voice → assemble → copy) | 1 | 8 h | Expect real-pixel surprises; fix, don't feature |
| 1.6 | Record the **golden shoot fixture** from 1.5 for tests (T-C) | — | 2 h | |
| 1.7 | Switch Razorpay to `rzp_test_` keys; create gateway plans for frozen tiers | — | 2 h | `link-razorpay-plans.js` |
| 1.8 | Start long-lead (**you**): Meta app review (IG publish + WhatsApp), YouTube compliance audit, public S3-compatible bucket, lawyer brief for clone/extraction/WhatsApp | — | 3 h | Track in STATUS-TODO |
| 1.9 | Worker cost guardrail: per-tenant daily fal spend cap + alert | — | 3 h | Protects Free tier |
| 1.10 | Aanya IG + YouTube accounts created, bio done, first 3 posts from 1.5 | 1 | 2 h | Disclosed as AI |
| 1.11 | Decide P1–P8 (**you**), record in MARKET-STRATEGY §7 | — | 3 h | Deadline Day 10 |

**Exit criteria:** CI green on a clean DB; one real Aanya reel exists; Aanya's
account is live; test keys in place.

## Week 2 — Lane 1 sellable: catalogue, pricing, publish (Days 8–14, ~35 h)

| # | Task | Lane | Est. |
|---|---|---|---|
| 2.1 | Generate → train → calibrate **6 catalogue personas** (Delhi/Punjab set) + preview images on cards | 1 | 8 h |
| 2.2 | Pricing page per decisions: Free cap (P1), 720p floor (P2), hide Ultra (P3), cadence framing (P4), annual + UPI Autopay (P5) | 1 | 6 h |
| 2.3 | Free-tier onboarding: signup → pick catalogue face → brief → stills in < 5 min; measure time-to-first-still | 1 | 5 h |
| 2.4 | Hinglish caption mode in `copy` stage (persona voice, code-switching) | 1 | 3 h |
| 2.5 | IG publish via Meta Graph API behind a feature flag; **fallback** while review is pending: download + copy-caption + reminder | 1 | 5 h |
| 2.6 | Human approve-before-post step on every shoot (queue → approve → publish) | 1 | 3 h |
| 2.7 | **E2E (T-D):** Playwright flows — signup, catalogue select, shoot, approve, billing checkout (Razorpay test) | — | 5 h |
| 2.8 | Aanya: daily posting from pipeline; content bank of 20 | 1 | ongoing |

**Exit criteria:** a stranger can sign up, pick a face, get stills, and pay
on test keys without help.

## Week 3 — Lane 2 sellable: brands (Days 15–21, ~35 h)

| # | Task | Lane | Est. |
|---|---|---|---|
| 3.1 | **Product-in-hand stills:** reference-image-conditioned still stage, product upload, QC gate unchanged | 2 | 8 h |
| 3.2 | **Brand kit:** logo, colours, tagline → prompt vocabulary + captions; 1 kit on Pro, 3 on Max | 2 | 4 h |
| 3.3 | Hindi voice in `voiceStage.js` (+ Tamil/Telugu ◇); listener validation with 5 native speakers (**you**) | 2 | 4 h |
| 3.4 | **Festival calendar:** Diwali, Bhai Dooj, Chhath, wedding season, Christmas/NY, Republic Day, Valentine's, Holi, IPL — pre-built briefs per persona type | 2 | 5 h |
| 3.5 | **WhatsApp intake (manual-first):** Twilio WhatsApp number → brief lands as a shoot draft; results returned as media links. Automate only what 20 users need | 2 | 6 h |
| 3.6 | Scheduling: calendar view; shoot DAG gets `publish_at`; worker publishes on time | 2 | 4 h |
| 3.7 | Lane 2 landing page + compliance page (labelling, consent-only cloning, takedown) | 2 | 3 h |
| 3.8 | Tests: product-in-hand unit + contract; WhatsApp webhook contract; calendar E2E | — | included |

**Exit criteria:** a salon owner can WhatsApp a product photo + one line and
get a Diwali post back.

## Week 4 — Lane 3 sellable: agencies (Days 22–28, ~35 h)

| # | Task | Lane | Est. |
|---|---|---|---|
| 4.1 | **Client sub-accounts:** tenant → clients, per-client personas, credits, ledger | 3 | 8 h |
| 4.2 | Team seats + roles (owner, editor, client-viewer) on existing RBAC | 3 | 4 h |
| 4.3 | **Approval flow:** draft → client approves in a share link → publish | 3 | 5 h |
| 4.4 | Per-client GST invoices (pass-through) on existing invoice counter | 3 | 3 h |
| 4.5 | White-label if P7 ADOPTED: agency logo + custom domain on client surface | 3 | 5 h |
| 4.6 | API keys + 3 endpoints (create brief, get shoot, list assets) ◇ | 3 | 4 h |
| 4.7 | Lane 3 landing page; Ultra reframed as "agency" (realtime minutes only if built) | 3 | 2 h |
| 4.8 | Tests: RBAC matrix, sub-account isolation, invoice correctness | — | included |

**Exit criteria:** one agency can run two clients with separate billing and
client approval.

## Week 5 — Hardening (Days 29–35, ~35 h)

| # | Task | Est. |
|---|---|---|
| 5.1 | Move storage to the public S3-compatible bucket (`S3-STORAGE-RUNBOOK.md`); verify IG fetch by URL | 4 h |
| 5.2 | Worker resilience: reaper, retries, poison-job quarantine, per-provider circuit breaker; load test 50 concurrent shoots | 6 h |
| 5.3 | Security pass: rate limits, JWT audiences, admin SQL console, webhook signature verification (Razorpay, Twilio, Meta), secrets audit | 5 h |
| 5.4 | Backups + restore drill (Postgres + object storage); monitoring (uptime, queue depth, fal spend, QC pass rate) with alerts | 5 h |
| 5.5 | Full **T-E** run: contract suite, E2E on staging, visual snapshots, migration up/down | 6 h |
| 5.6 | Legal sign-off received (**you**); ToS/privacy/consent text live | 3 h |
| 5.7 | Cost model re-run with real Week 1–4 spend; adjust metering | 3 h |
| 5.8 | Performance: `next build` bundle check, image optimisation, dashboard TTI on a mid-range Android | 3 h |

## Week 6 — Founding-member beta (Days 36–42, ~35 h)

| # | Task | Est. |
|---|---|---|
| 6.1 | Onboard 20 founding members (10 theme pages, 7 brands, 3 agencies) at P8 pricing; WhatsApp support group | 8 h |
| 6.2 | Daily bug-fix + test-backfill loop from beta findings | 12 h |
| 6.3 | Marketing assets: 10 Reels (before/after, one-brief-seven-posts), mascot onboarding video, 3 Hindi tutorials, agency one-pager | 8 h |
| 6.4 | Landing pages final; SEO for "AI influencer India", "AI brand persona", "Diwali content AI" | 4 h |
| 6.5 | Meta ads test (₹5k) with Aanya's output as creative | 3 h |

## Days 43–45 — Launch

- Day 43: freeze; T-E full pass green; switch Razorpay to live keys; smoke on prod.
- Day 44: soft launch to beta + communities; watch QC pass rate, fal spend, error rate.
- Day 45 (Nov 1): public launch post from Aanya's account; lifetime/founding offer closes Day 52.

## Post-launch (Nov–Dec)

1. **Realtime clone** (Lane 3 Ultra hook): Rachbase container substrate,
   public URLs, hosted consent-capture UI, WhatsApp + IG DM channels. Only
   then put Ultra realtime minutes back on the pricing page.
2. One reel → many languages loop.
3. Automate WhatsApp intake fully (NLU brief parsing).
4. Tamil/Telugu/Marathi/Bengali voice.
5. Analytics loop: post performance → next week's brief.

## Human-only items (you), by deadline

| Deadline | Item |
|---|---|
| Day 3 | Aanya re-cull taste pass |
| Day 1 | Meta app review, YouTube audit, S3 bucket, lawyer brief submitted |
| Day 10 | P1–P8 decisions |
| Day 18 | Hindi voice listener validation |
| Day 35 | Legal sign-off |
| Day 36 | 20 founding members recruited |
| Day 43 | Razorpay live-key switch |
