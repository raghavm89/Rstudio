#!/usr/bin/env node
'use strict';

/**
 * Generate the landing page's hero assets on fal.
 *
 * ── Why this is a script you run yourself ────────────────────────────────────
 * Neither sandbox that built this page can reach fal.ai — the Linux VM behind
 * the file tools has no egress, and the cloud container's proxy denies the host.
 * So this runs in your own Terminal, where the network is real:
 *
 *     node studio/hero-assets.js            # shows the plan and the price
 *     node studio/hero-assets.js --yes      # actually spends money
 *
 * ── Why fal and not the local weights ───────────────────────────────────────
 * The FLUX.1-dev weights on this machine are licensed for non-commercial use.
 * A marketing page for a paid product is commercial use of whatever it shows, so
 * nothing generated locally can appear on it at any size. fal's flux route
 * carries commercial rights through their agreement with BFL, which is the whole
 * reason this script exists rather than a `cp` from the seed set.
 *
 * ── The honesty constraint that shaped what it makes ────────────────────────
 * Aanya has no trained LoRA yet. Six separate generations would drift into six
 * near-identical strangers, and putting them up as "one persona, six setups"
 * would be a false claim about the product on the product's own front page.
 *
 * So: ONE still, then a video generated FROM that still, then frames cut out of
 * that video. Image-to-video preserves identity by construction, so every face
 * on the page is provably the same face — one take, six moments. That is a
 * weaker claim than the product makes, and it is true today, which is the only
 * kind of claim worth putting on a landing page.
 *
 * Re-run this after her LoRA is trained and calibrated, with --lora, to replace
 * the whole set with real per-setup frames and real likeness scores.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();   // also honour a .env beside this script

// ── Config ────────────────────────────────────────────────────────────────────

const OUT_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'hero');
const API = 'https://queue.fal.run';

const STILL_MODEL = process.env.FAL_STILL_MODEL_NOLORA || 'fal-ai/flux/dev';
const LORA_MODEL = process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora';
const MOTION_MODEL = process.env.FAL_MOTION_MODEL || 'fal-ai/bytedance/seedance/v1/pro/image-to-video';
const LORA_TRAINER = process.env.FAL_LORA_TRAINER || 'fal-ai/flux-lora-fast-training';

/**
 * 880 × 1104 = 0.971 MP.
 *
 * Not a round number by accident: fal bills per megapixel ROUNDED UP, so 896 ×
 * 1152 (1.03 MP) is billed as two megapixels and costs exactly twice this for
 * an image nobody can tell apart. The same cliff cost us the free tier's margin
 * once already.
 */
const STILL_W = 880;
const STILL_H = 1104;

const CENTS_PER_MP = Number(process.env.FAL_PRICE_STILL_CENTS ?? 3.5);
// Seedance v1 Pro i2v, token-derived per-second cost — the SAME rate the
// production meter uses (worker/providers/fal.js motionPerSecondCentsByResolution;
// $2.5/M tokens, ~24 fps). Both env-name spellings are honoured so one override
// covers this script and the meter.
const _motionCents = (sec, canonical, dflt) =>
  Number(process.env[canonical] ?? process.env[sec] ?? dflt);
const MOTION_CENTS_PER_SECOND = {
  '480p':  _motionCents('FAL_PRICE_MOTION_480_SEC_CENTS',  'FAL_PRICE_MOTION_480_CENTS',  2.4),
  '720p':  _motionCents('FAL_PRICE_MOTION_720_SEC_CENTS',  'FAL_PRICE_MOTION_720_CENTS',  5.4),
  '1080p': _motionCents('FAL_PRICE_MOTION_1080_SEC_CENTS', 'FAL_PRICE_MOTION_1080_CENTS', 12.15),
};

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const CONFIRMED = args.includes('--yes');
// Re-generating the sheet should not re-pay for a hero clip that is already
// good. The manifest is merged rather than replaced.
const SHEET_ONLY = args.includes('--sheet-only');
// Re-shooting one bad cell should cost one cell. Without this, correcting the
// detail frame meant paying for five frames that were already fine.
const ONLY = (() => {
  const v = flag('only', null);
  return v && v !== true ? String(v).split(',').map((k) => k.trim()).filter(Boolean) : null;
})();
/**
 * Two levers for the question a prompt cannot answer.
 *
 * When a framing clause is explicit ("head to feet, feet visible, half the frame
 * height") and the model returns a mid-thigh crop anyway, the prompt is no
 * longer what is deciding. A character LoRA trained on fifteen portraits learns
 * subject scale along with the face, and at scale 1.0 it applies that scale to
 * everything — the framing is not being ignored, it is being outvoted by the
 * weights.
 *
 *   --lora-scale 0.65   keep her identity, hand composition back to the base model
 *   --base              no LoRA at all: is the base model even capable of this shot?
 *
 * --base writes to setup-<key>-base.jpg and stays out of the manifest, because a
 * diagnostic that overwrites a cell you have already paid for is not free.
 */
/**
 * The two things a --base run and a LoRA run still had in common.
 *
 * Both produced the same mid-thigh crop from a framing clause that says "head to
 * feet, feet visible". So it is not the weights and not the wording — it is
 * something shared by both runs, and only two candidates are left:
 *
 *   --size 704x1248   aspect ratio. A 4:5 frame is a portrait frame; the model
 *                     composes to fill it, and a standing figure needs vertical
 *                     room the frame does not have.
 *   --guidance 6      prompt adherence. flux-dev at 3.5 treats composition
 *                     clauses as suggestion; higher forces them, at some cost to
 *                     the skin realism the look profile is built on.
 *
 * Sizes are checked against the megapixel cliff, because fal rounds up and the
 * difference between 0.88 MP and 1.01 MP is double the bill for four percent
 * more pixels.
 */
