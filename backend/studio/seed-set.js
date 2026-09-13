#!/usr/bin/env node
'use strict';

/**
 * Generate the candidate pool a seed set is culled from.
 *
 *   node studio/seed-set.js --avatar 1 --count 300
 *
 * This is the one generation step that happens OUTSIDE the job queue, and it has
 * to, for a reason that is easy to miss: the orchestrator refuses a shoot when an
 * avatar has no active LoRA — but a LoRA is trained *from* these images. The
 * queue's own safety rule makes it the wrong tool for the step that comes first.
 *
 * So this talks to a generator directly, builds a no-LoRA request, and writes
 * files to disk.
 *
 *   --provider local   ComfyUI on this machine. Free, unlimited, needs the
 *                      ~18 GB install. Nothing generated here is ever published,
 *                      which is what keeps the non-commercial licence intact.
 *   --provider fal     Hosted. ~$0.035 a frame, works this minute.
 *
 * Both produce the same prompts from the same identity block, so the choice is
 * purely time against money and can be changed between runs — a half-day install
 * should not be the thing standing between a persona and its first candidate.
 *
 * What comes out is NOT a seed set. It is 300 candidates you cull to ~20 by hand.
 * That culling is the highest-leverage twenty minutes in the whole build: the
 * mean embedding of what you keep becomes the reference every future image is
 * judged against, permanently.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const { ComfyClient } = require(path.join(__dirname, '..', 'worker', 'comfyClient'));
const { indexVocabulary } = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'comfyui', 'buildWorkflow'));

/**
 * The coverage grid.
 *
 * A LoRA only holds in the conditions its training set saw. A pool that is 300
 * front-on medium shots in soft light produces a model that falls apart the
 * first time you ask for a profile at golden hour — and it fails *quietly*, as
 * drift rather than an error. So variation here is systematic rather than
 * random: every axis is walked, and the count is spread across the product.
 */
const GRID = {
  /**
   * No `wide` — deliberately, and it is not an oversight.
   *
   * In a wide shot the face is a small fraction of the frame. At this training
   * resolution that is roughly fifty pixels across, which is below what a LoRA
   * can learn identity from. Such a frame does not teach the model who she is;
   * it teaches the model to render a blurry face at that scale, which is the
   * opposite of useful. The export gate has always required close, medium and
   * full and ignored wide — this makes the generator agree with it instead of
   * spending a quarter of every run on frames nothing asks for.
   *
   * Wide shots are still available when SHOOTING. The model renders her at any
   * distance using identity learned from closer frames; it just should not be
   * asked to learn identity from a distance.
   */
  framing:         ['close', 'medium', 'full'],
  angle:           ['front', 'three-quarter', 'profile'],
  light_direction: ['camera_left', 'camera_right', 'window', 'flat'],
  light_quality:   ['soft', 'hard'],
  expression:      ['relaxed neutral expression', 'a soft closed-mouth smile', 'a level, confident look'],
};

/** Wardrobe and location come from the bible; these are Aanya's defaults. */
const DEFAULT_WARDROBE = [
  'cropped charcoal tee with high-waisted wide-leg sand trousers, thin gold chain',
  'fitted olive technical leggings with a longline black sports top, black digital watch',
  'oversized off-white overshirt worn open over a black fitted top and wide-leg trousers',
];

const DEFAULT_LOCATIONS = [
  'small apartment balcony with potted plants and dark green window frames, low city skyline behind',
  'plain neighbourhood gym, rubber flooring, black racks, mirrored wall, high windows',
  'small cafe with wooden tables, exposed brick and a large street-facing window',
  'seafront promenade at first light, low concrete wall and palms',
  'work desk with twin monitors, a pinboard of colour swatches and an anglepoise lamp',
];

const ANGLE_TEXT = {
  front: 'facing the camera directly',
  'three-quarter': 'turned three-quarters toward the camera',
  profile: 'in profile, looking away from the camera',
};

