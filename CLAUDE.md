# CLAUDE.md — Rstudio (brand: ZoQ)

Solo project by Raghav. **Brand = ZoQ** (customer-facing). **Repo = Rstudio**
(code, paths, package names). Use "ZoQ" in UI copy, marketing and docs;
"Rstudio" only for the codebase.

## Read these first, in this order

1. `docs/STATUS-TODO.md` — where we are, what's next, blockers. **Update it
   at the end of every session** (tick items, add to Done log, bump date).
2. `docs/ROADMAP-45-DAY.md` — the 45-day plan (launch 2026-11-01). Task ids
   like `2.3` refer to this file.
3. `docs/TECH-OVERVIEW.md` — architecture, pipeline, frozen offering, design
   rules learned the hard way. Do not change the frozen offering (§4) unless a
   row in `docs/MARKET-STRATEGY.md §7` is marked ADOPTED.
4. `docs/MARKET-STRATEGY.md` — positioning, lanes, competitors, what we
   absorb, pending pricing decisions P1–P8.
5. `docs/TESTING-PLAN.md` — test layers, fake providers, CI, definition of
   done. **Every feature ships with its tests.** Manual testing is only §8.

## Working rules

- Never describe ZoQ as "AI video" or "AI avatar" in copy — it is "your own
  AI influencer" / "a persona that posts".
- Real pixels before features: do not add features while the pipeline has
  not run end to end on real pixels (see STATUS).
- Modes are code-enforced: only `synthetic` and `twin`. Never add `reference`.
- Everything that costs money costs credits; reserve at enqueue, settle at
  completion. Realtime is the only per-minute exception.
- Identity is a frozen text block; changing it bumps `bible_version`.
- External calls go through injectable provider clients so `PROVIDERS=fake`
  works in tests. Adding a provider means adding its fake.
- Official Meta/YouTube APIs only. No headless automation. AI label on every
  output. Human approve-before-post.
- Razorpay: `rzp_test_` keys everywhere except production.
- Delete `*.bak` files; never commit new ones.

## Commands

```
# backend
cd backend && npm install && npm run db:migrate && npm run dev      # API :3000
npm run studio:worker                                               # worker
npm test                                                            # all tests
# frontend
cd frontend && npm install && npm run dev                           # :3100
npm run build
```

## Conventions

- `node --test` for backend; Playwright under `frontend/e2e/`.
- Migrations are append-only under `backend/src/db/migrations/` (next: 056).
- Keep docs in `docs/`; keep this file short — details go in the docs above.
