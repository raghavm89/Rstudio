#!/usr/bin/env node
'use strict';

/**
 * Cull → train. The step that had no script.
 *
 * The runbook used to say `POST /api/studio/avatars/2/train`, which is not a
 * command you can run — it is an HTTP endpoint, it needs a bearer token nobody
 * told you how to get, and its body needs two things that do not exist yet:
 *
 *   seed_set_url     a fetchable zip of the culled images
 *   seed_embeddings  a face embedding per image, for the coherence check
 *
 * The cull screen writes the kept images to `personas/<slug>/seed/` and stops
 * there. Everything between that folder and a training job — zip it, embed it,
 * check it, submit it, watch it — is this file.
 *
 *     node studio/train.js --avatar 2            # check the set, price it, stop
 *     node studio/train.js --avatar 2 --yes      # actually train
 *
 * It talks to Postgres and the services directly rather than over HTTP, the way
 * `seed-set.js` does. There is no token to find, and it runs on the machine that
 * already has the database and the images.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const pool = require(path.join(ROOT, 'src/config/db'));
const LoraTraining = require(path.join(ROOT, 'src/services/studio/loraTraining'));
const { FaceEmbedder } = require(path.join(ROOT, 'worker/faceEmbed'));
const Seed = require(path.join(ROOT, 'src/services/studio/seedCandidates'));
const SeedExport = require(path.join(ROOT, 'src/services/studio/seedExport'));

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const AVATAR_ID = Number(flag('avatar', 0));
const CONFIRMED = args.includes('--yes');
const STEPS = Number(flag('steps', 1000));

/**
 * The job status vocabulary, as `render_jobs` actually uses it.
 *
 * Named here because I guessed 'succeeded' twice — once in the watch loop, where
 * it would have spun forever on a finished job, and once in --record, where it
 * refused a run that had worked. The schema comment on migration 028 is the
 * source: queued | claimed | running | done | failed | cancelled, plus 'blocked',
 * which `RenderJob` sets on the descendants of a permanent failure.
 */
const DONE = 'done';
const DEAD = ['failed', 'blocked', 'cancelled'];

