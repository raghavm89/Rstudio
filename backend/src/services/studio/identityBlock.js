'use strict';

/**
 * What makes an identity block valid.
 *
 * ── Why this is a module and not a form validator ───────────────────────────
 *
 * The identity block is concatenated VERBATIM into every prompt this avatar
 * will ever generate, and it is frozen: changing it invalidates the trained
 * LoRA and every calibrated QC baseline, so an edit is a deliberate act with a
 * bible_version behind it rather than a typo fix. It is the single most
 * expensive field in the product to get wrong, because nothing about getting it
 * wrong is visible at the time — you find out three hundred images later that
 * every one of them has the same red saree in it.
 *
 * These rules already existed, as `die()` calls inside studio/load-persona.js,
 * where an HTTP request cannot reach them. So a form would have had to restate
 * them, and two statements of one rule is one statement that silently stops
 * being true. This module is the single statement; the CLI and the API both
 * read it, and the browser is served the word lists rather than keeping a copy.
 */

const WORD_MIN = 20;
const WORD_MAX = 45;

/**
 * Words that freeze a VARIABLE into the identity.
 *
 * Clothing, mood, location and lighting change from shot to shot — that is what
 * a shoot IS. Putting one here does not describe the person, it welds one
 * afternoon onto them permanently.
 */
const LEAKED = [
  'wearing', 'dressed', 'outfit', 'saree', 'sari', 'kurta', 'shirt', 'dress',
  'smiling', 'smile', 'laughing', 'happy', 'sad', 'serious expression',
  'standing in', 'sitting in', 'at the beach', 'in a cafe', 'background',
  'sunlight', 'sunlit', 'studio light', 'golden hour', 'neon',
];

/**
 * Words that ask for the exact look this whole system exists to avoid.
 *
 * "Flawless" and its relatives are instructions to erase pores, asymmetry and
 * hair strays — the texture that makes a face read as a photograph of a person
 * rather than a render of one.
 */
const BANNED = ['flawless', 'porcelain', 'perfect symmetry', 'airbrushed', 'poreless', 'blemish-free'];

/** Words, counted the way a person would count them. */
const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

/** Collapse whitespace. Two spaces in a frozen string is two spaces forever. */
const normalise = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * Check an identity block.
 *
 * Returns `{ ok, words, errors: [{ code, message, found? }] }` — every problem
 * at once rather than the first one. A form that reveals one rule per submit is
 * a form somebody abandons on the third attempt.
 */
function validate(text, { name = '' } = {}) {
  const identity = normalise(text);
  const errors = [];
  const words = wordCount(identity);

  if (!identity) {
    return { ok: false, words: 0, errors: [{ code: 'EMPTY', message: 'An avatar with no identity block has no face to hold.' }] };
  }

  if (words > WORD_MAX) {
    errors.push({ code: 'TOO_LONG', words,
      message: `${words} words; the cap is ${WORD_MAX}. Past that the description dilutes — the model averages the extra detail away and the face drifts.` });
  }
  if (words < WORD_MIN) {
    errors.push({ code: 'TOO_SHORT', words,
      message: `Only ${words} words. Under ${WORD_MIN} there is not enough here to hold one consistent face across hundreds of images.` });
  }

  const leaked = LEAKED.filter((w) => identity.toLowerCase().includes(w));
  if (leaked.length) {
    errors.push({ code: 'LEAKED_VARIABLE', found: leaked,
      message: `Contains ${leaked.join(', ')}. Clothing, mood, location and lighting change from shot to shot — freezing one here puts it in every image this avatar ever makes.` });
  }

  const banned = BANNED.filter((w) => identity.toLowerCase().includes(w));
  if (banned.length) {
    errors.push({ code: 'BANNED_LOOK', found: banned,
      message: `Asks for ${banned.join(', ')} — the plastic look the prompt vocabulary is built to avoid. Skin needs pores and asymmetry to read as real.` });
  }

  // The name is the subtlest of these. A first name the base model recognises
  // drags the face towards whoever it has seen with that name, and a made-up
  // one is just noise in a slot that could have described a jawline.
  const first = String(name || '').trim().split(/\s+/)[0];
  if (first && first.length > 2 && identity.toLowerCase().includes(first.toLowerCase())) {
    errors.push({ code: 'CONTAINS_NAME', found: [first],
      message: `Contains the name "${first}". This block is physical description only — a name pulls the face towards whoever the model already associates with it.` });
  }

  return { ok: errors.length === 0, words, errors, identity };
}

