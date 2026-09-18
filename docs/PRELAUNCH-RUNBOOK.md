# zoqstudio.ai — pre-launch page runbook (branch `pre_launch_page`)

_One page, one domain, until launch (Nov 2026). Hero + catalogue + offering +
indicative plans + "From the feed" (IG / YouTube embeds) + waitlist. Every other
route redirects to `/`._

## What's on the branch

| File | Does |
|---|---|
| `frontend/content/prelaunch.js` | **The only file you edit.** Social handles, post links, catalogue faces + status, offerings, plans. |
| `frontend/components/Prelaunch.jsx` + `app/prelaunch.css` | The page (cinematic `z-` register, `pl-` additions). |
| `frontend/components/SocialEmbed.jsx` | One IG blockquote (embed.js) or YouTube iframe per link. |
| `frontend/app/api/waitlist/route.js` | `POST` → Brevo contact list. 503 (with a mailto fallback in the UI) if env is missing. |
| `frontend/middleware.js` | Everything except `/`, `/api/waitlist`, `/_next/*` and static files → 307 `/`. `PRELAUNCH=0` disables it. |
| `frontend/app/page.jsx` | Renders `Prelaunch` (or the old `Landing` when `PRELAUNCH=0`); OG/Twitter metadata for zoqstudio.ai. |
| `frontend/lib/prelaunch.mjs` + `tests/` | URL parsing + signup validation, `npm test` (node --test). |

`zoq.css` also got a one-line fix: `.z-h1` now forces Figtree — globals' `h1 { font-family: var(--display) }` was making every marketing headline Bodoni.

## Pasting post links (the daily job)

1. Open `frontend/content/prelaunch.js`.
2. Add the URL to `POSTS`, newest first:
   ```js
   export const POSTS = [
     'https://www.instagram.com/reel/XXXXXXXX/',
     'https://youtube.com/shorts/YYYYYYYYYYY',
   ];
   ```
   Post, reel, `watch?v=`, `youtu.be`, Shorts all work. A profile / channel URL is
   not a post and is skipped (a warning shows in the Vercel build log).
3. Set `SITE.instagram` / `SITE.youtube` once — this turns on the Follow buttons.
4. `git commit -am "feed: add post" && git push` → Vercel redeploys in ~1 min.

Flip a face to `status: 'live'` (and give it `media`/`video` under `public/hero/…`)
when its LoRA is calibrated. Set `SITE.showPlans = false` to hide the plan strip
while P1–P8 are undecided.

## Vercel setup (once)

1. Push the branch: `git push -u origin pre_launch_page`.
2. vercel.com → **Add New → Project** → import `raghavm89/Rstudio`.
3. **Root Directory:** `frontend`. Framework: Next.js (auto). Node 20.x.
4. **Production branch:** `pre_launch_page` (Settings → Git). `main` then only makes previews — the app never goes public by accident.
5. **Environment variables** (Production):
   | Name | Value |
   |---|---|
   | `BREVO_API_KEY` | from Brevo → SMTP & API → API keys |
   | `BREVO_WAITLIST_LIST_ID` | Brevo → Contacts → Lists → create "ZoQ launch waitlist" → the numeric id in the URL |
   | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (the `playwright` dep would otherwise download browsers on every build) |
   | `PRELAUNCH` | leave unset (= on). Set `0` on launch day. |
6. Deploy. Check `https://<project>.vercel.app/`, then `/pricing` → should land on `/`.

## Domain: zoqstudio.ai

Vercel project → Settings → **Domains** → add `zoqstudio.ai` and `www.zoqstudio.ai`
(redirect www → apex). At your registrar's DNS:

| Type | Name | Value |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

TLS is automatic. Propagation: minutes to a few hours. Also create the
`hello@zoqstudio.ai` mailbox (or change `SITE.email`) — the footer and the form's
error fallback point there.

## Launch day

`PRELAUNCH=0` on Vercel (or merge `main` and switch the production branch back), redeploy, and the full site is live at the same domain. The waitlist route keeps working either way.

## Verify (done 18 Sep, cloud build)

- `npm test` — 6/6.
- `next build` clean; `/` 200, `/pricing` and `/avatars/7/look` → 307 `/`, `/hero/*.jpg` 200, unknown file 404.
- `/api/waitlist`: bad email → 400; no Brevo env → 503 + UI mailto fallback; honeypot → 200 no-op.
- Screenshots at 1366 and 390 px: no horizontal scroll, form + error state render.
- Not verified: a real Brevo insert (needs the key) and IG embed rendering (blocked from the sandbox — the blockquote's plain link is the fallback).