const die = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };
const say = (msg) => console.log(msg);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Recovering a lost job id must be cheaper than re-running. Training is the
  // one step here that costs real money per attempt.
  if (args.includes('--jobs')) return listJobs();
  const WATCH = flag('watch', null);
  if (WATCH) return watchJob(Number(WATCH));
  const RECORD = flag('record', null);
  if (RECORD) return recordJob(Number(RECORD));

  if (!AVATAR_ID) die('Which avatar? e.g.  node studio/train.js --avatar 2');

  // 1 ── the avatar, and the seed folder the cull screen wrote
  const { rows } = await pool.query(
    `SELECT a.id, a.tenant_id, a.slug, a.name, a.lora_trigger,
            (SELECT COUNT(*)::int FROM avatar_loras l WHERE l.avatar_id = a.id) AS lora_count
       FROM avatars a WHERE a.id = $1`,
    [AVATAR_ID]
  );
  const avatar = rows[0];
  if (!avatar) die(`No avatar #${AVATAR_ID}.`);

  /**
   * The seed set comes from the DATABASE, not from a folder.
   *
   * This read `studio/personas/<slug>/seed/` — the folder the old export wrote
   * by copying files around on whichever machine happened to be running the
   * API. That folder does not exist for a customer: their frames were generated
   * by the queue and live in object storage, so the export now publishes a zip
   * instead and this had nothing left to read.
   *
   * Asking the database for the kept rows is also simply more correct. The
   * folder was a snapshot of a decision; `seed_candidates` IS the decision, and
   * the same gate (twelve minimum, forty cap, no coverage hole) refuses here
   * exactly as it does on the screen.
   */
  let kept, culledFrom;
  try {
    ({ kept, culledFrom } = await Seed.keptForExport(pool, avatar.tenant_id, avatar.id));
  } catch (err) {
    die(`${err.message}\n`
      + '    Cull on the face screen first. The same rules apply there, and fixing\n'
      + '    it there records the decision where the coverage rules can see it.');
  }

  // The embedder takes file paths, so the bytes are materialised into a temp
  // directory — never into the persona folder, which is somebody's working
  // directory and not a cache.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `seed-${avatar.slug}-`));
  const images = [];
  for (const c of kept) {
    const bytes = await SeedExport.frameBytes(c, {
      candidatesDir: path.join(__dirname, 'personas', avatar.slug, 'candidates'),
    });
    fs.writeFileSync(path.join(workDir, c.filename), bytes);
    images.push(c.filename);
  }

  say(`\nTrain ${avatar.name} (#${avatar.id})\n`);
  say(`  Seed set   ${images.length} kept of ${culledFrom}, from ${kept[0]?.storage_key ? 'object storage' : 'the persona directory'}`);
  say(`  Trigger    ${avatar.lora_trigger}`);
  say(`  Steps      ${STEPS}`);
  if (avatar.lora_count > 0) {
    // Not refused — retraining a bad seed set is a normal thing to do, and the
    // `avatars` entitlement is spent on version 1 only, so this does not cost an
    // avatar. Worth saying out loud so it is a decision rather than a surprise.
    say(`  Note       this avatar already has ${avatar.lora_count} LoRA version(s); this makes another`);
  }

  // 2 ── embed every image
  //
  // Done BEFORE anything is zipped or spent, because this is the check that can
  // reject the set. `checkSeedCoherence` names which image to drop, and dropping
  // it now costs nothing — the set's mean embedding becomes the reference every
  // future frame is judged against, permanently.
  say('\n  Embedding faces…');
  const embedder = new FaceEmbedder({});
  let embeddings;
  try {
    await embedder.start();
    embeddings = [];
    // Collected rather than thrown on the first one. If three of fifteen images
    // are unusable you want to know all three now, not to re-run this twice more
    // discovering them one at a time.
    const unusable = [];

    for (const [i, file] of images.entries()) {
      const out = await embedder.embed(path.join(workDir, file));

      // A frame with no face comes back ok:true with a null embedding — the
      // embedder measures, it does not judge. So the absence has to be caught
      // here, and it is a real case: a full-length shot where the face is small,
      // or a profile the detector misses.
      if (!Array.isArray(out.embedding)) {
        unusable.push(out.faces === 0
          ? `${file} — no face detected`
          : `${file} — no embedding returned (faces: ${out.faces ?? '?'})`);
      } else if (out.faces > 1) {
        // Two faces means the model would learn whichever the detector picked,
        // and the set's mean would drift toward a person who is not her.
        unusable.push(`${file} — ${out.faces} faces in frame`);
      } else {
        embeddings.push(out.embedding);
      }
      process.stdout.write(`\r  Embedding faces… ${i + 1}/${images.length}`);
    }
    say('');

    if (unusable.length) {
      die(`${unusable.length} of ${images.length} images cannot go in a seed set:\n      `
        + unusable.join('\n      ')
        + '\n\n    Unpick them on the cull screen and run this again — that is where'
        + '\n    the decision lives, and where the coverage rules can see it.');
    }
  } catch (err) {
    die(`Face embedder failed: ${err.message}\n`
      + '    It runs insightface through worker/faceEmbed.py — check that python3 has\n'
      + '    insightface installed, or set FACE_EMBED_PYTHON to one that does.');
  } finally {
    embedder.stop();
  }

  // 3 ── the coherence check, run here so a refusal costs nothing
  let coherence;
  try {
    coherence = LoraTraining.checkSeedCoherence(embeddings);
  } catch (err) {
    // It refuses a set under twelve images outright. The cull screen enforces
    // the same floor, so this only fires if the seed folder was assembled by
    // hand — worth saying plainly rather than as a stack trace.
    die(err.message);
  }
  if (!coherence.coherent) {
    const names = coherence.outliers.map((o) => images[o.index] ?? `#${o.index}`);
    die(`${coherence.outliers.length} of ${images.length} images are not confidently the same person.\n`
      + `    Lowest similarity to the set mean: ${coherence.minimum.toFixed(3)}\n`
      + `    Unpick these on the cull screen and run this again:\n      ${names.join('\n      ')}\n\n`
      + '    This is the check worth failing. A striking frame that is subtly a\n'
      + '    different face is worse than a dull one that is unmistakably her —\n'
      + '    the mean of this set is the reference for every frame she ever makes.');
  }
  say(`  Coherent   lowest ${coherence.minimum.toFixed(3)} against the set mean ✓`);

  if (!CONFIRMED) {
    say('\n  Nothing has been submitted. Re-run with --yes to train.');
    say('  fal prices flux-lora-fast-training per run — check their model page;');
    say('  I could not reach it from where this was written.\n');
    return;
  }

  // 4 ── zip it and put it where the trainer can fetch it
  //
  // Through the same service the export endpoint uses, rather than a second
  // copy here. This shelled out to `zip` and then re-implemented the upload,
  // which is two more things to be subtly different from what the product does
  // — and the archive fal receives has to be the same archive either way.
  say('\n  Packing…');
  let seedSet;
  try {
    seedSet = await SeedExport.publish({
      kept,
      avatarSlug: avatar.slug,
      tenantId: avatar.tenant_id,
      candidatesDir: path.join(__dirname, 'personas', avatar.slug, 'candidates'),
      manifest: {
        avatar: avatar.slug,
        avatar_id: avatar.id,
        count: kept.length,
        culled_from: culledFrom,
        selected_at: new Date().toISOString(),
        files: images,
      },
    });
  } catch (err) {
    die(`Could not pack the seed set: ${err.message}`);
  }
  say(`    ${(seedSet.bytes / 1024 / 1024).toFixed(1)} MB, stored as ${seedSet.key}`);
  if (!seedSet.publicly_fetchable) {
    say('    (not publicly fetchable — the worker will upload it to fal storage itself)');
  }
  const seedSetUrl = seedSet.url;

  // 6 ── submit
  say('\n  Submitting…');
  let out;
  try {
    out = await LoraTraining.requestTraining({
      tenantId: avatar.tenant_id,
      avatarId: avatar.id,
      seedSetUrl,
      seedEmbeddings: embeddings,
      triggerToken: avatar.lora_trigger,
      steps: STEPS,
      idempotencyKey: `train-${avatar.id}-${Date.now()}`,
    });
  } catch (err) {
    die(`${err.message}${err.code ? `  [${err.code}]` : ''}`);
  }

  // `{ job, version, coherence }` — the id lives on `job`, not on the wrapper.
  const jobId = out?.job?.id;
  if (!jobId) {
    die(`Submitted, but the reply had no job id: ${JSON.stringify(out).slice(0, 300)}\n`
      + '    The job may well exist. Check before re-running, or you will pay to\n'
      + '    train twice:  node studio/train.js --jobs');
  }
  say(`    queued as job #${jobId}  (LoRA version ${out.version})\n`);
  say('  A worker has to be running to pick this up:');
  say('      cd backend && node worker/index.js\n');

  // 7 ── watch
  say('  Watching (Ctrl-C is safe — the job keeps running):');
  await watch(jobId, avatar);
}