const SIZE = (() => {
  const v = flag('size', null);
  if (!v || v === true) return null;
  const m = String(v).match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) { console.error(`\n  ✗ --size wants WxH, e.g. 704x1248 — got "${v}"\n`); process.exit(1); }
  return { w: Number(m[1]), h: Number(m[2]) };
})();
const GUIDANCE_SET = flag('guidance', null) !== null;   // did the caller ask, or is this the default?
const GUIDANCE = Number(flag('guidance', 3.5));
const LORA_SCALE = Number(flag('lora-scale', 1.0));
const BASE = args.includes('--base');
// The sign-in page gets its own clip. Two pages sharing one video was fine while
// there was one video; it stops being fine the moment someone signs in, because
// the landing page and the sign-in page are then the same picture twice and the
// second one reads as a page that failed to load something.
const AUTH = args.includes('--auth');
/**
 * Re-shoot the performance without re-shooting the picture.
 *
 * The clip is generated FROM the still, so changing the motion normally means
 * generating a new still too — a new seed, a different frame, and the landing
 * page's first paint quietly changes underneath a change that was only ever
 * about movement. This uploads the poster already on disk and runs
 * image-to-video against it, so the poster is byte-identical across as many
 * motion attempts as it takes.
 *
 * It is also the only way back to a specific frame: fal's seeds exceed
 * Number.MAX_SAFE_INTEGER and the manifest stored them as JS numbers, so the
 * recorded seed is a rounded float and will not reproduce the image it names.
 * Seeds are written as strings from now on; the ones already in the file cannot
 * be recovered.
 */
const MOTION_ONLY = args.includes('--motion-only');
// Iterating on a performance means changing these words a few times. Editing the
// file to do it invites editing the wrong copy of the file.
const MOTION_PROMPT = (() => { const v = flag('motion', null); return v && v !== true ? String(v) : null; })();
const RESOLUTION = String(flag('resolution', '720p'));
const SECONDS = Number(flag('seconds', 5));
const FRAMES = Number(flag('frames', 6));
let LORA_PATH = flag('lora', null);        // set once her LoRA exists
const LORA_JOB = flag('lora-job', null);   // recover fal's own URL from a training job
const TRIGGER = flag('trigger', 'a4ny4prsn');

// ── The prompt ────────────────────────────────────────────────────────────────

/**
 * Assembled the same way the app assembles one — identity block first, then the
 * look profile, then the shot. Not copied from the app's builder because this
 * runs outside it, but deliberately in the same ORDER: prompt order is
 * load-bearing in Flux, and a hero image made a different way would not be
 * representative of what the product actually produces.
 */
const IDENTITY = [
  '26 year old North Indian woman, warm medium-brown skin, oval face, defined',
  'jawline, dark brown almond eyes, thick natural brows, straight nose, slightly',
  'rounded tip, full lips, dark brown hair to mid-back, loose natural wave,',
  'lean athletic build, 5 foot 6',
].join(' ');

// Aanya's locked look profile: editorial · 85mm · warm · fine grain · natural
// skin · asymmetry on · hair detail on.
const LOOK = [
  'relaxed neutral expression',
  'clean editorial lighting, low colour noise, magazine finish',
  '85mm f/1.4 portrait lens, shallow depth of field, eyes tack-sharp, soft bokeh background',
  'gentle feature compression',
  'soft diffused light, gradual shadow edges, lit from camera left',
  'warm afternoon light, warm colour grade, golden skin tones',
  'fine film grain',
  'visible skin pores, natural subsurface scattering, slight skin oiliness, faint freckles',
  'natural facial asymmetry, slightly uneven features',
  'individual hair strands visible at the hairline, natural flyaways, realistic hair sheen',
  'medium shot, waist up',
  'photorealistic, sharp focus on the eyes, natural colour',
];

// One of her five locations. The balcony is the right one for a hero: it is
// hers, it has depth for the 85mm to throw out of focus, and it does not read as
// a stock studio backdrop.
const SCENE = 'standing on a small Mumbai apartment balcony, potted money plants and tulsi, '
  + 'dark green window frames, low city skyline soft behind her, late afternoon';
const WARDROBE = 'cropped off-white top, high-waisted charcoal wide-leg trousers, '
  + 'one thin gold chain, small gold hoops, black digital running watch';

/**
 * The look profile, split by what a shot is allowed to contradict.
 *
 * This was a blocklist of two exact strings — '85mm f/1.4' and 'medium shot' —
 * and it did not work. Ten of the twelve lines survived it, and six of those ten
 * are face cues: pores, freckles, facial asymmetry, hairline strands, a neutral
 * expression, sharp focus on the eyes. Every cell therefore carried six
 * instructions to show a face, including the one whose framing reads "no face,
 * no head, no torso". Flux does not weigh one framing clause against six
 * contradicting ones; it takes the majority and returns a portrait. That is how
 * a six-setup sheet came back as six of the same shot, twice.
 *
 * So the profile is three groups now, rather than one list with two holes in it:
 *
 *   GRADE  — light, colour, grain. True of every frame, face in it or not.
 *   FACE   — skin, hair, expression, eye focus. Only for cells with a face.
 *   (lens and framing are not here at all — each setup states its own.)
 *
 * Grouping rather than filtering also means a new line cannot silently
 * reintroduce this: it has to be put in a group, and the group says where it is
 * allowed to appear.
 */
const GRADE = [
  'clean editorial lighting, low colour noise, magazine finish',
  'warm afternoon light, warm colour grade, golden skin tones',
  'fine film grain',
  'photorealistic, natural colour',
];

const FACE = [
  'relaxed neutral expression',
  'natural facial asymmetry, slightly uneven features',
];

