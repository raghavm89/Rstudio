# ZoQ — Testing Plan (frontend + backend)

_Goal: minimum manual testing. Every feature ships with automated coverage at
the layer that catches its bugs cheapest. CI is the gate; manual testing is
the short list in §8 and nothing else. Phases T-A … T-E map to weeks in
`ROADMAP-45-DAY.md`._

---

## 0. Where we are (Sep 2026)

- Backend: 32 `node --test` files under `backend/tests/` + `tests/studio/`,
  mostly pure-logic and wiring tests; no shared DB fixture; no CI.
- Frontend: no tests. `playwright` is a dependency but unconfigured; 27 pages
  compile. Several `*.bak` page files to delete.
- No coverage measurement, no lint, no contract tests, no E2E.

## 1. Test pyramid and tooling

| Layer | Tool | Runs in | Target |
|---|---|---|---|
| Unit (pure logic: credits, QC judgement, planner, GST maths, cadence → credits) | `node --test` + `node:assert` | every push, < 30 s | ~70% of tests |
| Integration (DB-backed services, migrations, queue, ledger) | `node --test` against a real Postgres (Docker service in CI, `docker compose` locally) | every push, < 3 min | ~20% |
| Contract (HTTP routes: auth, studio, payments, webhooks, admin) | `supertest` against the Express app with injected fakes for fal/ElevenLabs/Razorpay/Twilio/Meta | every push | in the 20% |
| Worker stage tests | `node --test` with the **golden shoot fixture** + fake providers | every push | |
| E2E (browser) | Playwright (`frontend/e2e/`) against a full stack on Docker with fake providers | every PR to `main` + nightly, < 10 min | ~10% |
| Visual snapshots | Playwright `toHaveScreenshot` on key pages, light + dark, 390 px and 1280 px | every PR | |
| Migration safety | up on empty DB, up on a Week-1 snapshot, down/up for the newest N | every PR | |
| Load | `autocannon` on API; a queue-flood script for the worker | Week 5, then weekly | |
| Security | `npm audit`, secret scan (`gitleaks`), dependency review | every PR | |

Add devDependencies: `supertest`, `@playwright/test`, `c8` (coverage),
`eslint` + `eslint-plugin-security`, `autocannon`, `gitleaks` (CI action).

## 2. Fake providers (the key to zero manual testing)

Every external call goes through one injectable client so tests never touch
the network:

| Provider | Fake behaviour |
|---|---|
| **fal** (FLUX-LoRA, Seedance, training) | Returns fixture images/videos from `tests/fixtures/golden/`; supports `delay`, `fail`, `partial` modes; records calls for cost assertions |
| **ElevenLabs** | Returns a fixture WAV per language; asserts voice id + text |
| **insightface embedder** | Deterministic embeddings keyed by fixture file; configurable similarity so QC pass/fail paths are both covered |
| **Razorpay** | In-memory subscriptions/orders/invoices; signed webhook generator |
| **Twilio WhatsApp** | Captures outbound messages; helper to inject inbound webhooks |
| **Meta Graph / YouTube** | Captures publish calls; can return rate-limit + review-pending errors |
| **Anthropic (copy stage)** | Fixed captions per persona; asserts prompt contains frozen identity block |
| **Object storage** | Local-disk driver already exists; test asserts key layout + public URL shape |

Selection by env: `PROVIDERS=fake` (default in tests) vs `real`.

## 3. Golden shoot fixture

Recorded once from the first real Aanya shoot (Roadmap 1.6): seed set,
calibration baseline, 3 stills (1 pass, 1 borderline, 1 fail), one 5-s motion
clip, one voice line, one assembled reel, one caption. Every worker/stage test
and E2E run uses it. Regenerate only when `bible_version` bumps.

## 4. Backend coverage map (what must have tests, by area)

