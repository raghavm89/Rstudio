# ZoQ — Market Strategy

_Brand: **ZoQ**. Repo/codebase: **Rstudio**. This doc is the positioning and
competitive source of truth. `TECH-OVERVIEW.md` says how it is built;
`ROADMAP-45-DAY.md` says when; `STATUS-TODO.md` says where we are. Solo
project (Raghav). Last revised 2026-09-17._

---

## 1. One-line positioning

**"Your own AI influencer. One brief, a week of posts, same face every time."**

Never describe ZoQ as "AI video" or "AI avatar" — those words hand the search
result and the comparison to InVideo, Fliki and HeyGen. ZoQ sells a **persona
that posts**, not clips.

## 2. Why India, and who actually pays

- India has the largest creator population and the lowest willingness to pay
  per creator. Individual creators are the *audience* for the product story
  but not the main *revenue*.
- Money in India is spent monthly on creatives by: D2C brands (Shopify /
  Meesho sellers), local businesses (salons, gyms, coaching, real estate,
  restaurants), and the agencies serving them. That is where Pro/Max/Ultra
  revenue comes from.
- India-specific wedges no global tool has: Indian-looking catalogue personas,
  Hindi/Hinglish/regional voice and copy, WhatsApp as the interface,
  Razorpay + UPI Autopay + GST invoicing, and IT-Rules compliance
  (AI labelling, consent-only cloning, takedown readiness).

## 3. The three lanes (all sellable at launch — see roadmap)

| Lane | Buyer | Positioning line | Price anchor | Proof it needs |
|---|---|---|---|---|
| **1 — Theme pages & creators** | Faceless IG theme pages, meme accounts, creators who won't show their face | "Your own AI influencer. One brief, a week of posts." | Free (capped) → Catalogue ₹999 → Pro | Aanya's public account + catalogue |
| **2 — D2C brands & local business** | Shopify/Meesho sellers, salons, gyms, coaching, real estate | "A brand face that never misses a posting day." | Pro → Max ₹7,000 | Product-in-hand output + festival calendar |
| **3 — Agencies** | Influencer-marketing and social-media agencies | "Run ten client personas from one studio." | Max → Ultra ₹15,000 | Sub-accounts + approval flow + white-label |

Each lane's results are the proof the next lane needs: Aanya's audience sells
to theme pages, theme-page results sell to brands, brand results sell to
agencies.

## 4. Competitive landscape (Sep 2026)

| Player | What it really is | Persona consistency | Beats ZoQ on | ZoQ beats it on |
|---|---|---|---|---|
| **InVideo AI** (India-founded, ~$70M ARR, USD pricing) | Text-to-video + "AI Twins" (clone yourself + your product, v4.0 Jun 2025) | Talking-head only | Search dominance in India, scale, twins shipped | Persona across scenes/looks, catalogue, WhatsApp, GST/UPI, compliance story |
| **Fliki** (India-founded) | Script/blog → stock video + 2,000 voices / 80 langs; $21–166/mo, metered by minutes | None | Voice breadth, tiny COGS, big free tier | Everything visual — no face at all |
| **FacelessReels** | Niche auto-channel, $19/39/69 per "series" by posting cadence, no trial, no refunds | None | Dead-simple pricing, auto-post, zero effort | Quality, human approval, brand safety, an actual persona |
| **HeyGen** | Avatar/lipsync leader, photo avatars, translation | Talking head | Lipsync quality, translation, enterprise trust | Lifestyle/IG-native output, cost, Indian looks |
| **Synthesia** | Corporate training video | Studio talking head | Enterprise sales | Not our buyer |
| **Captions / Mirage** | Mobile-first creator video, AI UGC ads | Emerging | Phone-native UX | Persona depth, Indian market |
| **Arcads** | AI UGC ads with actor library for D2C | Per-actor, ad-length | Owns "AI UGC ad" category | Indian faces, Indian price, persona beyond ads |
| **Higgsfield / Kling / Veo (via Gemini, ChatGPT)** | Raw generative video, cheap or free | Character-reference improving fast | Price, model quality gains | Workflow, consistency guarantee, QC, publishing, billing |
| **Personate.ai / Dubverse** (India) | Indian avatar/dubbing for enterprise | Talking head | Indic voice + dubbing | Creator/brand persona, self-serve |

**Pattern:** everyone does talking-head clones, narrated stock video, or raw
generation. Nobody sells a persona that posts. The gap is real but narrow —
Veo/Kling character-consistency closes the *technical* part every quarter.
**The moat is workflow + market, not the model.**

## 5. Make-or-break points

1. **Output quality on real pixels.** Until Aanya's first end-to-end shoot is
   postable, nothing else counts.
2. **Provable consistency.** Face-QC pass rate is the differentiator; below
   ~80% at the gate the promise fails in the customer's first week. Expose it.
3. **Video unit economics.** Seedance ₹7.21/s (480p) / ₹15.47/s (720p) → a
   15-s reel costs ₹100–230 before margin. Base plans bundle lipsync (cheap);
   generative reels stay metered. Never let Free/Catalogue lose money on video.