/**
 * Skin and hair at pore scale — and only where a pore is bigger than a pixel.
 *
 * These read as realism cues, so the instinct is to put them on everything. But
 * "visible skin pores" and "individual hair strands at the hairline" describe a
 * face that is large in frame; ask for them on a full-length shot and the model
 * has one way to satisfy them, which is to move the camera in. They are a third
 * of the reason the wide cells kept coming back as portraits.
 */
const SKIN_MICRO = [
  'visible skin pores, natural subsurface scattering, slight skin oiliness, faint freckles',
  'individual hair strands visible at the hairline, natural flyaways, realistic hair sheen',
  'sharp focus on the eyes',
];

/**
 * Her identity at a distance.
 *
 * The full IDENTITY block is eleven clauses of facial anatomy — jaw, eyes,
 * brows, nose, lips. At full length none of it is legible, and all of it argues
 * for a closer camera. What actually carries her identity in a wide shot is the
 * LoRA plus silhouette: build, height, hair length and shape.
 */
const IDENTITY_DISTANT = '26 year old North Indian woman, warm medium-brown skin, '
  + 'lean athletic build, 5 foot 6, dark brown hair to mid-back, loose natural wave';

// Wardrobe for the cells where her feet are in shot. Shoes are absent from the
// main wardrobe because five of six setups crop above them — and that absence is
// part of why the sixth never rendered them.
const WARDROBE_FULL = WARDROBE + ', white leather sneakers with flat laces';

// The hero still is one 85mm portrait where every line of the profile is
// correct, so it goes on using the profile whole.
const LOOK_COMMON = LOOK;   // hero still only — the sheet uses GRADE / FACE.

/**
 * Six setups — the contact sheet.
 *
 * Only meaningful with a trained LoRA, which is why `--lora` gates it. Six
 * separate generations without one produce six plausible strangers, and putting
 * those up under "one persona" would be a false claim about the product on the
 * product's own front page.
 *
 * The sixth is deliberately not a face. A real contact sheet has a detail frame
 * on it, and a shot of her wrist carries the wardrobe continuity — the watch
 * that appears in nearly every post — without spending a sixth roll of the dice
 * on facial consistency.
 */
const SETUPS = [
  { key: 'close', label: 'Close · 85mm', w: 880, h: 1104,
    lens: '85mm f/1.4 portrait lens, shallow depth of field, eyes tack-sharp, soft bokeh background, gentle feature compression',
    framing: 'tight close up portrait, head and shoulders only, face fills the frame, cropped at the collarbone',
    light: 'soft diffused light, lit from camera left, gradual shadow edges' },
  { key: 'medium', label: 'Medium · 50mm', w: 880, h: 1104,
    lens: '50mm lens, natural perspective, moderate depth of field',
    framing: 'medium shot, waist up',
    light: 'window light from camera right, soft falloff' },
  { key: 'full', label: 'Full · 35mm', w: 880, h: 1104,
    distant: true,
    // 3.5 is the look profile's design point and every other cell keeps it. This
    // one does not, because at 3.5 flux-dev treats the floor-and-shoes clauses as
    // scenery it may drop, and dropping them is exactly the failure. The cost of
    // 6 is some skin micro-realism — which this cell has already given up, being
    // `distant`. Whether the new framing would hold at 3.5 was not tested; it is
    // one $0.035 frame to find out if the harder grade ever becomes a problem.
    guidance: 6,
    lens: '35mm environmental lens, full scene visible, deep focus',
    // Not another, more emphatic way of saying "full length". That was tried at
    // two resolutions, two guidance values and with the LoRA removed entirely,
    // and flux-dev returned the same thigh crop every time — it does not treat
    // subject-size language as a constraint.
    //
    // This says what is at the BOTTOM of the frame instead. A model cannot render
    // sneakers on floor tiles without reserving the space they stand on, so the
    // shoes and the floor do the work that "feet visible" would not, and the
    // camera is placed rather than described.
    framing: 'photographed from the far end of the balcony, camera set back and low, '
      + 'her white leather sneakers standing on the terracotta floor tiles, '
      + 'the tiled balcony floor fills the lower third of the frame, '
      + 'the whole length of her from hair to shoes inside the frame',
    light: 'late afternoon sun behind her, rim light on hair and shoulders' },
  // Vertical, because a reel is vertical. 704 × 1248 = 0.879 MP, under the
  // megapixel cliff that would double the price of this cell for nothing.
  { key: 'reel', label: 'Reel 9:16', w: 704, h: 1248,
    distant: true,
    lens: '50mm lens, natural perspective',
    framing: 'vertical composition, three quarter length, headroom above',
    light: 'flat daylight, high windows' },
  { key: 'cover', label: 'Cover', w: 880, h: 1104,
    lens: '85mm f/1.4 portrait lens, shallow depth of field',
    framing: 'head and chest only, three quarter angle, looking just past the camera, cropped above the waist',
    light: 'soft key from camera left, warm bounce from below' },
  // The one cell with no face in it, which is why it needs its own scene as
  // well as its own framing: the shared SCENE begins "standing on a balcony",
  // and a standing figure and a hands-only macro cannot both be the subject.
  { key: 'detail', label: 'Detail', w: 880, h: 1104,
    face: false,
    lens: '85mm macro lens, very shallow depth of field, focus on the knuckles',
    framing: 'extreme close up photograph of two hands resting on a wooden table, '
      + 'hands and forearms fill the frame, cropped mid-forearm, shot from above, '
      + 'no face, no head, no shoulders, no torso, person not visible',
    scene: 'a weathered wooden table on a small Mumbai apartment balcony, '
      + 'a potted tulsi and a glass of chai just out of focus behind',
    light: 'soft window light, warm' },
];