async function watch(jobId, avatar) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const { rows: js } = await pool.query(
      'SELECT status, error, result FROM render_jobs WHERE id = $1', [jobId]
    );
    const j = js[0];
    if (!j) { say(`    job #${jobId} is not in render_jobs — try  node studio/train.js --jobs`); break; }

    const mins = ((Date.now() - started) / 60000).toFixed(1);
    if (j.status === DONE) {
      const loraPath = j.result?.lora_path || j.result?.diffusers_lora_file?.url || j.result?.path;
      say(`\n  ✓ Trained in ${mins} min.`);
      const avatarId = avatar?.id ?? (await pool.query(
        "SELECT (payload->>'avatar_id')::int AS id FROM render_jobs WHERE id = $1", [jobId]
      )).rows[0]?.id;
      const { rows: ls } = await pool.query(
        'SELECT id, version, file_path, active FROM avatar_loras WHERE avatar_id = $1 ORDER BY id DESC LIMIT 1',
        [avatarId]
      );
      const lora = ls[0];
      if (lora) {
        say(`    LoRA #${lora.id}  version ${lora.version}  active: ${lora.active}`);
        say(`    ${lora.file_path || loraPath || '(path not recorded)'}`);
        say('\n  It landed INACTIVE on purpose — an untested model should not start');
        say('  serving shoots because a training job happened to finish. Next:');
        say(`      node studio/calibrate.js --lora ${lora.id}`);
        say(`\n  And for the landing page:`);
        say(`      node studio/hero-assets.js --lora "${lora.file_path || '<path>'}" --yes`);
      }
      break;
    }
    if (DEAD.includes(j.status)) {
      say(`\n  ✗ ${j.status} after ${mins} min: ${j.error || '(no message)'}`);
      break;
    }
    process.stdout.write(`\r    ${j.status}… ${mins} min`);
  }
}