**Auth & tenancy:** signup (email, phone), login, audience separation
(studio/admin/platform tokens rejected across audiences), session expiry,
password reset, RBAC matrix (owner/editor/client-viewer × every route),
sub-account isolation (tenant A can never read B's assets/credits/invoices).

**Billing:** plan create/upgrade/downgrade proration; UPI Autopay mandate
flow; annual; top-up; credit reservation at enqueue + settlement at
completion + refund on failure; ledger append-only (attempted update fails);
GST: CGST+SGST vs IGST by buyer state, billing address mandatory, invoice
counter monotonic under concurrency; Razorpay webhook signature + idempotency
(replay produces no double credit).

**Studio API:** avatar create (synthetic/twin only; `reference` rejected by
DB CHECK); catalogue select/deselect; authorization rule (own OR selected
catalogue); brief → shoot DAG shape; product-in-hand requires product asset;
brand kit injection into prompt; approve-before-post state machine; schedule
`publish_at`; Free-tier cap enforced; per-tenant daily spend cap.

**Worker:** queue lease/reaper/skip-locked under concurrency; stage handlers
(prompt, still, qc, motion, voice, assemble, copy, publish) each with
success/fail/retry; QC never falls back to neutral for emotional shots; QC
failure blocks motion; cost recorded per resolution (the fixed Seedance bug
gets a regression test); circuit breaker opens after N provider failures.

**Consent:** twin train/generate refused without verified consent; face match
threshold; audit row written.

**Admin:** every admin route 403 for studio tokens; SQL console refuses
superuser connection and any write statement; audit log on catalogue changes.

**WhatsApp intake:** inbound webhook → draft shoot; media download; outbound
result message; unknown sender handling.

## 5. Frontend coverage map

**Playwright E2E (fake providers, seeded DB):**
1. Free signup → catalogue pick → brief → stills appear → approve → "publish"
   captured by fake Meta.
2. Upgrade to Catalogue/Pro on Razorpay test checkout → plan reflected →
   invoice PDF has correct GST split.
3. Pro: create studio avatar → training queued → status polling → look freeze.
4. Brand (Lane 2): upload product → product-in-hand shoot → festival brief →
   scheduled post shows on calendar.
5. Agency (Lane 3): create client sub-account → client approval link →
   approve → publish; second client cannot see first.
6. Admin: catalogue add/remove, tenant view, jobs view, SQL console read-only.
7. Auth edge: expired session redirect, password reset, phone login.
8. Mobile viewport (390 px) for flows 1, 2, 4 — this is where most Indian
   users are.

**Visual snapshots:** landing, pricing, catalogue, shoot detail, calendar,
billing — light/dark × mobile/desktop.

**Static checks:** `next build` must be clean; ESLint; a script that fails
if any `*.bak` file exists under `app/`.

## 6. CI pipeline (GitHub Actions)

```
on: [push, pull_request]
jobs:
  backend:   lint → unit → integration (Postgres service, migrations 001–055) → contract → coverage ≥ 80% lines (fail below)
  worker:    stage tests with golden fixture
  frontend:  lint → next build → playwright e2e (docker compose: api + worker + postgres + fakes) → visual snapshots
  migrations: up-on-empty, up-on-snapshot, down/up newest 3
  security:  npm audit --audit-level=high, gitleaks
nightly:     full e2e + load smoke + PROVIDERS=real canary (1 still, 1 TTS) with spend cap
```

Branch protection on `main`: all jobs green. Pre-commit hook: lint + unit.

## 7. Test data & environments

- `tests/seed.js` builds a deterministic world: 1 admin, 3 tenants (creator,
  brand, agency with 2 clients), 6 catalogue avatars (fixture images), Aanya
  as a trained avatar, one shoot in every state.
- Staging = Docker compose of the full stack with `PROVIDERS=fake`; a second
  profile `PROVIDERS=real` for the canary and the §8 manual list.
- Razorpay always `rzp_test_` outside production; live-key switch is a
  one-line env change on Day 43.

## 8. The only manual tests (each once, before launch)

1. Real-pixel shoot review: 20 stills + 3 reels from Aanya and 2 catalogue
   personas, judged by eye for postability (**you**).
2. Hindi/Hinglish voice + caption naturalness with 5 native listeners.
3. Real Razorpay test checkout on a phone with UPI Autopay mandate approval
   in an actual UPI app.
4. Real WhatsApp round-trip from a personal number.
5. Real IG publish once Meta review clears; confirm AI label visible.
6. Restore drill from backup.

Everything else is automated. If a bug is found manually, the fix ships
with a test that would have caught it.

## 9. Definition of done (every task in the roadmap)

- Unit/integration/contract tests added at the right layer; CI green.
- E2E updated if a user-visible flow changed.
- Fake provider updated if a new external call was added.
- `STATUS-TODO.md` updated.
