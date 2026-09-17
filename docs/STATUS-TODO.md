# ZoQ — Status & TODO

_The live checklist. Claude Code sessions: read this first, update it last
(tick items, move blockers, bump the date). Detail lives in
`ROADMAP-45-DAY.md`; this file is the short view. Last updated: 2026-09-17
(Day 0)._

---

## Current status (Day 0)

**Built and verified**
- [x] Backend: auth, tenants, plans, payments (Razorpay + GST invoices),
      credits ledger, Studio API, catalogue machinery (customer + admin),
      consent verification, admin back office. Legacy modules pruned,
      boot-tested. Migrations 001–055.
- [x] Worker: full video DAG wired in code — prompt → still → record → QC →
      motion → voice → assemble → copy. Video-cost-per-resolution bug fixed.
- [x] Frontend: 27 pages compile clean (`next build`), incl. catalogue,
      admin, pricing, clone, talking-head, templates/extract, publish,
      mascot, persona, insights.
- [x] Aanya trained (LoRA); 209-frame candidate pool exists.
- [x] ZoQ mascot LoRA pipeline + locked renders.
- [x] 32 backend test files (`node --test`).
- [x] Repo in git (first clean checkout done; recent commits: mascot, AI
      clone lane, new pages).

**Not yet**
- [ ] Pipeline has **never run end to end on real pixels** past LoRA training.
- [ ] Aanya seed set not re-culled to a balanced ~18.
- [ ] Razorpay still on live keys; no gateway plans created.
- [ ] No CI, no frontend tests, no coverage, no lint.
- [ ] Storage on local-disk stopgap; public S3 not set up.
- [ ] Meta app review / YouTube audit not started.
- [ ] Legal review not started.
- [ ] Realtime clone unbuilt (post-launch).
- [ ] `*.bak` files in `frontend/app/` and `backend/server.js.bak`.
- [ ] Pricing decisions P1–P8 pending (see `MARKET-STRATEGY.md §7`).

## Blockers / waiting on humans

| Item | Owner | Needed by | Status |
|---|---|---|---|
| Aanya re-cull (taste) | Raghav | Day 3 | open |
| Meta app review submitted | Raghav | Day 1 | open |
| YouTube compliance audit | Raghav | Day 1 | open |
| Public S3-compatible bucket | Raghav | Day 1 | open |
| Lawyer brief (clone, extraction, WhatsApp) | Raghav | Day 1 | open |
| P1–P8 decisions | Raghav | Day 10 | open |
| Hindi voice listener validation | Raghav | Day 18 | open |
| Legal sign-off | Raghav | Day 35 | open |
| 20 founding members | Raghav | Day 36 | open |

## TODO — this week (Week 1: Days 1–7)

- [ ] 1.1 Delete `*.bak`; add `CLAUDE.md`; reconcile `.env` / `APP_URL`
- [ ] 1.2 CI skeleton: backend tests + migrations on fresh Postgres, `next build`
- [ ] 1.3 Re-cull Aanya (human)
- [ ] 1.4 Embed → train → calibrate Aanya (real fal)
- [ ] 1.5 First real still shoot; first real video shoot
- [ ] 1.6 Record golden shoot fixture
- [ ] 1.7 Razorpay → test keys; gateway plans
- [ ] 1.8 Long-lead items started (human)
- [ ] 1.9 Per-tenant daily fal spend cap + alert
- [ ] 1.10 Aanya IG + YouTube live with first 3 posts
- [ ] 1.11 P1–P8 decided

## TODO — upcoming (summary; detail in roadmap)

- Week 2 — Lane 1: 6 catalogue personas + previews; pricing page per
  decisions; < 5-min Free onboarding; Hinglish captions; IG publish (flagged)
  + fallback; approve-before-post; Playwright E2E core flows.
- Week 3 — Lane 2: product-in-hand stills; brand kit; Hindi voice; festival
  calendar; WhatsApp intake (manual-first, Twilio); scheduling; Lane 2 +
  compliance pages.
- Week 4 — Lane 3: client sub-accounts; team seats/roles; approval flow;
  per-client GST invoices; white-label (if P7); API keys ◇; Lane 3 page.
- Week 5 — Hardening: S3; worker resilience + load test; security pass;
  backups + monitoring; full test pass; legal text live; cost re-run.
- Week 6 — Beta: 20 founding members; fix loop; marketing assets; SEO;
  ₹5k Meta ads test.
- Days 43–45 — Launch (Nov 1).

## Done log

| Date | Item |
|---|---|
| 2026-09-17 | Market strategy, roadmap, testing plan, status docs written; brand = ZoQ, repo = Rstudio |

## Metrics (fill weekly from Week 2)

| Week | QC pass rate | Time-to-first-still | Free→paid % | Aanya followers | fal spend ₹ | Gross margin % |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