/**
 * Write the `avatar_loras` row for a job that already trained.
 *
 * Needed because the report handler never called `recordTrained` — a job could
 * succeed, bill, and leave no model behind. The fix is in the API now, but a run
 * that already happened is a paid artefact sitting in storage with no row
 * pointing at it, and retraining to produce a row costs $2 for a file that
 * already exists.
 */
async function recordJob(jobId) {
  const { rows } = await pool.query(
    'SELECT id, stage, status, result, cost_cents FROM render_jobs WHERE id = $1', [jobId]
  );
  const job = rows[0];
  if (!job) die(`No job #${jobId}.`);
  if (job.stage !== 'lora_train') die(`Job #${jobId} is stage '${job.stage}', not lora_train.`);
  if (job.status !== DONE) {
    die(`Job #${jobId} is '${job.status}' — only a '${DONE}' job has an artefact.\n`
      + `    Statuses: queued → claimed → running → ${DONE}, or ${DEAD.join(' / ')}.`);
  }

  const asset = (job.result?.assets || [])[0] || {};
  const filePath = asset.key || asset.url || null;
  if (!filePath) {
    die(`Job #${jobId} succeeded but its result has no asset:\n    ${JSON.stringify(job.result).slice(0, 300)}`);
  }

  const lora = await LoraTraining.recordTrained(jobId, {
    filePath,
    costCents: Number(job.cost_cents || 0),
  });
  say(`\n  ✓ LoRA #${lora.id} v${lora.version} recorded from job #${jobId} — no retraining, nothing spent.`);
  say(`    file_path  ${lora.file_path}`);
  say(`    active     ${lora.active}   (calibration is what activates it)`);
  say(`\n  Next:`);
  say(`      node studio/calibrate.js --lora ${lora.id}`);
  say(`      node studio/hero-assets.js --lora "${lora.file_path}" --yes\n`);
}

/** Recent training jobs, so an id lost to a crash does not cost a second run. */
async function listJobs() {
  const { rows } = await pool.query(
    `SELECT j.id, j.status, j.created_at, a.name, a.id AS avatar_id
       FROM render_jobs j LEFT JOIN avatars a ON a.id = (j.payload->>'avatar_id')::int
      WHERE j.stage = 'lora_train'
      ORDER BY j.id DESC LIMIT 10`
  );
  if (!rows.length) { say('\n  No training jobs yet.\n'); return; }
  say('\n  Training jobs\n');
  for (const r of rows) {
    say(`    #${String(r.id).padEnd(6)} ${String(r.status).padEnd(10)} ${r.name || `avatar ${r.avatar_id}`}   ${new Date(r.created_at).toLocaleString()}`);
  }
  say(`\n  Watch one:     node studio/train.js --watch ${rows[0].id}`);
  say(`  Succeeded but no LoRA row?  node studio/train.js --record <id>\n`);
}

/** Attach to a job already in the queue. */
async function watchJob(jobId) {
  const { rows } = await pool.query('SELECT id, stage, status FROM render_jobs WHERE id = $1', [jobId]);
  if (!rows[0]) die(`No job #${jobId}.  node studio/train.js --jobs  lists them.`);
  say(`\n  Watching job #${jobId} (${rows[0].status})\n`);
  await watch(jobId, null);
}


main()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
