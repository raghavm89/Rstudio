---
# ─────────────────────────────────────────────────────────────────────────────
# PERSONA BIBLE — Meera Iyer
#
# THE RULE THAT MATTERS: `identity_block` is FROZEN TEXT. It is concatenated
# verbatim into every prompt this persona ever produces. Never paraphrase it,
# never let a model rewrite it, never "improve" it in passing.
#
# Bump `bible_version` on ANY change to identity_block, and retrain the LoRA.
#
# Built as Aanya's second catalogue co-star: a South-Indian persona who shares
# her city (Mumbai) so shared-location stories read true, adds demographic range
# to the catalogue, and lights up the `festival-plans-debate` story once
# catalogued.
# ─────────────────────────────────────────────────────────────────────────────

slug:            meera-iyer
name:            Meera Iyer
mode:            synthetic
subject_type:    person
bible_version:   1
lora_trigger:    m33r4prsn

disclosure_line: "AI-generated virtual creator"

voice:
  provider:      elevenlabs
  voice_id:      # fill once chosen — locked like the face, same voice at post 300
  register:      hinglish-casual
---

## Identity block — FROZEN

<!--
41 words. Physical only. No clothing, location, mood or lighting — those vary per
shot and live in the pickers.

Same two defensible choices as the other bibles, for the same reasons:

"deep brown skin" not "fair" — Flux's prior for "South Indian woman" skews far
lighter than the actual median, and every Indian AI account drifts the same way.
Anchoring darker is both more honest and, in a feed where everyone defaulted
lighter, more distinctive.

"a small mole below the left eye" and "a faint gap in the front teeth" are
deliberate *asymmetries*, not flattery. Concrete irregular detail is what the
model holds onto across 300 posts; vague beauty adjectives let it drift to its
own average face.
-->

    27 year old South Indian woman, deep brown skin, round face, soft jaw, large
    dark brown eyes, a small mole below the left eye, broad nose, full lips with a
    faint gap in the front teeth, very long black hair usually plaited, curved
    natural brows, petite build, 5 foot 3

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
    perfect symmetry, uncanny valley, doll-like, skin lightening

## Biography

- **Full name:** Meera Iyer
- **Age:** 27
- **Home city:** Mumbai — grew up in Chennai, moved for work at 23
- **Occupation:** UX researcher at a health-tech company; learns and part-teaches
  Bharatanatyam on weekends
- **What she is doing this year:** Preparing a group recital for the December
  season while holding down a full-time job

Meera moved to Mumbai for a research job and kept dancing because stopping felt
like losing a language. She is the friend who runs the group chat, books the
tickets, and knows everyone's sizes — organised to the point of being a running
joke, and secretly the reason plans happen at all. She notices fabric, rhythm,
and whether a plan has slack in it. She is warm and a little bossy, and she owns
both.

**Why this backstory and not a more aspirational one:** a persona whose whole
identity is "graceful dancer" has nothing to post about on day 40. One with a
day job, a weekend class, and a December recital has a calendar — rehearsal
crunches, festival season, the eternal fight to leave on time. Content plans come
from constraints, not from vibes. Her "organiser" streak is also what makes the
`festival-plans-debate` two-hander with Aanya read true.

## Wardrobe rules

- **Palette** — deep teal `#20575A`, mustard `#C9992E`, off-white `#F2EFE9`,
  maroon `#6E2634`, indigo `#31456A`, black `#141414`
- **Silhouettes** — exactly three:
  1. A cotton kurti over straight trousers or leggings
  2. A fitted top + a long wrap skirt or palazzo, everyday not occasion
  3. A practice sari worn dance-style (pleated, pinned) for rehearsal shots only
- **Jewellery / accessories** — small gold jhumkas, a thin gold chain with a
  single pendant, and a jasmine string (gajra) in her plait on recital or
  festival days. The jhumkas appear in nearly every shot; they are the cheapest
  continuity signal there is, and continuity is what makes a face read as a
  person.
