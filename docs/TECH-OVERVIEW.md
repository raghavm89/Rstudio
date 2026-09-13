# Rstudio — Technical Overview

_The single source of truth for what Rstudio is and how it is built. Synthesised
from the product's frozen offering, architecture and the working backlog. This
is the driving input for all further work: every task below traces to a section
here._

---

## 0. Repo layout

A monorepo: **`backend/`** (Express API + render worker + operator tools under `backend/studio/`) and **`frontend/`** (Next.js app), which talk over HTTP only. `docs/` holds this overview. `backend/` and `frontend/` each have their own `package.json`.

## 1. What Rstudio is

An AI-persona studio for creators, aimed at the Indian market. A creator trains
a persona **once**, then generates a week of on-brand photos and reels from a
single brief — the same face, the same look, every time, with no prompt writing.

Two engines sit behind that promise:

- **Batch content** — stills, script→lipsync talking-head video, template
  ad/viral videos, and generative reels. This is the existing render pipeline.
- **Realtime AI clone** — a per-tenant live, interactive clone (voice + knowledge
  base) reachable over the web, WhatsApp and Instagram DM. Separate streaming
  stack; not yet built.

Three ways a creator gets a face: pick one from a **shared catalogue** (fastest,
Free tier), build their **own studio avatar** (Pro+), or **clone themselves** from
a consented video (Pro+).

## 2. Architecture at a glance

| Layer | Tech | Notes |
|---|---|---|
| Backend API | Node.js / Express (`backend/`, `src/`) | Tenant-scoped; JWT auth with **audience separation** (studio vs admin vs platform). |
| Render worker | Node (`backend/worker/`) | Pulls a Postgres-backed job queue (`FOR UPDATE SKIP LOCKED`, leases + reaper) and calls providers. |
| Database | PostgreSQL | Migrations `001–054` in `backend/src/db/migrations`; `npm run db:migrate`. |
| Frontend | Next.js (`frontend/`) | Landing, auth, Studio dashboard, admin back office. Talks to `/api/studio/*` via a rewrite. |
| Object storage | S3-compatible | Presigned PUT; public GET (Instagram fetches media by URL). Local-disk driver is the current stopgap. |
| Operator tools | Node + Python (`backend/studio/`) | `seed-set`, `cull`, `train`, `calibrate`, `load-persona`, the ComfyUI local stack, the insightface embedder. |

**External services:** fal (FLUX-LoRA stills, Seedance video, LoRA training),
ElevenLabs (TTS + voice clone), Razorpay (subscriptions + GST invoices), Meta &
YouTube (publishing, official APIs only), and Rachbase (the container platform
the realtime clone will deploy onto, at `*.rachbase.app`).

## 3. The generation pipeline (the core mechanism)

```
avatar → seed set → cull → LoRA train → calibrate → look freeze
                                                      │
   shoot (one transaction builds a DAG of jobs):      ▼
   prompt-stage → still → FACE-QC GATE → motion → assemble → copy
```

Load-bearing design rules, each learned the hard way:

- **Identity is a frozen text block**, concatenated verbatim into every prompt;
  changing it bumps `bible_version` and retrains. Framing/wardrobe/location vary
  per shot and live in a versioned prompt vocabulary — never free text.
- **The face-QC gate** measures similarity to the calibrated mean per
  `(avatar, lora, expression, framing)` and never falls back to neutral for an
  emotional shot. Calibration keeps the *spread* (it is the tolerance) — filtering
  the worst frames would make the gate reject normal output forever.
- **Everything that costs money costs credits** (`backend/src/services/studio/credits.js`),
  reserved at enqueue and settled at completion; realtime is the one exception
  (its own per-minute meter).
- **Modes are code-enforced:** only `synthetic` and `twin` exist; `reference`
  (train on an uploaded face photo) is banned by a DB CHECK (migration 033).

## 4. The offering (frozen)

### Avatar types
| Type | Mode | Consent | Voice | On plans |
|---|---|---|---|---|
| Catalogue (shared) | `synthetic` | none | library TTS | Free + all |
| Studio (own, custom) | `synthetic` | none | library TTS | Pro+ |
| AI clone / twin | `twin` | **verified** | cloned | Pro+ |

### Capabilities
Script→lipsync (tiered: budget LatentSync / premium Sync v2 / max VEED),
template ad/viral videos + viral stills, safe format-extraction from a reel,
and realtime interaction (clone-only, bundled into Ultra).

### Plans (frozen v1, ₹100/$)
| | Free | Catalogue | Pro | Max | Ultra |
|---|---|---|---|---|---|
| Price | ₹0 once | ₹999/mo | ₹2,000/mo | ₹7,000/mo | ₹15,000/mo |
| Avatar | catalogue | catalogue | custom/clone | custom/clone | custom/clone |
| Avatars | 1 | 1 | 1 | 5 | 12 |
| Gen-video res | 480p | 480p | 480p | 720p | 720p |
| Margin | −₹218 | 34% | 48% | 48% | 32% |

Ultra's hook is the **only plan with the live AI clone** (60 bundled realtime
minutes) plus agency features (team seats, client sub-accounts, API, priority) —
no white-label. Base plans bundle **lipsync** videos; generative reels and
premium lipsync are metered add-ons that never erode base margin. Real video
cost is **Seedance 2.0 Mini** (480p ₹7.21/s, 720p ₹15.47/s). Full model in the
costing spreadsheet; frozen numbers and open items in the offering spec.

## 5. Key subsystems

- **Billing** — Razorpay subscriptions + top-ups, GST-correct invoices
  (CGST+SGST vs IGST decided by buyer state; billing address mandatory before
  any charge), a locked invoice counter, and an append-only `credit_ledger`.