/**
 * Assemble one shot — FRAMING FIRST.
 *
 * The first version put lens, light and framing at the end, after a dozen other
 * clauses. Every one of the six setups came back as the same three-quarter body
 * shot: "close up, head and shoulders" and "close detail of her wrist, no face
 * in frame" produced identical compositions.
 *
 * Prompt order is load-bearing in Flux — this file said so in a comment three
 * screens up — and the one clause that VARIES between cells was sitting in the
 * position with the least influence, behind an identity block, a wardrobe list,
 * a scene and ten look fragments all describing a whole person on a balcony.
 *
 * So the shot leads now: framing, then lens, then light, then who she is. The
 * identity block still governs the face because the LoRA does most of that work
 * regardless of position; what changes is that the composition is asked for
 * before the model has already decided on one.
 *
 * The detail shot drops the wardrobe-and-scene sentence entirely — describing a
 * whole outfit is an instruction to show a whole person, which is precisely what
 * a wrist close-up must not do.
 */
function promptFor(setup) {
  // Framing first, and it is the only clause in the prompt that says what the
  // frame contains — everything after it describes how what is in the frame
  // looks. The face lines are appended only when there is a face to describe.
  const face = setup.face !== false;
  // `distant` is not a synonym for `face: false` — she is in the frame and
  // recognisably herself, just too far away for a pore to exist.
  const micro = face && setup.distant !== true;
  return [
    LORA_PATH && !BASE ? TRIGGER : null,
    setup.framing,
    setup.lens,
    setup.light,
    face ? (setup.distant ? IDENTITY_DISTANT : IDENTITY) : null,
    face ? (setup.distant ? WARDROBE_FULL : WARDROBE) : null,
    face ? null : 'a young woman\u2019s hands, warm medium-brown skin, short unpainted nails, '
      + 'black digital running watch on the left wrist, one thin gold chain at the wrist',
    setup.scene || SCENE,
    ...GRADE,
    ...(face ? FACE : []),
    ...(micro ? SKIN_MICRO : []),
  ].filter(Boolean).join(', ');
}

/**
 * The sign-in clip — Aanya running, at first light.
 *
 * The landing page shows the fashion half of her; this shows the fitness half,
 * which is the other thing the persona is for. It is `sea_promenade`, one of her
 * five canonical locations, rather than a sixth invented for this page: a
 * persona seen in five recurring places reads as a person, and a location that
 * exists only on the sign-in page is a location the LoRA has never seen.
 *
 * Framing here uses the finding from the contact sheet — the ground and the
 * shoes are named, so the frame reserves room for them. "Full length" on its own
 * does not work; see claude/framing-control-in-flux.md.
 */
const AUTH_SCENE = 'running on the Carter Road sea promenade in Mumbai at first light, '
  + 'low concrete sea wall, palm trees, the sea flat and pale behind her, '
  + 'a few joggers far out of focus';
const AUTH_WARDROBE = 'fitted charcoal running leggings, olive longline sports top, '
  + 'black digital running watch, dark running shoes, hair tied back';
const AUTH_SETUP = {
  key: 'auth',
  lens: '50mm lens, natural perspective, slight motion in the frame',
  framing: 'photographed from across the promenade, camera set back and low, '
    + 'her running shoes striking the paving, the promenade surface fills the lower '
    + 'third of the frame, the whole length of her from head to shoes inside the frame, '
    + 'caught mid stride',
  light: 'low first-light sun from camera left, long soft shadows, haze off the sea',
  guidance: 6,
};
const authStillPrompt = [
  LORA_PATH && !BASE ? TRIGGER : null,
  AUTH_SETUP.framing,
  AUTH_SETUP.lens,
  AUTH_SETUP.light,
  IDENTITY_DISTANT,
  AUTH_WARDROBE,
  AUTH_SCENE,
  ...GRADE,
  ...FACE,
].filter(Boolean).join(', ');

// What CHANGES — the same rule as the hero clip. Naming the run rather than
// re-describing her is what keeps the still's face through the video.
const authMotionPrompt = 'she runs at a steady easy pace, arms swinging, '
  + 'ponytail bouncing with each stride, the palms and sea wall drift slowly past behind her, '
  + 'hazy morning light, camera tracks alongside at her pace, no cuts, no zoom';

const HERO_SETUP = SETUPS[1];   // medium · 50mm — the one the video is made from
const stillPrompt = [LORA_PATH ? TRIGGER : null, IDENTITY, WARDROBE, SCENE, ...LOOK]
  .filter(Boolean).join(', ');

/**
 * The motion prompt describes what CHANGES, not what is there.
 *
 * Image-to-video models re-describe the frame if you hand them the still's
 * prompt, and re-describing a face is how it stops being the same face. Naming
 * only the movement is what keeps the identity the still already established.
 */
/**
 * A performance, not an idle.
 *
 * Breathing and blinking is what you ask for when you are afraid of the model.
 * It is safe, and it is also five seconds of a photograph pretending to be a
 * video — which on a page selling video generation is an argument against the
 * product.
 *
 * Two things this has to survive:
 *
 * IDENTITY. Wide mouth movement is where image-to-video faces come apart, and
 * teeth are the specific tell — models invent a different set every few frames.
 * So the laugh is named as closed-mouth and warm rather than open and loud, and
 * the prompt still describes only what MOVES: re-describing her face is how it
 * stops being her face.
 *
 * THE LOOP. The plate plays this on `loop`, so frame 120 cuts straight back to
 * frame 0. A clip that ends mid-laugh jump-cuts to a neutral face every five
 * seconds, and the eye reads that as a glitch even when it cannot say why. Hence
 * a closed arc — she starts settled, talks, laughs, settles again — so the two
 * ends meet somewhere near each other.
 */
