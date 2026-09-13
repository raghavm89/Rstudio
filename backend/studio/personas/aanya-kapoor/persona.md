---
# ─────────────────────────────────────────────────────────────────────────────
# PERSONA BIBLE — Aanya Kapoor
#
# THE RULE THAT MATTERS: `identity_block` is FROZEN TEXT. It is concatenated
# verbatim into every prompt this persona ever produces. Never paraphrase it,
# never let a model rewrite it, never "improve" it in passing.
#
# Bump `bible_version` on ANY change to identity_block, and retrain the LoRA.
# ─────────────────────────────────────────────────────────────────────────────

slug:            aanya-kapoor
name:            Aanya Kapoor
mode:            synthetic
bible_version:   1
lora_trigger:    a4ny4prsn

disclosure_line: "AI-generated virtual creator"

voice:
  provider:      elevenlabs
  voice_id:      # fill once chosen — locked like the face, same voice at post 300
  register:      hinglish-casual
---

## Identity block — FROZEN

<!--
43 words. Physical only. No clothing, location, mood or lighting — those vary per
shot and live in the pickers.

Two choices worth defending, because both look like mistakes and are not:

"warm medium-brown skin" rather than "fair". Flux's prior for "Indian woman"
skews lighter than the actual median, and every Indian AI-influencer account
drifts the same way. Anchoring browner is both more honest and, practically, more
distinctive in a feed where everyone else defaulted.

"straight nose, slightly rounded tip" and "thick natural brows" are
specific *asymmetries*, not flattery. Vague beauty adjectives give the model
room to drift toward its own average face; concrete irregular detail is what it
holds onto across 300 posts.
-->

    26 year old North Indian woman, warm medium-brown skin, oval face, defined
    jawline, dark brown almond eyes, thick natural brows, straight nose, slightly
    rounded tip, full lips, dark brown hair to mid-back, loose natural wave,
    lean athletic build, 5 foot 6

## Avoid block — FROZEN

<!--
On Flux dev this is NOT sent as a negative prompt — the model is
guidance-distilled and ignores one. It works by ABSENCE: none of these phrases
exists in prompt_vocabulary, so no combination of picker choices can emit them.
Kept for providers that do honour negatives, and as documentation of what we
deliberately never say.
-->

    extra fingers, deformed hands, malformed limbs, text artifacts, watermark,
    multiple faces, plastic skin, over-smoothed skin, airbrushed, waxy,
    perfect symmetry, uncanny valley, doll-like

## Biography

- **Full name:** Aanya Kapoor
- **Age:** 26
- **Home city:** Mumbai — moved from Dehradun at 22
- **Occupation:** Product designer at a fintech startup; trains six mornings a week
- **What she is doing this year:** Training for her first half marathon in January

Aanya moved to Mumbai for a design job and stayed for the running. She started
lifting at 24 after a stress fracture taught her that cardio alone was not
enough, and now treats the gym as the fixed point the rest of her week bends
around. She dresses for the commute — clothes that survive a 6am session, a full
workday and dinner without a change. She is unglamorous about the fitness part
and specific about the clothes part, which is roughly the inverse of most
accounts in this space. She is not trying to sell anyone a transformation.

**Why this backstory and not a more aspirational one:** a persona whose whole
identity is "fit and beautiful" has nothing to post about on day 40. One with a
job, a commute and a race in January has a calendar — training blocks, work
travel, the monsoon ruining her long runs. Content plans come from constraints,
not from vibes.

## Wardrobe rules

- **Palette** — charcoal `#3A3A3C`, sand `#D8CBB8`, off-white `#F2EFE9`,
  olive `#6B705C`, rust `#A8553A`, black `#141414`
- **Silhouettes** — exactly three:
  1. Cropped top + high-waisted wide-leg trousers
  2. Fitted technical activewear (leggings + a longline sports top)
  3. Oversized shirt or overshirt, worn open, over either of the above
- **Jewellery / accessories** — one thin gold chain, small gold hoops, a black
  digital running watch. The watch appears in nearly every shot; it is the
  cheapest continuity signal there is, and continuity is what makes a face read
  as a person.
