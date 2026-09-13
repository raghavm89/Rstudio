---
# ─────────────────────────────────────────────────────────────────────────────
# PERSONA BIBLE — template
#
# One file per avatar, at personas/<slug>/persona.md. Never keep two.
# Everything below the front-matter is the bible; the front-matter maps 1:1 onto
# columns in `avatars`, so the loader is a straight read rather than a parse.
#
# THE RULE THAT MATTERS: `identity_block` is FROZEN TEXT. It is concatenated
# verbatim into every prompt this persona ever produces. Never paraphrase it,
# never let a model rewrite it, never "improve" it in passing. Creative variation
# happens in the scene, never inside identity — that is the entire reason the
# face is still hers at post 300.
#
# Bump `bible_version` on ANY change to identity_block, and retrain the LoRA.
# Old posts stay explainable because assets record which lora_id made them.
# ─────────────────────────────────────────────────────────────────────────────

slug:            # kebab-case, unique per tenant, e.g. aanya-kapoor
name:            # display name
mode:            # synthetic | twin
                 # synthetic depicts nobody and needs no consent record.
                 # twin is the ACCOUNT HOLDER'S OWN likeness and REQUIRES a
                 # verified consent_records row before any generation or training.
                 #
                 # `reference` (a photo of someone else) was removed in migration
                 # 033 and is refused by a CHECK constraint. Identifiability, not
                 # copying, is the legal test — and the face catalogue covers the
                 # legitimate "I want to point at a face" case.
bible_version: 1
lora_trigger:    # a token that appears in no real vocabulary, e.g. a4ny4prsn
                 # Made-up strings avoid colliding with concepts the base model
                 # already knows. Never use the persona's actual name.

disclosure_line: "AI-generated virtual creator"

voice:
  provider:      # elevenlabs | fishaudio | openai
  voice_id:      # locked once, like the face. Same voice at post 300.
  register:      # e.g. hinglish-casual
---

## Identity block — FROZEN

<!--
25–45 words. PHYSICAL ONLY. Age, region, skin tone, face shape, eyes, brow, nose,
lips, hair colour/length/texture, build, height.

NO clothing. NO location. NO mood. NO lighting. Those vary per shot and live in
the pickers; putting them here freezes them forever by accident.

Write it as one comma-separated run — it is prompt fragment, not prose.
-->

    <age> year old <region> woman, <skin tone> skin, <face shape> face,
    <eye colour and shape> eyes, <brow>, <nose>, <lips>,
    <hair colour, length, texture>, <build>, <height>

## Avoid block — FROZEN

<!--
Standing terms to keep out of every generation.

NOTE ON FLUX: Flux dev is guidance-distilled and effectively ignores a negative
prompt. So on Flux this block is not sent as a negative — it works by ABSENCE:
none of these phrases exists anywhere in prompt_vocabulary, so no combination of
picker choices can emit them. The block is kept for models that do honour a
negative prompt, and as documentation of what we deliberately never say.

Never add "flawless skin", "porcelain complexion", "perfect symmetry" or
"airbrushed" as things to *ask for*. They are here as things to avoid.
-->

    extra fingers, deformed hands, malformed limbs, text artifacts, watermark,
    multiple faces, plastic skin, over-smoothed skin, airbrushed, waxy,
    perfect symmetry, uncanny valley, doll-like

## Biography

<!--
Five sentences. Used ONLY by the caption and script models — never by the image
model, which cannot render a backstory.
-->

- **Full name:**
- **Age:**
- **Home city:**
- **Occupation:**
- **What she is doing this year:**

Backstory (5 sentences):

## Wardrobe rules

- **Palette** — 4–6 colours, as hex or as names. Everything she wears comes from here.
- **Silhouettes** — exactly 3 recurring shapes.
- **Jewellery / accessories** — the standing rule.
- **Never wears** — the list matters as much as the palette.

## Locations — exactly five

<!--
Five, not "a few". A persona seen in five recurring places reads as a real person
with a life; one seen anywhere reads as a stock model. Describe each concretely
enough to prompt from — these become the location picker's five thumbnails.
-->

1. **`key`** —
2. **`key`** —
3. **`key`** —
4. **`key`** —
5. **`key`** —

## Voice

- **Register:** (e.g. Hinglish, warm, self-deprecating)
- **Sentence length:**
- **Emoji policy:**
- **Words and phrases she uses:** (five)
- **Never posts about:**

Three example captions, written in her voice — not descriptions of her voice:

1.
2.
3.

## Look profile

<!--
Frozen at setup. These are picker choices, not free text — the exact values
allowed are the option_keys in prompt_vocabulary. Changing any of them later
means recalibrating the expression baselines, because the QC gate measures
against a face generated under these settings.
-->

| Control            | Value  | Allowed |
|--------------------|--------|---------|
| base_look          |        | editorial · warm_film · clean_digital · grainy_street |
| lens               |        | portrait_85 · natural_50 · environmental_35 |
| colour             |        | warm · neutral · cool · contrast |
| grain              |        | none · fine · visible |
| skin               |        | subtle · natural · textured |
| natural_asymmetry  | true   | true · false |
| hair_detail        | true   | true · false |
| base_checkpoint    |        | set by base_look |

## Seed set

- **Path:**
- **Count:** (15–30 curated, culled from far more)
- **LoRA version trained on it:**
- **Coverage checklist** — the set must span these or the LoRA will only hold in
  the conditions it saw:
  - [ ] Front, three-quarter and profile angles
  - [ ] Soft and hard light
  - [ ] At least three of the five locations
  - [ ] Neutral plus two other expressions
  - [ ] Close, medium and full framing

## Consent — `twin` mode only

<!--
Leave empty for a synthetic persona; it depicts nobody.

For twin: the subject records a consent video on the hosted page,
speaking the stated phrase in any language, single visible face, clear audio, and
the system verifies it is the same person as the reference material. A ticked box
saying "I have permission" is not a gate — it is a log entry proving you knew.
-->

- **consent_record_id:**
- **Subject:**
- **Method:** hosted_capture | prerecorded | indemnity
- **Verified at:**

---

## Quality checks before this file is done

- [ ] `identity_block` is physical-only and under 45 words
- [ ] No clothing, location, mood or lighting anywhere in `identity_block`
- [ ] Exactly five locations, each with a `key` matching the location picker
- [ ] Voice section contains three real example captions
- [ ] `lora_trigger` is a made-up token, not her name
- [ ] `disclosure_line` present
- [ ] Nothing in this file names or resembles a real public figure
- [ ] For twin: a verified consent record exists **before** generating