function die(m) { console.error(`\n  ${m}\n`); process.exit(1); }

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/**
 * Build a no-LoRA graph.
 *
 * `buildWorkflow` deliberately refuses to assemble without a LoRA — a faceless
 * persona is not something the product should ever render. That guard is correct
 * and stays; this step is the documented exception, so it constructs its own
 * graph from the same template rather than weakening the guard for everyone.
 */
function buildBaseWorkflow({ templatePath, prompt, seed, width, height, steps, guidance, filenamePrefix }) {
  const wf = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  delete wf._comment;

  // Cut the LoRA node out of the chain: whatever consumed node 40 now consumes
  // the loader directly.
  const loraInput = wf['40'].inputs.model;
  delete wf['40'];
  for (const node of Object.values(wf)) {
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value) && value[0] === '40') node.inputs[name] = loraInput;
    }
  }

  wf['6'].inputs.text = prompt;
  wf['25'].inputs.noise_seed = seed;
  wf['17'].inputs.steps = steps;
  wf['26'].inputs.guidance = guidance;
  wf['5'].inputs.width = width;
  wf['5'].inputs.height = height;
  wf['30'].inputs.width = width;
  wf['30'].inputs.height = height;
  wf['9'].inputs.filename_prefix = filenamePrefix;
  return wf;
}

function frag(vocab, facet, key) {
  return (vocab[facet] && vocab[facet][key]) || '';
}

const FAL_QUEUE = process.env.FAL_QUEUE_URL || 'https://queue.fal.run';
/** Base Flux, no LoRA — there is no LoRA yet. That is the whole point of this step. */
const FAL_BASE_MODEL = process.env.FAL_BASE_MODEL || 'fal-ai/flux/dev';

/**
 * One candidate through fal.
 *
 * Deliberately not routed through FalProvider: `runStill` refuses a job with no
 * LoRA, and that guard is correct for every other caller. This step is the
 * documented exception, so it makes its own call rather than weakening the rule.
 */