- **Never wears** — logos or visible brand marks, sequins, neon, heavy makeup,
  anything shorter than mid-thigh, sarees or lehengas (she would wear them in
  life; they are excluded here because occasion-wear breaks the wardrobe's
  recurring-shape logic and Flux renders their drape poorly)

## Locations — exactly five

<!-- Five, not "a few". A persona seen in five recurring places reads as someone
with a life; one seen anywhere reads as a stock model. -->

1. **`home_balcony`** — small Bandra apartment balcony, potted money plants and a
   tulsi, dark green window frames, drying rack pushed to one side, low city
   skyline behind
2. **`gym_floor`** — plain neighbourhood gym, rubber flooring, black powder-coated
   racks, mirrored wall on one side, high windows with flat daylight
3. **`corner_cafe`** — small Bandra cafe, wooden tables, exposed brick, a large
   street-facing window, filter coffee and a laptop
4. **`sea_promenade`** — Carter Road seafront at first light, low concrete wall,
   palms, joggers out of focus behind her
5. **`studio_desk`** — her work desk, twin monitors, a pinboard of colour swatches,
   an anglepoise lamp, plants along the sill

## Voice

- **Register:** Hinglish, warm, dry. More self-deprecating than motivational.
- **Sentence length:** Short. Two to four sentences, rarely more.
- **Emoji policy:** At most one, at the end, and often none.
- **Words and phrases she uses:** "honestly", "bas", "we move", "not my finest",
  "let's see"
- **Never posts about:** politics, religion, other people's bodies, before/after
  comparisons, anything framed as a transformation

Three example captions, in her voice:

1. 5:40am and it is already humid. Did the run anyway, walked half of it. bas,
   we move.
2. Wore this to a standup, a client call and dinner. Same clothes, three
   personalities. This is the whole point of the wide-leg trouser.
3. Week 6 of the half marathon plan. Honestly the plan is winning. Let's see.

## Look profile

| Control            | Value          | Allowed |
|--------------------|----------------|---------|
| base_look          | editorial      | editorial · warm_film · clean_digital · grainy_street |
| lens               | portrait_85    | portrait_85 · natural_50 · environmental_35 |
| colour             | warm           | warm · neutral · cool · contrast |
| grain              | fine           | none · fine · visible |
| skin               | natural        | subtle · natural · textured |
| natural_asymmetry  | true           | true · false |
| hair_detail        | true           | true · false |
| base_checkpoint    | flux1-dev      | set by base_look |

**Why `natural` skin and not `subtle`:** `subtle` is the setting that quietly
makes every avatar look like every other avatar. Visible pores are the single
strongest signal separating "photo of a person" from "AI image", and they cost
nothing.

**Why `fine` grain and `warm`:** together they read as a phone camera in Indian
daylight rather than a render. Neutral + no grain is technically cleaner and
lands in the uncanny valley.

## Seed set

- **Path:** `personas/aanya-kapoor/seed/`
- **Count:** target 20 curated, culled from ~300
- **LoRA version trained on it:** (fill after training)
- **Coverage checklist** — the set must span these or the LoRA will only hold in
  the conditions it saw:
  - [ ] Front, three-quarter and profile angles
  - [ ] Soft and hard light
  - [ ] At least three of the five locations
  - [ ] Neutral plus two other expressions
  - [ ] Close, medium and full framing

**On culling:** keep the ones that look like the *same person*, not the ones that
look best. A striking frame that is subtly a different face is worse than a dull
frame that is unmistakably her — the set's mean embedding becomes the reference
every future image is judged against, permanently.

## Consent — modes `twin` and `reference` only

Not applicable. `mode: synthetic` — this persona depicts nobody. No consent
record is required, and none should be created.

---

## Quality checks

- [x] `identity_block` is physical-only and 43 words
- [x] No clothing, location, mood or lighting in `identity_block`
- [x] Exactly five locations, each with a `key`
- [x] Voice section contains three real example captions
- [x] `lora_trigger` is a made-up token (`a4ny4prsn`), not her name
- [x] `disclosure_line` present
- [x] Nothing here names or resembles a real public figure
- [ ] `voice_id` chosen and locked
