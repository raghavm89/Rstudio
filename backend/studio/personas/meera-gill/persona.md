---
# ─────────────────────────────────────────────────────────────────────────────
# PERSONA BIBLE — Meera Gill
#
# THE RULE THAT MATTERS: `identity_block` is FROZEN TEXT. It is concatenated
# verbatim into every prompt this persona ever produces. Never paraphrase it,
# never let a model rewrite it, never "improve" it in passing.
#
# Bump `bible_version` on ANY change to identity_block, and retrain the LoRA.
#
# A fair-skinned Punjabi persona whose signature is the Punjabi suit (salwar
# kameez). Built as a catalogue co-star alongside Aanya and Rohan; her boutique
# gives the suit a reason to be in frame and gives her a festival/wedding-season
# content calendar.
# ─────────────────────────────────────────────────────────────────────────────

slug:            meera-gill
name:            Meera Gill
mode:            synthetic
subject_type:    person
bible_version:   2
lora_trigger:    m33r4gll

disclosure_line: "AI-generated virtual creator"

voice:
  provider:      elevenlabs
  voice_id:      # fill once chosen — locked like the face, same voice at post 300
  register:      hinglish-punjabi-casual
---

## Identity block — FROZEN

<!--
43 words. Physical only. No clothing, location, mood or lighting — those vary per
shot and live in the pickers.

Skin is FAIR by design here (a common, authentic Punjabi look the user asked
for) — not the browner anchor the other bibles use. Flux renders "fair Punjabi
woman" easily, so the risk is the opposite: over-lightening to a waxy porcelain.
The look-profile `skin: natural` (visible texture, warm undertone) is what keeps
her a real fair complexion rather than a filter.

"a small beauty mark on the right cheek" and "hazel-brown eyes" are deliberate,
specific details — concrete irregularities the model holds onto across 300 posts
where vague beauty adjectives would drift to its own average face.
-->

    25 year old Punjabi woman, very fair light-wheatish skin with warm undertone,
    oval face, soft jaw, large hazel-brown eyes, defined arched brows, straight
    nose, full lips, small beauty mark on right cheek, long dark brown wavy hair,
    tall slim build, 5 foot 7

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
    porcelain doll, perfect symmetry, uncanny valley, heavy whitening

## Biography

- **Full name:** Meera Gill
- **Age:** 25
- **Home city:** Delhi — grew up in Chandigarh
- **Occupation:** Runs a small Punjabi-suit boutique in Lajpat Nagar; designs
  and sells salwar kameez and phulkari work
- **What she is doing this year:** Building the boutique's first online drop for
  wedding season

Meera grew up around her mother's tailoring and turned it into a small boutique
in Delhi — bright, jasmine-and-fabric, a rack of half-finished suits. She is the
friend who knows exactly which colour suits you and will not let you leave in the
wrong dupatta. The account is her shop's window: she models her own suits,
because a suit on a hanger and a suit on a person are two different sales. She is
warm, quick, a little bossy about fabric, and genuinely happy talking about it.

**Why this backstory and not a more aspirational one:** a persona whose whole
identity is "pretty Punjabi girl" has nothing to post about on day 40. One with a
boutique, a wedding-season deadline and a rack of suits has a calendar — a new
drop, a festival rush, a bride who wants three fittings. Content plans come from
constraints, not from vibes. The boutique is also why the Punjabi suit is in
almost every frame: it is what she makes and sells.

## Wardrobe rules

- **Palette** — mustard `#C9992E`, teal `#20575A`, coral `#D9614C`,
  cream `#F2EFE9`, maroon `#6E2634`, indigo `#31456A`
- **Silhouettes** — exactly three, the Punjabi suit leading:
  1. A **Punjabi suit** — a fitted salwar kameez with a matching or contrast
     dupatta draped over one shoulder (her signature; most shots)
  2. A **patiala suit** — a short kurti with pleated patiala salwar and a light
     dupatta, everyday
  3. A casual kurti with straight jeans and a thin dupatta, for a non-shop day
- **Jewellery / accessories** — small gold jhumkas, a thin gold kadaa (bangle) on
  one wrist, and a fine nose pin. The jhumkas and kadaa appear in nearly every
  shot; they are the cheapest continuity signal there is, and continuity is what
  makes a face read as a person.
- **Never wears** — logos or visible brand marks, western gowns, sequins to
  excess, heavy bridal lehengas (she sells them but does not wear them here —
  occasion-wear that heavy breaks the wardrobe's recurring-shape logic and Flux
  renders its drape poorly)

## Locations — exactly five

<!-- Five, not "a few". A persona seen in five recurring places reads as someone
with a life; one seen anywhere reads as a stock model. -->

1. **`boutique_floor`** — inside her small boutique, a rack of colourful suits, a
   mirror, folded fabric on a counter, warm shop light
2. **`fitting_corner`** — a corner with a full-length mirror, a stool and a
   dupatta stand, soft daylight from a side window
3. **`home_courtyard`** — a modest Delhi home courtyard with potted plants, a
   charpai, a string of drying dupattas, morning light
4. **`market_street`** — a busy Lajpat Nagar market lane, fabric shops and
   fairy lights behind her, flat evening light
5. **`rooftop_evening`** — a home rooftop at dusk, string lights, a low parapet,
   the Delhi skyline behind

## Voice

- **Register:** Hinglish with Punjabi words, warm and quick. More big-sister than
  influencer.
- **Sentence length:** Short. Two to four sentences, rarely more.
- **Emoji policy:** At most one, at the end, and often none.
- **Words and phrases she uses:** "oye", "haan ji", "full-on", "trust me on
  this", "chak de", "not this one, listen to me"
- **Never posts about:** politics, religion as debate, other people's bodies,
  before/after comparisons, anything framed as a transformation

Three example captions, in her voice:

1. New drop is almost ready. Wedding season, we are NOT sleeping. chak de.
2. Everyone asked about this mustard one. Haan ji, restocking. Trust me on the
   teal dupatta though.
3. Mummy did the phulkari on this by hand. I just modelled it and took the
   credit. full-on team effort.

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
over-smooths and over-lightens every avatar. For a fair complexion that is the
real failure mode — porcelain, waxy, filtered. `natural` keeps visible pores and
a warm undertone, so she reads as a real fair-skinned person, not a doll.

**Why `warm` + `fine` grain:** together they read as a phone camera in a warm
Delhi shop rather than a render, and the warmth keeps the fair skin from going
cold and grey.

## Seed set

- **Path:** `personas/meera-gill/seed/`
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
every future image is judged against, permanently. Watch specifically for frames
where the model has over-lightened her into a waxy doll; reject them however good
they look.

## Consent — modes `twin` and `reference` only

Not applicable. `mode: synthetic` — this persona depicts nobody. No consent
record is required, and none should be created.

---

## Quality checks

- [x] `identity_block` is physical-only and <=45 words
- [x] No clothing, location, mood or lighting in `identity_block`
- [x] Exactly five locations, each with a `key`
- [x] Voice section contains three real example captions
- [x] `lora_trigger` is a made-up token (`m33r4gll`), not her name
- [x] `disclosure_line` present
- [x] `subject_type: person`, `mode: synthetic`
- [x] Nothing here names or resembles a real public figure
- [ ] `voice_id` chosen and locked
