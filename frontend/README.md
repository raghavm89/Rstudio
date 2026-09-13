# studio.rstudio.app — frontend

Next.js 14 (App Router). Direction C, "Creator Deck". Tokens are in
`app/globals.css` and come from `claude/studio-design-system.md`.

```bash
npm install
npm run dev          # :3100
```

Needs two things running:

| | |
|---|---|
| the backend | `npm run dev` in `rstudio-backend` — proxied at `/api/studio/*` |
| the cull service | `node studio/cull.js` — proxied at `/cull/*` |

Both are proxied rather than called cross-origin, and that is deliberate: the
backend derives a token's audience from the request `Origin` (see
`services/audience.js`), so a same-origin call in development behaves the way a
production call behind one domain will. Pointing the browser at `:5000`
directly would make every session look like it came from somewhere else.

## Two decisions worth knowing about

**Plain CSS, not Tailwind.** The architecture doc said Tailwind + shadcn; this
deviates. The design system is specific in ways utility classes fight — radii
that vary by role (pills fully round, cards 17px, thumbnails 10px), a
*two-level* selection model, and the rule that tinted fills group while borders
separate. Expressing that in Tailwind means either a config that overrides most
defaults or a wall of arbitrary values. Worth revisiting if the team grows;
right now the CSS is 300 lines and reads like the design doc.

**The coverage rules live in `cull.js`, not here.** The frontend renders them
and the service enforces them. One implementation, so a screen cannot drift
from the gate that actually refuses an export.

## Screens

| | |
|---|---|
| `/avatars` | list — deliberately not a dashboard |
| `/avatars/[id]/face` | **Find her face** — the culling grid |
| `/avatars/[id]/look` | Set her look — not built |
| `/avatars/[id]/shoot` | Shoot — not built |

## Language

The UI never says "expression preset" or "light direction". Engineering terms map
to human ones (`claude/studio-design-system.md` has the table) — the schema is
unchanged, only the labels. A consumer-shaped UI wearing engineer labels reads
worse than either done straight.