const motionPrompt = 'she is talking to camera, relaxed and mid-conversation, '
  + 'natural lip movement and small jaw motion as she speaks, '
  + 'she breaks into a warm closed-mouth laugh, eyes creasing, chin dipping slightly, '
  + 'then settles back to speaking as she started, '
  + 'small natural head movement, she blinks, hair shifts in the breeze, '
  + 'camera locked off, no zoom, no cuts, no other people';

// ── fal ───────────────────────────────────────────────────────────────────────

const KEY = process.env.FAL_KEY;

function headers() {
  return { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit to the queue and wait.
 *
 * Follows the `status_url` and `response_url` fal hands back rather than
 * building them from the model name — those differ per model family, and a
 * constructed URL works right up until the day it silently does not.
 */
async function run(model, input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(input),
  });
  const queued = await submit.json().catch(() => ({}));

  if (!submit.ok) {
    // On fal these two mean different things and the difference is the fix:
    // 401 is a bad key, 403 is a valid key without scope for this model — or,
    // most often, no credits.
    const hint = submit.status === 401 ? 'FAL_KEY is not valid.'
      : submit.status === 403 ? 'Key is valid but rejected — usually zero credits, or no access to this model.'
      : '';
    throw new Error(`${model} → HTTP ${submit.status}. ${hint} ${JSON.stringify(queued).slice(0, 300)}`);
  }

  const statusUrl = queued.status_url;
  const responseUrl = queued.response_url;
  if (!statusUrl) throw new Error(`No status_url in queue reply: ${JSON.stringify(queued).slice(0, 300)}`);

  const startedAt = Date.now();
  for (;;) {
    await sleep(2500);
    const s = await fetch(statusUrl, { headers: headers() });
    const state = await s.json().catch(() => ({}));

    if (state.status === 'COMPLETED') break;
    if (state.status === 'FAILED' || state.error) {
      throw new Error(`${model} failed: ${JSON.stringify(state.error || state).slice(0, 400)}`);
    }
    if (Date.now() - startedAt > 10 * 60 * 1000) throw new Error(`${model} timed out after 10 minutes`);
    process.stdout.write('.');
  }

  const r = await fetch(responseUrl, { headers: headers() });
  const out = await r.json();
  if (!r.ok) throw new Error(`${model} result HTTP ${r.status}: ${JSON.stringify(out).slice(0, 300)}`);

  // A content-policy rejection arrives on a 200, beside an otherwise normal
  // payload. Trusting the status code here hands you a blank frame and no reason.
  if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts.some(Boolean)) {
    throw new Error(`${model} refused the prompt on content policy. Nothing was produced (you were still billed).`);
  }

  console.log(` done (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ── Frames ────────────────────────────────────────────────────────────────────

/**
 * Cut stills out of the clip — the contact sheet WITHOUT a LoRA.
 *
 * Frames from one take are the same person by construction, which is a claim
 * this page can make with no trained model. It proves continuity rather than
 * range, and the page's copy says so: "one take, six frames" rather than "six
 * setups". With `--lora` the sheet is generated properly instead and this is
 * skipped.
 */
function extractFrames(videoPath, count) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('  ! ffmpeg not found — skipping the contact sheet.');
    console.log('    The page falls back to its drawn frames, which is fine. `brew install ffmpeg` to fill them in.');
    return [];
  }

  const made = [];
  for (let i = 0; i < count; i += 1) {
    // Spread across the clip but never grab frame zero or the last frame: the
    // first is identical to the poster and the last is often a compression mess.
    const t = ((i + 0.7) / count) * SECONDS;
    const out = path.join(OUT_DIR, `frame-${i + 1}.jpg`);
    try {
      execFileSync('ffmpeg', ['-y', '-ss', t.toFixed(2), '-i', videoPath,
        '-frames:v', '1', '-q:v', '3', '-vf', 'scale=480:-2', out], { stdio: 'ignore' });
      made.push({ file: `frame-${i + 1}.jpg`, t: t.toFixed(2) });
    } catch (e) {
      console.log(`  ! could not cut frame at ${t.toFixed(2)}s`);
    }
  }
  return made;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Recover the LoRA's URL from the training job, without uploading anything.
 *
 * A Flux LoRA is ~130 MB, and fal's simple upload stops around 94 MB — above
 * that it wants a multipart protocol this client does not implement. But the
 * upload is unnecessary: **fal produced this file**, so fal is already hosting
 * it. The training job recorded the `request_id`, and re-reading a finished
 * queue result is free and returns `diffusers_lora_file.url` again.
 *
 * That URL is fal's own, so there is no question of whether fal can fetch it.
 * The one risk is expiry — fal's result URLs do not live forever — and that
 * fails immediately and cheaply here rather than halfway through a paid run.
 */
async function loraUrlFromJob(jobId) {
  const ROOT = path.join(__dirname, '..');
  const pool = require(path.join(ROOT, 'src/config/db'));
  try {
    const { rows } = await pool.query(
      'SELECT id, stage, status, result FROM render_jobs WHERE id = $1', [jobId]
    );
    const job = rows[0];
    if (!job) throw new Error(`No job #${jobId}.`);
    if (job.stage !== 'lora_train') throw new Error(`Job #${jobId} is stage '${job.stage}', not lora_train.`);

    const requestId = job.result?.request_id;
    const model = job.result?.model || LORA_TRAINER;
    if (!requestId) {
      throw new Error(`Job #${jobId} recorded no fal request_id, so its result cannot be re-read.\n`
        + `    result: ${JSON.stringify(job.result).slice(0, 200)}`);
    }

    process.stdout.write(`  Re-reading fal result for job #${jobId}… `);
    const res = await fetch(`${API}/${model}/requests/${requestId}`, { headers: headers() });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`fal returned HTTP ${res.status} for that request.\n`
        + `    ${JSON.stringify(out).slice(0, 200)}\n`
        + '    If the result has expired, the LoRA has to be served from somewhere fal\n'
        + '    can reach — an S3-backed STUDIO_PUBLIC_BASE, or a tunnel to this machine.');
    }
    const url = out.diffusers_lora_file?.url;
    if (!url) throw new Error(`That result has no diffusers_lora_file: ${JSON.stringify(out).slice(0, 200)}`);
    console.log('done');
    return url;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * fal needs a URL it can GET. `train.js` records the LoRA as a STORAGE KEY —
 * `t9/aanya-kapoor/misc/lora/….safetensors` — which is a path inside our local
 * disk store, meaningless to anyone else. Even its public URL is
 * `http://127.0.0.1:3000/…`, which is a machine fal has never heard of.
 *
 * So a key or a local file has to be uploaded to fal's own storage first. That
 * is exactly what the worker does through `ensureFetchable`, and this reuses the
 * same `uploadToFalStorage` rather than reimplementing it — it already knows
 * that `storage_type=fal-cdn-v3` is required and that omitting it answers 403,
 * which reads as a bad key and is not.
 */