async function falGenerate({ apiKey, prompt, seed, width, height, steps }) {
  const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };

  const submit = await fetch(`${FAL_QUEUE}/${FAL_BASE_MODEL}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      image_size: { width, height },
      num_inference_steps: steps,
      guidance_scale: 3.5,
      seed,
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
    }),
  });
  if (!submit.ok) throw new Error(`fal submit → ${submit.status}: ${(await submit.text()).slice(0, 200)}`);
  const handle = await submit.json();

  const statusUrl = handle.status_url || `${FAL_QUEUE}/${FAL_BASE_MODEL}/requests/${handle.request_id}/status`;
  const resultUrl = handle.response_url || `${FAL_QUEUE}/${FAL_BASE_MODEL}/requests/${handle.request_id}`;

  const deadline = Date.now() + 300_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('fal timed out');
    const st = await (await fetch(statusUrl, { headers })).json();
    if (st.status === 'COMPLETED') break;
    if (st.status === 'ERROR' || st.status === 'FAILED') throw new Error(`fal failed: ${JSON.stringify(st).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const out = await (await fetch(resultUrl, { headers })).json();
  const image = (out.images || [])[0];
  if (!image) throw new Error('fal returned no image');
  // A content-policy rejection arrives on a 200; treating it as success would
  // put a blocked frame in the candidate pool.
  if ((out.has_nsfw_concepts || [])[0]) throw new Error('blocked by the content filter');

  const bytes = await (await fetch(image.url)).arrayBuffer();
  return Buffer.from(bytes);
}

(async () => {
  const avatarId = Number(arg('avatar'));
  const count    = Number(arg('count', 300));
  const outDir   = arg('out');
  const comfyUrl = arg('comfy', process.env.COMFY_URL || 'http://127.0.0.1:8188');
  const steps    = Number(arg('steps', 22));
  const provider = arg('provider', 'local');
  const yes      = process.argv.includes('--yes');
  const fresh    = process.argv.includes('--fresh');

  if (!['local', 'fal'].includes(provider)) die(`--provider must be local or fal, got "${provider}"`);

  // 880x1104 is 0.97 MP. fal bills per megapixel ROUNDED UP, so this bills as 1
  // and 896x1152 (1.03 MP) would bill as 2 — double, for 6% more pixels. Same
  // trap the free tier fell into in drop 1.
  const WIDTH = 880, HEIGHT = 1104;

  if (!avatarId) die('Usage: node studio/seed-set.js --avatar <id> [--count 300] [--out <dir>]');

  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.identity_block,
            lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
            lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version
       FROM avatars a LEFT JOIN look_profiles lp ON lp.avatar_id = a.id
      WHERE a.id = $1`,
    [avatarId]
  );
  const avatar = rows[0];
  if (!avatar) die(`No avatar #${avatarId}. Load a persona first: node studio/load-persona.js …`);
  if (!avatar.base_look) die('This avatar has no look profile — load the persona bible first.');

  const { rows: vocabRows } = await pool.query(
    'SELECT facet, option_key, fragment FROM prompt_vocabulary WHERE version = $1 AND active',
    [avatar.vocabulary_version || 1]
  );
  const vocab = indexVocabulary(vocabRows);

  const dir = path.resolve(outDir || path.join(__dirname, 'personas', avatar.slug, 'candidates'));
  fs.mkdirSync(dir, { recursive: true });

  let comfy = null;
  let falKey = null;
  const templatePath = path.join(
    __dirname, '..', 'src', 'services', 'studio', 'comfyui', 'flux-lora-portrait-mac.api.json'
  );

  if (provider === 'local') {
    comfy = new ComfyClient({ baseUrl: comfyUrl, clientId: 'studio-seed-set' });
    if (!(await comfy.isReady())) {
      const home = process.env.COMFY_DIR || `${process.env.HOME}/ai/ComfyUI`;
      const installed = fs.existsSync(path.join(home, 'start.sh'));

      // Two different problems wearing the same error. "Not installed" and
      // "installed but not running" need different next steps, and guessing
      // wrong sends someone to re-download 18 GB they already have.
      die(installed
        ? `ComfyUI is installed but not running at ${comfyUrl}.\n\n`
          + `  Start it:\n\n    ${home}/start.sh\n\n`
          + '  Wait for "To see the GUI go to: http://127.0.0.1:8188", then re-run this.'
        : `ComfyUI is not reachable at ${comfyUrl}.\n\n`
          + '  Install it — one script, ~18 GB, resumable if it drops:\n\n'
          + '    bash studio/install-comfyui.sh\n\n'
          + '  Run that in Terminal on macOS. Details: claude/comfyui-mac-install.md');
    }
  } else {
    falKey = process.env.FAL_KEY;
    if (!falKey) die('FAL_KEY is not set.');
  }

  /**
   * Walk the grid rather than sampling it, so coverage is guaranteed rather than
   * probable. 300 candidates over 288 cells is roughly one each.
   *
   * 🐛 THE NESTING ORDER IS LOAD-BEARING, and the obvious order is wrong.
   *
   * Nesting framing outermost — the natural way to write this — means the first
   * 24 candidates are all close/front, the first 72 are all close, and the pool
   * does not contain a single `full` framing until candidate 145. Since culling
   * happens WHILE the pool generates, and the export gate requires three angles,
   * three framings and both light qualities, that made the gate unsatisfiable
   * for the first four hours of a run. The gate was right; the generator was
   * handing it a pool that could not pass.
   *
   * So the three axes the gate checks are innermost. Their product is 24, which
   * means any 24 consecutive candidates span every angle, framing and light
   * quality — and a partial pool is representative rather than a corner of the
   * grid.
   */
  const cells = [];
  for (const expression of GRID.expression)
    for (const dir_ of GRID.light_direction)
      for (const framing of GRID.framing)
        for (const angle of GRID.angle)
          for (const quality of GRID.light_quality)
            cells.push({ framing, angle, dir_, quality, expression });

  /**
   * Top up, do not restart.
   *
   * A second run with `--count 100` used to walk the grid from cell zero again,
   * regenerating cells the pool is already thick with while leaving the empty
   * ones empty. That is the wrong default for a step people run more than once —
   * and they do, because the honest way to size a pool is to cull what you have
   * and generate more if it was not enough.
   *
   * So existing candidates are counted per cell and the thinnest cells are
   * filled first. `--count` then means "add this many, where they are actually
   * needed" rather than "start over".
   *
   * `--fresh` restores the old behaviour for the case where the identity block
   * changed and the existing pool is of a different person.
   */
  const existing = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.png$/i.test(f))
    : [];

  const cellKey = (c) => `${c.framing}|${c.angle}|${c.quality}`;
  const have = new Map();
  let maxIndex = 0;

  if (!fresh) {
    for (const f of existing) {
      const parts = f.replace(/\.png$/i, '').split('-');
      if (parts.length < 4) continue;
      parts.pop();                                  // seed
      const quality = parts.pop();
      const index = Number(parts.shift());
      const framing = parts.shift();
      const angle = parts.join('-');
      if (!GRID.light_quality.includes(quality) || !GRID.framing.includes(framing)) continue;
      if (!GRID.angle.includes(angle)) continue;
      const k = `${framing}|${angle}|${quality}`;
      have.set(k, (have.get(k) || 0) + 1);
      if (Number.isFinite(index)) maxIndex = Math.max(maxIndex, index);
    }
  }

  // Stable sort: thinnest cells first, original grid order within a tier. The
  // grid order already interleaves the axes, so an equal-count tier stays
  // representative rather than clustering.
  const work = cells
    .map((c, i) => ({ c, i, n: have.get(cellKey(c)) || 0 }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .map((x) => x.c);

  const estimate = provider === 'fal' ? count * 3.5 / 100 : 0;

  console.log(`\n  Candidate pool`);
  console.log(`  avatar    #${avatar.id} ${avatar.slug}`);
  console.log(`  provider  ${provider}${provider === 'local' ? ` (${comfyUrl})` : ` (${FAL_BASE_MODEL})`}`);
  console.log(`  out       ${dir}`);
  console.log(existing.length && !fresh
    ? `  count     ${count} more (${existing.length} already on disk — filling the thinnest cells first)`
    : `  count     ${count} across ${cells.length} coverage cells`);
  console.log(`  size      ${WIDTH}x${HEIGHT} — 0.97 MP, bills as 1`);
  console.log(provider === 'fal'
    ? `  cost      ~$${estimate.toFixed(2)}`
    : '  cost      nothing — local weights, nothing published');
  console.log('');

  // A typo'd --count on the paid path is a real bill. Confirm above a threshold
  // rather than discovering it on the invoice.
  if (provider === 'fal' && estimate > 2 && !yes) {
    die(`This will spend about $${estimate.toFixed(2)}.\n\n`
      + '  Add --yes to confirm, or lower --count. A 60-frame batch (~$2.10) is\n'
      + '  enough to check the identity block produces the face you want before\n'
      + '  committing to the full pool.');
  }

  const started = Date.now();
  let made = 0, failed = 0;

  for (let i = 0; i < count; i += 1) {
    const cell = work[i % work.length];
    const wardrobe = DEFAULT_WARDROBE[i % DEFAULT_WARDROBE.length];
    const location = DEFAULT_LOCATIONS[Math.floor(i / 3) % DEFAULT_LOCATIONS.length];
    const seed = Math.floor(Math.random() * 2 ** 31);

    // Same PROMPT_ORDER as buildWorkflow — identity immediately after the (here
    // absent) trigger, so a candidate reads the way a real render will.
    const prompt = [
      avatar.identity_block.replace(/\s+/g, ' ').trim(),
      ANGLE_TEXT[cell.angle],
      wardrobe,
      location,
      cell.expression,
      frag(vocab, 'base_look', avatar.base_look),
      frag(vocab, 'lens', avatar.lens),
      frag(vocab, 'light_quality', cell.quality),
      frag(vocab, 'light_direction', cell.dir_),
      frag(vocab, 'colour', avatar.colour),
      frag(vocab, 'grain', avatar.grain),
      frag(vocab, 'skin', avatar.skin),
      frag(vocab, 'asymmetry', avatar.natural_asymmetry ? 'on' : 'off'),
      frag(vocab, 'hair_detail', avatar.hair_detail ? 'on' : 'off'),
      frag(vocab, 'framing', cell.framing),
      frag(vocab, 'quality', 'base'),
    ].filter(Boolean).join(', ');

    const label = `${String(maxIndex + i + 1).padStart(4, '0')}-${cell.framing}-${cell.angle}-${cell.quality}`;

    try {
      if (provider === 'local') {
        const workflow = buildBaseWorkflow({
          templatePath, prompt, seed,
          width: WIDTH, height: HEIGHT, steps, guidance: 3.5,
          filenamePrefix: `seed/${avatar.slug}/${label}`,
        });
        const promptId = await comfy.submit(workflow);
        const images = await comfy.waitForResult(promptId, { timeoutMs: 600_000 });
        for (const image of images) {
          fs.writeFileSync(path.join(dir, `${label}-${seed}.png`), await comfy.fetchImage(image));
        }
      } else {
        const buf = await falGenerate({
          apiKey: falKey, prompt, seed, width: WIDTH, height: HEIGHT, steps,
        });
        fs.writeFileSync(path.join(dir, `${label}-${seed}.png`), buf);
      }
      made += 1;
    } catch (err) {
      failed += 1;
      console.error(`  [${i + 1}] failed: ${err.message}`);
      // Twenty consecutive failures is a broken setup, not bad luck. Stopping
      // beats grinding through 280 more of the same error — and on the paid path
      // it beats paying for them.
        if (failed > 20 && made === 0) {
        die(provider === 'local'
          ? 'Twenty failures and no successes — check the ComfyUI console.'
          : 'Twenty failures and no successes — stopping before this costs more.');
      }
    }

    if ((i + 1) % 10 === 0) {
      const rate = (Date.now() - started) / (i + 1) / 1000;
      const left = Math.round((count - i - 1) * rate / 60);
      // Report coverage, not just progress. "How many are done" does not answer
      // the question the operator actually has, which is "can I cull and export
      // yet".
      // Coverage of the WHOLE pool, not just this run — what matters is whether
      // the folder can pass the export gate, not whether this batch could.
      const seen = work.slice(0, i + 1).concat(
        [...have.keys()].map((k) => {
          const [framing, angle, quality] = k.split('|');
          return { framing, angle, quality };
        })
      );
      const spanned = [
        new Set(seen.map((c) => c.angle)).size === 3,
        ['close', 'medium', 'full'].every((f) => seen.some((c) => c.framing === f)),
        new Set(seen.map((c) => c.quality)).size === 2,
      ].every(Boolean);
      process.stdout.write(
        `  ${i + 1}/${count}  ~${rate.toFixed(1)}s each  ~${left} min left  ` +
        `${spanned ? 'coverage complete' : 'coverage building'}   \r`
      );
    }

    // Unload between batches. On 36 GB the alternative to unloading is swapping.
    if (comfy && (i + 1) % 50 === 0) await comfy.freeMemory();
  }

  console.log(`\n\n  ${made} candidates in ${dir}`);
  if (failed) console.log(`  ${failed} failed`);
  if (provider === 'fal') console.log(`  ~$${(made * 3.5 / 100).toFixed(2)} spent`);
  console.log(`\n  Now cull by hand to 12-40. Keep the ones that look like the SAME PERSON,`);
  console.log(`  not the ones that look best — a striking frame that is subtly a different`);
  console.log(`  face is worse than a dull one that is unmistakably her.\n`);
  console.log(`  Cover: front/three-quarter/profile · soft and hard light · 3+ locations`);
  console.log(`         neutral + two expressions · close/medium/full framing\n`);

  await pool.end();
})();