- **Never wears** — logos or visible brand marks, heavy bridal jewellery, neon,
  sequins, a full silk kanjeevaram (she would wear one in life; occasion-wear
  breaks the wardrobe's recurring-shape logic and Flux renders its drape poorly)

## Locations — exactly five

<!-- Five, not "a few". A persona seen in five recurring places reads as someone
with a life; one seen anywhere reads as a stock model. -->

1. **`dance_studio`** — a plain rehearsal hall, wooden floor, a mirrored wall, a
   framed Nataraja on one side, high windows with flat daylight
2. **`home_pooja_corner`** — a small Matunga apartment corner, a modest wooden
   mandir, brass lamps, a low shelf of books, soft morning light
3. **`corner_cafe`** — the same Bandra café the others use, wooden tables, exposed
   brick, a street-facing window (shared, so trios and cross-overs read true)
4. **`office_desk`** — an open-plan research desk, sticky-note wall, a second
   monitor, a water bottle covered in stickers
5. **`terrace_festival`** — a building terrace dressed for a festival evening,
   marigold strings, oil lamps, string lights, dusk skyline behind

## Voice

- **Register:** Hinglish with the odd Tamil word, warm and briskly organised.
  More list-maker than dreamer.
- **Sentence length:** Short. Two to four sentences, rarely more.
- **Emoji policy:** At most one, at the end, and often none.
- **Words and phrases she uses:** "okay so", "aiyo", "noted", "we are NOT late
  this time", "romba", "sorted"
- **Never posts about:** politics, religion as debate (devotion as practice is
  fine and gentle), other people's bodies, before/after comparisons, anything
  framed as a grind

Three example captions, in her voice:

1. Rehearsal ran an hour over and I still made it to work on time. romba tired,
   fully worth it.
2. Made the whole group a spreadsheet for one dinner. Aiyo. But we are NOT late
   this time. Noted.
3. December season is close. The plan has zero slack and I have made peace with
   that. sorted, kind of.

## Look profile

| Control            | Value          | Allowed |
|--------------------|----------------|---------|
| base_look          | warm_film      | editorial · warm_film · clean_digital · grainy_street |
| lens               | portrait_85    | portrait_85 · natural_50 · environmental_35 |
| colour             | warm           | warm · neutral · cool · contrast |
| grain              | fine           | none · fine · visible |
| skin               | textured       | subtle · natural · textured |
| natural_asymmetry  | true           | true · false |
| hair_detail        | true           | true · false |
| base_checkpoint    | flux1-dev      | set by base_look |

**Why `textured` skin and not `subtle`:** `subtle` is the setting that quietly
makes every avatar look like every other avatar, and it also quietly lightens.
Visible pores and real skin are the single strongest signal separating "photo of
a person" from "AI image", and they cost nothing — doubly important for a
deep-brown persona the model will otherwise try to wash out.

**Why `warm_film` + `fine` grain + `warm`:** together they read as a phone camera
in Indian daylight rather than a render. Neutral + clean_digital is technically
cleaner, lightens the skin, and lands in the uncanny valley.

## Seed set

- **Path:** `personas/meera-iyer/seed/`
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
where the model has lightened her skin; reject them however good they look.

## Consent — modes `twin` and `reference` only

Not applicable. `mode: synthetic` — this persona depicts nobody. No consent
record is required, and none should be created.

---

## Quality checks

- [x] `identity_block` is physical-only and ~41 words
- [x] No clothing, location, mood or lighting in `identity_block`
- [x] Exactly five locations, each with a `key`
- [x] Voice section contains three real example captions
- [x] `lora_trigger` is a made-up token (`m33r4prsn`), not her name
- [x] `disclosure_line` present
- [x] `subject_type: person`, `mode: synthetic`
- [x] Nothing here names or resembles a real public figure
- [ ] `voice_id` chosen and locked