4. **Time to first wow.** Catalogue → brief → stills in under five minutes.
   Custom training (hours) is never the first experience.
5. **Indian-language voice.** A Delhi persona that only speaks English reads
   as broken next to Fliki/InVideo.
6. **Payments that recur.** UPI Autopay mandates + annual prepay, or churn
   looks like product failure when it is card e-mandate failure.
7. **Platform safety.** Official Meta/YouTube APIs only, AI labelling, human
   approve-before-post. FacelessReels shows what bans look like without it.
8. **Never sell what isn't built.** Realtime clone stays off the pricing page
   until it runs on Rachbase end to end.

## 6. What we absorb from competitors (cheap given the codebase)

| # | Feature | From | Why cheap here | Lane |
|---|---|---|---|---|
| 1 | "Series" pricing by cadence (3/wk, daily, 2×/day per persona) | FacelessReels | Packaging over existing plans/credits | 1 |
| 2 | Brand kit (logo, colours, tagline into prompt vocabulary + captions) | Fliki, HeyGen | Versioned prompt vocabulary exists | 2 |
| 3 | Multi-language voice (Hindi, Tamil, Telugu, Marathi, Bengali) | Fliki, HeyGen | ElevenLabs already in `voiceStage.js` | 1–2 |
| 4 | Auto-publish + schedule | FacelessReels, Fliki | Meta/YouTube already planned; schedule column on shoot DAG | 1–2 |
| 5 | Catalogue preview images | HeyGen photo avatars | One generation run over existing catalogue | 1 |
| 6 | Product-in-hand stills (reference-conditioned, no retrain) | Arcads, InVideo | Still stage + reference image | 2 |
| 7 | Script → lipsync tiers | HeyGen | Already in offering; needs first real run | 1–3 |
| 8 | One reel → many languages | HeyGen, Fliki | Loop over voice + lipsync once #3 exists | 2–3 |
| 9 | Team seats + client sub-accounts | Synthesia, HeyGen | Tenancy + audience-scoped auth exist | 3 |

**Do not absorb:** raw generative-video breadth, stock-footage libraries,
enterprise training video. Different businesses, different cost structures.

## 7. Offering: frozen v1 + proposed changes

The v1 offering in `TECH-OVERVIEW.md §4` is **frozen** (Free ₹0 / Catalogue
₹999 / Pro ₹2,000 / Max ₹7,000 / Ultra ₹15,000; 1 still = 1 credit; top-up
₹500/77cr; realtime ₹40/min). The changes below are **recommended and pending
Raghav's decision**. Until a row is marked ADOPTED, code follows the frozen
numbers.

| # | Proposed change | Why | Status |
|---|---|---|---|
| P1 | Cap Free at a few watermarked stills, once (kill the −₹218 margin) | Free is uncapped CAC today | PENDING |
| P2 | 720p floor on every paid plan (Pro included) | 480p reels read as cheap on phones in 2026 | PENDING |
| P3 | Hide Ultra + realtime clone from pricing until built | Refund risk on the highest-value plan | PENDING |
| P4 | Present plans by posting cadence per persona (series model), keep credits underneath | Customers picture "daily posts", not "77 credits" | PENDING |
| P5 | Annual plan with ~2 months free; UPI Autopay mandates for all subscriptions | Indian recurring-payment reality | PENDING |
| P6 | Pro at ₹1,499 (or keep ₹2,000 with 720p) | Indian anchor points are ₹499/₹999/₹1,999 | PENDING |
| P7 | White-label for agencies on Ultra (reverse "no white-label") | Agencies won't resell what carries our name | PENDING |
| P8 | Founding-member offer for the first 20–50: lifetime or locked price | Funds fal spend, buys feedback | PENDING |

## 8. Marketing plan (launch)

- **Aanya is the marketing department.** Own IG + YouTube, disclosed as AI,
  posting daily from the pipeline, "made with ZoQ" in bio. Her first paid
  brand deal is the launch post.
- **ZoQ mascot** (already trained, `backend/studio/mascot-*.js`) is the brand
  character for ads, onboarding and the landing page.
- **Channels:** IG Reels (before/after, "one brief → seven posts"), Hindi
  YouTube tutorials, Telegram/WhatsApp creator communities, LinkedIn for
  agencies, Meta ads whose creative *is* Aanya's output. Lifetime-deal launch
  for early cash. Skip Product Hunt.
- **Compliance as a feature:** "We can only clone you, never anyone else";
  every output labelled; takedown-ready.
- **Segment sequence:** theme pages → brands → agencies, but all three lanes
  have a page and a plan at launch.

## 9. Metrics that matter

Face-QC pass rate; time-to-first-still for a new Free user; paid conversion
from Free; Aanya follower growth and brand-deal count; gross margin per plan
after real fal/ElevenLabs spend; monthly churn split by UPI vs card.
