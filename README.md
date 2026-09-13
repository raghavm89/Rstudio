# Rstudio

An AI-persona studio for creators: train a persona once, then generate a week of
on-brand photos and reels from a single brief — the same face, the same look,
every time. Built for the Indian creator market.

## What's here

| Path | What it is |
|---|---|
| `backend/` | Node/Express backend (`server.js`, `src/`) — auth, tenants, billing (Razorpay + GST), and the Studio API (avatars, seed sets, training, calibration, shoots, the shared catalogue). |
| `backend/worker/` | The render worker (fal provider: FLUX-LoRA stills, Seedance video, LoRA training) and the queue protocol. |
| `backend/src/db/migrations/` | The canonical schema (001–054). `npm run db:migrate` applies them. |
| `frontend/` | The Next.js app (landing, auth, the Studio dashboard, admin back office). |
| `backend/studio/` | Operator tools — `seed-set.js`, `cull.js`, `train.js`, `calibrate.js`, `load-persona.js`, and the ComfyUI local stack. |
| `tests/` | `node --test` suites. |

## Quick start

```bash
# backend
cd backend
cp .env.example .env          # fill in DB, FAL_KEY, Razorpay (use rzp_test_ keys), SELLER_* GST fields
npm install
npm run db:migrate
npm run dev                   # API on :3000
npm run studio:worker         # render worker (separate terminal)

# frontend
cd ../frontend
npm install
npm run dev                   # :3100  (proxies /api/studio/* to the backend)
```

Create the first platform admin with `node scripts/create-admin.js` (from `backend/`).

## Notes

- **Carried-over platform modules.** This repo was extracted from a larger
  platform. The Studio product and its base (auth, tenants, billing) are the
  core; some non-Studio modules (agent, deployment, expansion, monitoring, VM
  pools) and the early migrations that back them are still present and slated
  for removal — see `docs/TECH-OVERVIEW.md`.
- **Realtime clone** deploys to a separate container platform (`*.rachbase.app`)
  and is not part of this repo.
- Secrets, the Python venv, local render storage and generated imagery are
  git-ignored; regenerate persona imagery via fal/ComfyUI.