async function resolveLora(value) {
  if (!value || value === true) return null;
  if (/^https?:\/\//i.test(value)) return value;      // already fetchable

  const ROOT = path.join(__dirname, '..');
  const storageRoot = process.env.STUDIO_STORAGE_ROOT || path.join(ROOT, 'studio-storage');
  const candidates = [value, path.join(storageRoot, value), path.resolve(value)];
  const local = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

  if (!local) {
    throw new Error(`Cannot find the LoRA file.\n`
      + `    Looked for:\n      ${candidates.join('\n      ')}\n\n`
      + '    Pass the storage key as train.js printed it, a path to the .safetensors,\n'
      + '    or an https URL fal can fetch.');
  }

  const bytes = fs.readFileSync(local);
  process.stdout.write(`  Uploading LoRA to fal (${(bytes.length / 1024 / 1024).toFixed(1)} MB)… `);

  const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));
  const provider = new FalProvider({ apiKey: KEY });
  const url = await provider.uploadToFalStorage(bytes, {
    filename: path.basename(local),
    contentType: 'application/octet-stream',
  });
  console.log('done');
  return url;
}

async function main() {
  if (!KEY) {
    console.error('FAL_KEY is not set. It should be in the backend .env — this script reads it from there.');
    process.exit(1);
  }

  const mp = (STILL_W * STILL_H) / 1e6;
  const billedMp = Math.ceil(mp);          // fal rounds UP, always
  const stillCents = SHEET_ONLY || MOTION_ONLY ? 0 : billedMp * CENTS_PER_MP;
  const perSecond = MOTION_CENTS_PER_SECOND[RESOLUTION] ?? Math.max(...Object.values(MOTION_CENTS_PER_SECOND));
  const motionCents = SHEET_ONLY ? 0 : perSecond * SECONDS;
  const totalCents = stillCents + motionCents;

  // With a LoRA the sheet is six real setups rather than six frames of one take.
  // Each is billed as a whole megapixel — the reel cell is 704×1248 = 0.879 MP
  // and still bills as one, which is why none of them is any larger.
  const usingLora = Boolean(LORA_PATH || LORA_JOB);
  const shooting = ONLY ? SETUPS.filter((x) => ONLY.includes(x.key)) : SETUPS;
  // `--only detial` filters to nothing, and without this the run would print a
  // $0.00 estimate, generate no cells, rewrite the manifest and exit 0 — a
  // success message for work that did not happen.
  if (ONLY) {
    const unknown = ONLY.filter((k) => !SETUPS.some((x) => x.key === k));
    if (unknown.length) {
      console.error(`\n  ✗ --only names ${unknown.join(', ')}, which is not a setup.`);
      console.error(`    Known: ${SETUPS.map((x) => x.key).join(', ')}\n`);
      process.exit(1);
    }
  }
  // Per cell, not per count. Every setup happens to sit under 1 MP today, so
  // `length * CENTS_PER_MP` was right by luck — and --size is exactly the flag
  // that breaks the luck. 832×1216 is 1.012 MP, which fal rounds up to 2: four
  // percent more pixels, twice the bill, and a gate that said otherwise.
  const cellCents = (x) => {
    const w = SIZE ? SIZE.w : x.w, h = SIZE ? SIZE.h : x.h;
    return Math.ceil((w * h) / 1e6) * CENTS_PER_MP;
  };
  // --auth and --motion-only are both "do one thing and touch nothing else".
  // The sheet belongs to the landing page and costs $0.21 to redo, so neither of
  // them gets to redo it as a side effect.
  const focused = AUTH || MOTION_ONLY;
  const sheetCents = usingLora && !focused ? shooting.reduce((n, x) => n + cellCents(x), 0) : 0;
  const grandCents = totalCents + sheetCents;

  console.log(AUTH ? '\nSign-in clip\n' : '\nHero assets for the landing page\n');
  // Name the model that will ACTUALLY run. The call already picks flux-lora when
  // a LoRA is given; printing flux/dev here regardless would have someone approve
  // a spend against a plan that describes a different model.
  if (MOTION_ONLY) console.log(`  Still    reusing ${AUTH ? 'auth-poster.jpg' : 'poster.jpg'} on disk — not regenerated, not charged`);
  else if (!SHEET_ONLY) console.log(`  Still    ${STILL_W}×${STILL_H} (${mp.toFixed(3)} MP, billed as ${billedMp})   ${usingLora ? LORA_MODEL : STILL_MODEL}`);
  console.log(SHEET_ONLY
    ? '  Still    skipped (--sheet-only)\n  Motion   skipped (--sheet-only)'
    : `  Motion   ${SECONDS}s at ${RESOLUTION}                       ${MOTION_MODEL}`);
  console.log(usingLora
    ? (focused
        ? `  Sheet    skipped (${AUTH ? '--auth' : '--motion-only'}) — the contact sheet belongs to the landing page`
        : `  Sheet    ${shooting.length} generated setups (${shooting.map((s) => s.key).join(', ')})`)
    : `  Sheet    ${FRAMES} frames cut from the clip with ffmpeg`);
  // The gate is where you decide to spend, so it has to describe the run that
  // will actually happen — saying "from training job #1" on a --base run means
  // the one number you check before paying is the wrong one.
  const loraLine = BASE
    ? `not used (--base) — base ${STILL_MODEL}, writing setup-<key>-base.jpg`
    : `${LORA_JOB ? `from training job #${LORA_JOB} (fal's own URL — no upload)` : LORA_PATH || 'none — the sheet will be frames from one take, see the note at the top'}`
      + `${LORA_SCALE !== 1 ? `  ·  scale ${LORA_SCALE}` : ''}`;
  console.log(`  LoRA     ${loraLine}`);
  console.log(`\n  Cost     ~$${(grandCents / 100).toFixed(2)}  (still $${(stillCents / 100).toFixed(2)}`
    + ` + motion $${(motionCents / 100).toFixed(2)}`
    + (sheetCents ? ` + sheet $${(sheetCents / 100).toFixed(2)}` : '') + ')\n');

  if (!CONFIRMED) {
    console.log('  Nothing has been spent. Re-run with --yes to generate.\n');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Done after the cost gate: uploading is free, but it is still work nobody
  // asked for if they were only pricing the run.
  if (LORA_JOB) {
    try {
      LORA_PATH = await loraUrlFromJob(Number(LORA_JOB));
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  } else if (LORA_PATH) {
    try {
      LORA_PATH = await resolveLora(LORA_PATH);
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  }

  // 1 ── the still (skipped when only the sheet is being redone)
  let still = null;
  let image = null;
  let videoBytes = 0;
  // Declared out here because the frame extractor below reads it from outside
  // the `!SHEET_ONLY` block. It was a `const` inside that block, which is a
  // ReferenceError the moment anyone runs without a LoRA — the one path that
  // reaches the extractor at all.
  let videoPath = null;

  if (!SHEET_ONLY) {
  const posterFile = AUTH ? 'auth-poster.jpg' : 'poster.jpg';
  const clipFile   = AUTH ? 'auth.mp4' : 'hero.mp4';
  let stillUrl = null;

  if (MOTION_ONLY) {
    // The picture already exists and is the one the page is showing. Upload it
    // rather than make a new one, so the only thing that changes is the motion.
    const posterPath = path.join(OUT_DIR, posterFile);
    if (!fs.existsSync(posterPath)) {
      console.error(`\n  ✗ --motion-only needs ${posterFile} to already exist in`);
      console.error(`    frontend/public/hero/ — there is no still to animate.`);
      console.error(`    Run without --motion-only to make one.\n`);
      process.exit(1);
    }
    const bytes = fs.readFileSync(posterPath);
    process.stdout.write(`  Uploading ${posterFile} (${(bytes.length / 1024).toFixed(0)} KB)… `);
    const { FalProvider } = require(path.join(__dirname, '..', 'worker/providers/fal'));
    stillUrl = await new FalProvider({ apiKey: KEY })
      .uploadToFalStorage(bytes, { filename: posterFile, contentType: 'image/jpeg' });
    console.log('done');
  } else {
  const stillInput = {
    prompt: AUTH ? authStillPrompt : stillPrompt,
    image_size: { width: STILL_W, height: STILL_H },
    num_images: 1,
    num_inference_steps: 32,
    guidance_scale: AUTH ? AUTH_SETUP.guidance : 3.5,
    enable_safety_checker: true,
    output_format: 'jpeg',
  };
  if (LORA_PATH && !BASE) stillInput.loras = [{ path: LORA_PATH, scale: LORA_SCALE }];

  still = await run(usingLora ? LORA_MODEL : STILL_MODEL, stillInput, 'Still');
  image = still.images?.[0];
  if (!image?.url) throw new Error(`No image in reply: ${JSON.stringify(still).slice(0, 300)}`);

  const posterBytes = await download(image.url, path.join(OUT_DIR, posterFile));
  console.log(`    ${posterFile.padEnd(16)}${(posterBytes / 1024).toFixed(0)} KB  seed ${still.seed ?? '?'}`);
  stillUrl = image.url;
  }

  // 2 ── the clip, generated FROM that still so the face is the same face
  const motion = await run(MOTION_MODEL, {
    image_url: stillUrl,           // fal's own CDN URL — already fetchable, no re-upload
    prompt: MOTION_PROMPT || (AUTH ? authMotionPrompt : motionPrompt),
    resolution: RESOLUTION,
    duration: String(SECONDS),
    // The hero is a locked-off portrait; the sign-in clip is a tracking shot
    // alongside a runner. Locking the camera on that one would fight the prompt.
    camera_fixed: !AUTH,
  }, 'Motion');

  const videoUrl = motion.video?.url || motion.url;
  if (!videoUrl) throw new Error(`No video in reply: ${JSON.stringify(motion).slice(0, 300)}`);

  videoPath = path.join(OUT_DIR, clipFile);
  videoBytes = await download(videoUrl, videoPath);
  console.log(`    ${clipFile.padEnd(16)}${(videoBytes / 1024 / 1024).toFixed(1)} MB`);
  if (videoBytes > 6 * 1024 * 1024) {
    console.log('    ! Over 6 MB. That is a slow hero on an Indian mobile connection —');
    console.log('      re-run with --resolution 480p, or compress it before shipping.');
  }

  }

  // 3 ── the contact sheet
  //
  // Two different things depending on whether her model exists, and the page's
  // copy follows whichever it gets. With a LoRA these are six real setups and
  // the sheet can say "six setups from a single brief"; without, they are frames
  // from one take and it says "one take, six frames" instead. The claim is
  // derived from what is actually on the page, never asserted over it.
  let frames = [];
  let setups = [];

  if (LORA_PATH && !AUTH && !MOTION_ONLY) {
    console.log('  Contact sheet');
    const chosen = ONLY ? SETUPS.filter((x) => ONLY.includes(x.key)) : SETUPS;
    for (const setup of chosen) {
      const cell = await run(BASE ? STILL_MODEL : LORA_MODEL, {
        prompt: promptFor(setup),
        image_size: { width: SIZE ? SIZE.w : setup.w, height: SIZE ? SIZE.h : setup.h },
        num_images: 1,
        num_inference_steps: 32,
        guidance_scale: GUIDANCE_SET ? GUIDANCE : (setup.guidance ?? GUIDANCE),
        enable_safety_checker: true,
        output_format: 'jpeg',
        ...(BASE ? {} : { loras: [{ path: LORA_PATH, scale: LORA_SCALE }] }),
      }, `  ${setup.label.padEnd(16)}`);

      const url = cell.images?.[0]?.url;
      if (!url) { console.log(`    ! ${setup.key} produced nothing — skipping`); continue; }
      // Any run with an experimental knob on it writes to its own name. The
      // point of a test is to compare it against the cell you already have, and
      // that is impossible if it has just overwritten it.
      const tag = [BASE ? 'base' : null,
                   SIZE ? `${SIZE.w}x${SIZE.h}` : null,
                   GUIDANCE !== 3.5 ? `g${GUIDANCE}` : null].filter(Boolean).join('-');
      const file = tag ? `setup-${setup.key}-${tag}.jpg` : `setup-${setup.key}.jpg`;
      await download(url, path.join(OUT_DIR, file));
      // A --base frame is a measurement, not an asset. It does not go in the
      // manifest and does not replace the cell the page is already showing.
      if (!tag) setups.push({ src: `/hero/${file}`, label: setup.label, seed: cell.seed ?? null });
    }
    console.log(`    ${setups.length} of ${chosen.length} setups generated`);
  } else {
    frames = videoPath ? extractFrames(videoPath, FRAMES) : [];
    if (frames.length) console.log(`    ${frames.length} frames cut`);
  }

  // 4 ── the manifest. The page reads this and adapts; without it, the drawn
  //      plate stays exactly as it is, so the site is never broken mid-way.
  // Merged, not replaced. A --sheet-only run must not null the poster, seed and
  // dimensions of a hero clip it did not touch — the page reads those, and
  // rewriting the file from scratch would quietly delete a $0.31 asset's record
  // while leaving the file on disk.
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8')); } catch { /* first run */ }

  const manifest = {
    ...previous,
    generated_at: new Date().toISOString(),
    model: usingLora ? LORA_MODEL : STILL_MODEL,
    motion_model: MOTION_MODEL,
    // An --auth run writes into its own block. Letting it set `poster` and
    // `video` would silently replace the landing page's clip with the sign-in
    // one, and the symptom — both pages showing the same video — is the exact
    // thing this flag exists to prevent.
    ...(SHEET_ONLY || !AUTH ? {} : {
      auth: {
        ...(previous.auth || {}),
        poster: '/hero/auth-poster.jpg',
        video: '/hero/auth.mp4',
        seconds: SECONDS,
        resolution: RESOLUTION,
        // A string, because fal's seeds are larger than Number.MAX_SAFE_INTEGER
        // and JSON.parse silently rounds them — the number already in this file
        // does not name the image it claims to.
        ...(still?.seed != null ? { seed: String(still.seed) } : {}),
      },
    }),
    ...(SHEET_ONLY || AUTH ? {} : {
      // `?? previous` and not `?? null`: --motion-only has no still of its own,
      // and writing null here would erase the record of the poster it just went
      // to some trouble to preserve.
      ...(still?.seed != null ? { seed: String(still.seed) } : {}),
      width: image?.width ?? previous.width ?? STILL_W,
      height: image?.height ?? previous.height ?? STILL_H,
      poster: '/hero/poster.jpg',
      video: '/hero/hero.mp4',
      seconds: SECONDS,
      resolution: RESOLUTION,
      frames: frames.map((f) => ({ src: `/hero/${f.file}`, t: f.t })),
    }),
    // Merged by src for the same reason the manifest itself is merged: a
    // --only run must not delete the record of five good cells it never touched.
    setups: (() => {
      const byKey = new Map((previous.setups || []).map((x) => [x.src, x]));
      for (const x of setups) byKey.set(x.src, x);
      const order = SETUPS.map((x) => `/hero/setup-${x.key}.jpg`);
      return [...byKey.values()].sort((a, b) => order.indexOf(a.src) - order.indexOf(b.src));
    })(),
    lora: LORA_PATH || previous.lora || null,
    // Still null, and still deliberately. The app's QC measures a frame against
    // baselines calibrated per (avatar, LoRA, expression, framing) — so a real
    // score exists only after calibration has run, not merely after training.
    // Fill this from the calibration output when that is done; until then the
    // slate shows generation metadata, which is true.
    qc: null,
    cost_usd: Number((grandCents / 100).toFixed(2)),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n  Written to frontend/public/hero/`);
  console.log(`  Spent ~$${(grandCents / 100).toFixed(2)}. Reload the landing page.\n`);
  if (LORA_PATH && setups.length) {
    console.log('  Look at the six cells before you ship them. If one is subtly a');
    console.log('  different person, that is the LoRA telling you the seed set was thin');
    console.log('  in that framing — which is worth knowing now rather than at post 40.\n');
  }
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
});