- **Catalogue machinery** — a catalogue entry is a fully-built avatar flagged
  `is_catalogue`, shared across tenants; customers browse and **select** one
  (a per-tenant pointer, not a claim). One authorization rule lets a tenant shoot
  an avatar it owns **or** a catalogue avatar it selected. Admins manage the
  library (add/remove) from a dashboard tab, audited.
- **Admin back office** — the only cross-tenant surface; guarded by a single
  `authorize('admin')` on a mounted sub-router; a read-only SQL console hardened
  against RCE by refusing a superuser DB connection.
- **Auth & tenancy** — one account model; audience-scoped tokens; a consent gate
  (real hosted capture + face match) is a launch requirement for every paid plan
  because clone is on Pro+.

## 6. Current state (Sep 2026)

- Pipeline **complete in code** end to end; **not yet run on real pixels** past
  LoRA training. Aanya (the reference persona) is trained; a 209-frame candidate
  pool exists and awaits a balanced re-cull.
- Billing, credits, GST invoices, Razorpay checkout **built and wired**; no
  gateway plans created; keys must be switched from live to test.
- Catalogue machinery (customer + admin) **built and verified** against a
  throwaway Postgres (24/24 checks); frontend needs a local build pass.
- Video-cost bug **fixed** (per-resolution Seedance billing).
- **Nothing is in git yet** at the point this repo was extracted — this repo is
  that first clean checkout.

## 7. Roadmap — the driving backlog

Ordered by leverage. Items marked _(you)_ are blocked on a human decision or
external lead time, not code.

**Lane 0 — foundation**
1. Initialise git in this repo and push (first commit).
2. Reconcile env (`.env.example` → real `.env`; audience origins; one canonical `APP_URL`).

**Lane 1 — remove carried-over legacy modules — DONE (boot-tested).** See §8.

**Lane 2 — pipeline to first real pixels**
4. Apply migrations against a fresh DB; run the suite green.
5. Re-cull Aanya's seed set to a balanced ~18 _(you: taste)_.
6. Embed → train → calibrate → first real shoot _(fal spend)_.
7. ~~Build the remaining stage handlers~~ **DONE** — `assemble` (pull motion
   clips + voice, single-clip passthrough, else ffmpeg stitch), `copy` (caption
   in the persona's voice via Anthropic), and `motion_prompt` derivation
   (framing-based, appearance-free) are built + registered; boots clean, pure
   logic tested. Also **closed the still→motion data gap**: a finished shoot
   still now records its frames as `studio_assets` and feeds the first frame to
   its motion job as `generation.image_url` (`shootAssets.js`), so image-to-video
   has an input. **Still needed before a video shoot runs end-to-end on real
   pixels:** (a) the `qc` stage has no executor — embed each candidate, faceQc-judge
   against the calibrated baseline, mark the winner `selected`, and re-point the
   motion input at it (`faceQc.js` is the judge; wiring + the embedder call are
   unbuilt); (b) no handler for the `voice` stage.

**Lane 3 — close the offering**
8. Realtime per-minute price + provider _(you)_; confirm the cost estimates.
9. Credit denomination — map unit bundles to ledger credit rates.
10. Legal guardrail sign-off _(you: Indian lawyer)_.

**Lane 4 — billing live**
11. Switch Razorpay to test keys; reprice plans to frozen numbers; create gateway
    plans on test keys.

**Lane 5 — long-lead approvals** _(you, start now)_
12. Meta app review (IG publish + WhatsApp); YouTube compliance audit; public
    S3-compatible storage.

**Lane 6 — realtime clone** _(critical path, unbuilt)_
13. Rachbase container substrate + public URLs; the consent capture flow.

**Lane 7 — content & catalogue**
14. Frontend build check + preview images for the catalogue.
15. Generate → train → calibrate → publish the Delhi/Punjab catalogue personas.
16. The persona itself (Aanya): fill the bible _(you)_, create IG/YouTube
    accounts, begin hand-posting.

## 8. Legacy-module prune — DONE (code), boot-tested

The non-Studio code carried over from the origin platform has been **removed and
boot-tested** (fresh `npm install`, all 55 migrations applied to a clean
Postgres, `server.js` booted, Studio routes answer 401, the removed routes 404):

- Deleted routes `agent`, `deployment`, `expansion`, `monitoring` and their
  controllers + `vmAssignmentController`; unwired their mounts from
  `backend/src/app.js` and the VM/pool routes from `backend/src/routes/users.js`.
- Deleted services `alertMonitor`, `terminalServer`, `deployRunner`, `sshKey`,
  `agentProvider`, `prometheus` and the `agentDefinition` model; removed their
  startup from `backend/server.js`.
- Fixed the tests that referenced them, plus the frontend-path and wordmark
  assertions the restructure/rebrand changed.

The backend now exposes only: `auth`, `users`, `tenants`, `plans`, `payments`,
`contact`, `oauth`, `studio`.

**Optional remaining (cosmetic, low priority):** the early migrations
`001–025` still create some now-unused platform tables (VM pools, deployments,
agent definitions). They are harmless — nothing reads them — but a purist can
fold the base tables Studio needs (`users`, `tenants`, `subscriptions`,
`orders`, `idempotency`, `credit_ledger`, webhook/verification) into one clean
`000_base.sql` and drop the VM/agent tables. Do it against a fresh DB only, and
re-run the boot test after.

## 9. Compliance guardrails (India, load-bearing)

AI-content labelling on every output; every generation traceable to tenant +
consent + source for 3-hour takedown readiness; verified consent before any
clone train/generate; format-extraction takes structure only (no copyrighted
source); publishing via official platform APIs only (no headless automation).
Have an Indian lawyer review the clone, extraction and WhatsApp flows before the
first paying customer.