/**
 * Build a block from structured fields.
 *
 * The order is not arbitrary: age and origin first because they set the
 * template the model starts from, then the features that distinguish this
 * person from that template. A distinguishing mark goes last, where it reads as
 * an addition rather than a correction.
 */
const FIELDS = [
  { key: 'age',        label: 'Age',          placeholder: '26',                         hint: 'A number. "Young" means nothing specific to a model.', required: true },
  { key: 'origin',     label: 'Origin',       placeholder: 'North Indian',               hint: 'Regional, not national — "Indian" spans faces that look nothing alike.', required: true },
  { key: 'presenting', label: 'Presenting as', placeholder: 'woman',                     hint: 'woman · man · person', required: true },
  { key: 'skin',       label: 'Skin',         placeholder: 'warm medium-brown skin',     hint: 'Tone and undertone. Not "fair" or "flawless".', required: true },
  { key: 'build',      label: 'Build',        placeholder: 'lean athletic build',        required: true },
  { key: 'height',     label: 'Height',       placeholder: '5 foot 6',                   hint: 'Affects how the body is framed at full length.' },
  { key: 'hair',       label: 'Hair',         placeholder: 'dark brown hair to mid-back, loose natural wave', hint: 'Colour, length and texture — the three that change the silhouette.', required: true },
  { key: 'eyes',       label: 'Eyes',         placeholder: 'dark brown almond eyes' },
  { key: 'face',       label: 'Face shape',   placeholder: 'oval face, soft jaw' },
  { key: 'mark',       label: 'Distinguishing feature', placeholder: 'a small mole below the left eye',
    hint: 'Optional, and the strongest single anchor you can give — one specific asymmetry the model can hold on to.' },
];

function compose(fields = {}) {
  const get = (k) => normalise(fields[k]);
  const age = get('age');
  const head = [
    age ? `${age} year old` : '',
    get('origin'),
    get('presenting'),
  ].filter(Boolean).join(' ');

  return [head, get('skin'), get('build'), get('height'), get('hair'), get('eyes'), get('face'), get('mark')]
    .filter(Boolean)
    .join(', ');
}

/**
 * A LoRA trigger token.
 *
 * Must not be a real word: the base model already has opinions about every word
 * it knows, and a trigger that collides with one inherits them. Lowercase
 * alphanumeric with at least one digit, which is unlikely to be a word in any
 * language the tokeniser has strong priors about.
 */
const TRIGGER_SHAPE = /^[a-z0-9]{6,20}$/;
const validTrigger = (t) => TRIGGER_SHAPE.test(String(t || '')) && /[0-9]/.test(String(t));

/**
 * Derive one from a name by vowel-substitution — a4ny4prsn from "Aanya".
 *
 * Recognisably related to the avatar so a human reading a prompt knows whose it
 * is, while not being a token the model has ever seen.
 */
function suggestTrigger(name = '') {
  const base = String(name).toLowerCase().replace(/[^a-z]/g, '').slice(0, 10) || 'persona';
  const swapped = base.replace(/a/g, '4').replace(/e/g, '3').replace(/o/g, '0');
  let out = /[0-9]/.test(swapped) ? swapped : `${swapped}${Math.floor(Math.random() * 90 + 10)}`;
  if (out.length < 6) out = `${out}${Math.random().toString(36).slice(2, 8)}`.slice(0, 12);
  return out.slice(0, 20);
}

/** URL-safe, stable, and unique per tenant — it names the storage prefix too. */
function slugify(name = '') {
  return String(name).toLowerCase().normalize('NFKD')
    .replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60);
}

/** The default negative prompt. Present so nobody has to invent one on day one. */
const DEFAULT_AVOID = 'extra fingers, deformed hands, plastic skin, waxy skin, over-smoothed, watermark, text';

/** What the browser needs to check as you type, without keeping its own copy. */
function rules() {
  return {
    word_min: WORD_MIN,
    word_max: WORD_MAX,
    leaked: LEAKED,
    banned: BANNED,
    fields: FIELDS,
    default_avoid: DEFAULT_AVOID,
    trigger_shape: TRIGGER_SHAPE.source,
  };
}

module.exports = {
  WORD_MIN, WORD_MAX, LEAKED, BANNED, FIELDS, DEFAULT_AVOID,
  validate, compose, wordCount, normalise, suggestTrigger, slugify, validTrigger, rules,
};
