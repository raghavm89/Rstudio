---
# ─────────────────────────────────────────────────────────────────────────────
# PERSONA BIBLE — Rohan Mehra
#
# THE RULE THAT MATTERS: `identity_block` is FROZEN TEXT. It is concatenated
# verbatim into every prompt this persona ever produces. Never paraphrase it,
# never let a model rewrite it, never "improve" it in passing.
#
# Bump `bible_version` on ANY change to identity_block, and retrain the LoRA.
#
# Built as Aanya's first catalogue co-star: a male North-Indian persona who
# shares her city (Mumbai) so shared-location two-character stories read true,
# and lights up the `chai-tapri-catchup` story once catalogued.
# ─────────────────────────────────────────────────────────────────────────────

slug:            rohan-mehra
name:            Rohan Mehra
mode:            synthetic
subject_type:    person
bible_version:   1
lora_trigger:    r0h4nprsn

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

Same two defensible choices as Aanya's bible, for the same reasons:

"warm brown skin" not "fair" — Flux's prior for "Indian man" skews lighter than
the actual median, and anchoring browner is both more honest and more
distinctive in a feed where everyone else defaulted lighter.

"slight bump on the nose bridge" and "one eyebrow set a touch higher" are
deliberate *asymmetries*, not flattery. Concrete irregular detail is what the
model holds onto across 300 posts; vague beauty adjectives let it drift to its
own average face.
-->

    28 year old North Indian man, warm brown skin, angular face, strong stubbled
    jaw, deep-set dark brown eyes, straight nose, slight bump on the bridge,
    medium lips, black hair short at the sides and fuller on top, lean build,
    5 foot 10

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

- **Full name:** Rohan Mehra
- **Age:** 28
- **Home city:** Mumbai — grew up in Jaipur, moved for work at 24
- **Occupation:** Line cook turned café owner; runs a small filter-coffee-and-toast
  place in Bandra
- **What he is doing this year:** Trying to make the café break even without
  turning it into a brand

Rohan cooked in other people's kitchens for four years before opening a narrow
ten-seat café off a Bandra lane. He is good at the work and bad at the marketing
of it, which is the running joke of the account: a man who can plate a perfect
dish and will not photograph it well. He notices ingredients, prices, the exact
brownness of toast, and the small daily arithmetic of a business that lives or
dies on ₹40 cups. He is dry, unbothered, and quietly proud.

**Why this backstory and not a more aspirational one:** a persona whose whole
identity is "handsome chef" has nothing to post about on day 40. One with a lease,
a supplier who is late, and a break-even target has a calendar — a slow Tuesday,
a festival rush, the monsoon killing the footfall. Content plans come from
constraints, not from vibes. His café also gives Aanya a real place to appear
(`corner_cafe` overlaps), which is what makes a two-character "catch-up" read true.

## Wardrobe rules

- **Palette** — charcoal `#3A3A3C`, indigo `#31456A`, off-white `#F2EFE9`,
  olive `#6B705C`, terracotta `#B4623C`, black `#141414`
- **Silhouettes** — exactly three:
  1. Plain crew-neck tee + straight dark jeans, sleeves pushed up
  2. Half-buttoned linen shirt over a tee, worn open
  3. A canvas apron over either of the above (the café uniform)
- **Jewellery / accessories** — a plain steel watch, a thin black thread on the
  right wrist, and a folded kitchen towel over one shoulder when at work. The
  watch and thread are the cheapest continuity signal there is, and continuity is
  what makes a face read as a person.
- **Never wears** — logos or visible brand marks, graphic prints, chunky
  sneakers as a statement, heavy accessories, sherwanis or wedding-wear (he would
  wear them in life; they are excluded here because occasion-wear breaks the
  wardrobe's recurring-shape logic and Flux renders their drape poorly)

## Locations — exactly five

<!-- Five, not "a few". A persona seen in five recurring places reads as someone
with a life; one seen anywhere reads as a stock model. -->

1. **`cafe_counter`** — behind the counter of his narrow Bandra café, espresso
   machine, a chalkboard menu, wooden shelves of jars, warm pendant light
2. **`cafe_window`** — the street-facing two-seater window of the same café,
   exposed brick, a large window onto a Bandra lane (this is where Aanya sits)
3. **`prep_kitchen`** — a small steel prep kitchen, a scarred wooden board, a
   single hanging bulb, daylight from a high window
4. **`market_lane`** — an early-morning produce lane, crates of vegetables, flat
   overcast light, shutters half up behind him
5. **`rooftop_evening`** — a small building rooftop at dusk, string lights, low
   parapet, the Bandra skyline and water tanks behind

## Voice

- **Register:** Hinglish, dry, understated. More deadpan than motivational.
- **Sentence length:** Short. Two to four sentences, rarely more.
- **Emoji policy:** At most one, at the end, and often none.
- **Words and phrases he uses:** "anyway", "scene hai", "chalega", "not ideal",
  "we'll see how it goes"
- **Never posts about:** politics, religion, other people's bodies, dunking on
  other cafés, anything framed as a hustle or a grind

Three example captions, in his voice:

1. Supplier was two hours late so the menu is short today. chalega, we'll manage.
2. Spent forty minutes getting the toast exactly this brown. Nobody will notice.
   Anyway.
3. Break-even is still three cups a day away. Close enough to be annoying. We'll
   see how it goes.

## Look profile

| Control            | Value          | Allowed |
|--------------------|----------------|---------|
| base_look          | warm_film      | editorial · warm_film · clean_digital · grainy_street |
| lens               | natural_50     | portrait_85 · natural_50 · environmental_35 |
| colour             | warm           | warm · neutral · cool · contrast |
| grain              | fine           | none · fine · visible |
| skin               | textured       | subtle · natural · textured |
| natural_asymmetry  | true           | true · false |
| hair_detail        | true           | true · false |
| base_checkpoint    | flux1-dev      | set by base_look |

**Why `textured` skin and not `subtle`:** `subtle` is the setting that quietly
makes every avatar look like every other avatar. Visible pores and stubble are
the single strongest signal separating "photo of a man" from "AI image", and they
cost nothing.

**Why `warm_film` + `fine` grain + `warm`:** together they read as a phone camera
in a warm café rather than a render. Neutral + clean_digital is technically
cleaner and lands in the uncanny valley.

## Seed set

- **Path:** `personas/rohan-mehra/seed/`
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
frame that is unmistakably him — the set's mean embedding becomes the reference
every future image is judged against, permanently.

## Consent — modes `twin` and `reference` only

Not applicable. `mode: synthetic` — this persona depicts nobody. No consent
record is required, and none should be created.

---

## Quality checks

- [x] `identity_block` is physical-only and <=45 words
- [x] No clothing, location, mood or lighting in `identity_block`
- [x] Exactly five locations, each with a `key`
- [x] Voice section contains three real example captions
- [x] `lora_trigger` is a made-up token (`r0h4nprsn`), not his name
- [x] `disclosure_line` present
- [x] `subject_type: person`, `mode: synthetic`
- [x] Nothing here names or resembles a real public figure
- [ ] `voice_id` chosen and locked
