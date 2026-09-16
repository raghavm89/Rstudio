'use strict';

const pool          = require('../../config/db');
const RenderJob     = require('../../models/renderJob');
const Calibration   = require('./calibration');
const { assemblePrompt, WorkflowError, DIMENSIONS } = require('./comfyui/buildWorkflow');
const { isPubliclyFetchable, createStorage } = require('./storageFactory');
const CreditLedger  = require('./creditLedger');

/**
 * Generating the frames calibration measures.
 *
 * `calibration.js` has always been able to TURN samples into a baseline. It has
 * never been able to produce the samples, and said so in `studio/calibrate.js`:
 * "the generating half needs a shoot to run through the queue, which is the
 * orchestrator's job rather than a script's". So calibration was a function
 * nothing called, and `activate` refused every model for want of it.
 *
 * ── The deadlock, and why this module exists rather than a flag on the shoot ─
 * The shoot path cannot generate these frames. `promptStage` resolves the LoRA
 * with `LEFT JOIN avatar_loras l ON l.avatar_id = a.id AND l.active` and fails
 * `NO_LORA` when there is none — and the model being calibrated is by
 * definition INACTIVE, because activation is what calibration unlocks.
 * Relaxing that join to "the newest LoRA" would silently render published work
 * with an unproven model, which is the exact thing the guard is for.
 *
 * So this builds its own payload and NAMES the LoRA. `FalProvider.runStill`
 * only ever needed `generation.lora.path`; it never asked whether the row was
 * active. The guard that matters lives in the SQL that chooses a model for a
 * shoot, and that guard is untouched.
 *
 * ── Why `calib_still` is its own stage ──────────────────────────────────────
 * `runSeedStill` argues the opposite case for anchored frames — "the difference
 * is the job's payload, not the stage" — and that argument turns entirely on
 * their being "the same act billed the same way". This is not. `still` is in
 * METERED against `still_megapixels`, the month's SHOOTING budget; charging
 * forty frames of setup to it repeats precisely the bug that took seed frames
 * out of that meter, where a usable pool cost more than a month of posts. A
 * stage that bills differently is a different stage.
 *
 * ── What it costs the customer ──────────────────────────────────────────────
 * Nothing. Calibration is the second half of training, and training is
 * included. The spend is still RECORDED — `RenderJob.complete` writes
 * `cost_cents` on every job whatever its stage — so the self-hosting question
 * is answered by `SUM(cost_cents) WHERE stage = 'calib_still'`, which is a
 * truer number than a tenant roll-up would be. There is deliberately no
 * `studio_usage_counters` row for it: inventing a counter nobody meters is how
 * a metric ends up half-enforced.
 *
 * The ceiling is structural rather than financial. `Calibration.plan` skips
 * every cell already in `expression_baselines`, the idempotency key is the cell
 * and the sample index, and a LoRA version has a fixed number of cells — so
 * pressing the button twice costs nothing and there is no sequence of presses
 * that spends more than one plan per trained model.
 */

/** 0.97 MP, which bills as 1. See `quality` below for why not 2. */
const QUALITY = '1mp';

/**
 * Priced per FRAME, not per run.
 *
 * A run is 66 frames by default and 396 at the widest the endpoint allows.
 * Per-run pricing would charge the same for both while the wide one costs us
 * six times as much — and it is the wide one somebody reaches for when the
 * first calibration disappointed them.
 */
const CALIBRATION_METRIC = 'lora_calibrations';

/**
 * Samples per cell, and the one place that number lives.
 *
 * The controller clamps a request to 6–12 and `Calibration.MIN_SAMPLES` is the
 * floor below which a tolerance is measuring noise. Six is the smallest that
 * survives one structurally broken frame, and the status read has to quote the
 * same number the button will spend or the price on screen is fiction.
 */
const DEFAULT_SAMPLES = 6;

/**
 * Which presets are worth measuring.
 *
 * This module used to own its own answer — `!p.blend_with && !p.follow_on_pass`
 * — and so did `Calibration.readiness`, and so did `expressionHint`, and no two
 * of the three agreed. `Calibration.expressible` is the single answer now: a
 * preset is measurable when the vocabulary can actually prompt it. Re-exported
 * rather than re-implemented, because a fourth copy is how this happened.
 */
const measurable = Calibration.expressible;

/**
 * What varies across the samples of one cell, and why it must.
 *
 * The instinct is to hold everything but the seed constant, so the cell
 * measures "this expression" cleanly. That instinct produces a broken gate.
 * Tolerance is two standard deviations of the SAMPLE, so a sample that saw one
 * lighting setup yields a tolerance that covers one lighting setup — and then
 * the first backlit frame of a real shoot scores below the floor and is
 * rejected for having the wrong face, which it does not.
 *
 * It is the same error `calibration.js` warns about at the top in its other
 * form: dropping low scorers makes the sample tighter than reality. So does
 * never generating them. The shoot varies light, angle, wardrobe and place;
 * the measurement has to span the same ground, and the expression is the only
 * axis held fixed, because the expression is what the cell is about.
 *
 * Eight entries, walked by sample index, so six samples never repeat a setup
 * and the two hardest (backlit, top) are reached by a cell that asks for more.
 */
const NUISANCE = [
  { light_direction: 'front',        light_quality: 'soft', pose_key: 'standing square to camera, weight even' },
  { light_direction: 'front_left',   light_quality: 'soft', pose_key: 'seated, forearms resting on a table' },
  { light_direction: 'camera_right', light_quality: 'hard', pose_key: 'standing, shoulders turned slightly away' },
  { light_direction: 'camera_left',  light_quality: 'soft', pose_key: 'leaning against a wall, one shoulder forward' },
  { light_direction: 'front_right',  light_quality: 'hard', pose_key: 'standing, one hand at her side, chin level' },
  { light_direction: 'top',          light_quality: 'soft', pose_key: 'seated, looking up toward the camera' },
  { light_direction: 'back_left',    light_quality: 'soft', pose_key: 'standing, half-turned toward a window' },
  { light_direction: 'back_right',   light_quality: 'hard', pose_key: 'walking, mid-stride, facing the camera' },
];

const WARDROBE = [
  'a plain crew-neck tee and straight-leg trousers',
  'a fitted technical top and dark athletic trousers',
  'an oversized open overshirt over a plain fitted top',
];

const LOCATIONS = [
  'a small apartment balcony with potted plants, a low city skyline behind',
  'a plain neighbourhood gym, rubber flooring, mirrored wall, high windows',
  'a small cafe with wooden tables, exposed brick and a street-facing window',
  'a seafront promenade at first light, low concrete wall and palms',
  'a work desk with twin monitors, a pinboard and an anglepoise lamp',
];

/**
 * Deterministic, and derived from the cell rather than random.
 *
 * A retry of a calibration job must reproduce its frame, or "regenerate sample
 * 3" quietly changes what the other five measured against.
 */
function seedFor(loraId, presetKey, framing, sample) {
  let h = 2166136261;
  for (const ch of `${loraId}:${presetKey}:${framing}:${sample}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return h % 2 ** 31;
}

/** The look-up the shoot path does, minus `AND l.active` — which is the point. */
async function context(client, tenantId, loraId) {
  const { rows } = await client.query(
    `SELECT l.id AS lora_id, l.version, l.active, l.file_path, l.trigger_token,
            l.base_checkpoint, l.face_embedding_mean,
            a.id AS avatar_id, a.slug, a.identity_block, a.avoid_block, a.mode,
            lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
            lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version
       FROM avatar_loras l
       JOIN avatars a ON a.id = l.avatar_id
       LEFT JOIN look_profiles lp ON lp.avatar_id = a.id
      WHERE l.id = $1 AND a.tenant_id = $2`,
    [loraId, tenantId]
  );
  const row = rows[0];
  if (!row) throw new Calibration.CalibrationError('Model not found', { status: 404 });

  if (!row.face_embedding_mean) {
    throw new Calibration.CalibrationError(
      'This model has no reference face from its training set, so there is nothing to measure against.',
      { status: 409, code: 'NO_REFERENCE' }
    );
  }
  if (!row.base_look) {
    throw new Calibration.CalibrationError(
      'This avatar has no look profile — it is frozen at setup and every generation needs it.',
      { status: 409, code: 'NO_LOOK_PROFILE' }
    );
  }
  return row;
}

/** facet -> option_key -> fragment is `assemblePrompt`'s job; it wants the rows. */
async function vocabularyFor(client, version) {
  const { rows } = await client.query(
    `SELECT facet, option_key, fragment FROM prompt_vocabulary
      WHERE version = $1 AND active`,
    [version || 1]
  );
  if (!rows.length) {
    throw new Calibration.CalibrationError(
      `Prompt vocabulary version ${version} has no active rows`,
      { status: 500, code: 'NO_VOCABULARY' }
    );
  }
  return rows;
}

/**
 * The cells still to measure, priced.
 *
 * Delegates the "what is missing" question to `Calibration.plan` so there is
 * one answer to it, then drops the presets readiness will never read and
 * reprices what remains at the resolution these frames are actually generated
 * at — `plan` assumed 2 MP.
 */
async function preview(tenantId, loraId, { framings = ['medium'], samples = DEFAULT_SAMPLES } = {}) {
  const planned = await Calibration.plan(tenantId, loraId, { framings, samples });

  // No second filter here any more. `plan` walks `Calibration.expressible`,
  // which is the same answer readiness uses, so anything it lists is something
  // this will really queue — and a quote for work that will not be done is a
  // number nobody can reconcile against the bill.
  const frames = planned.cells.length * samples;

  return {
    ...planned,
    total_frames: frames,
    // The supplier bill. Internal — it belongs on the job and on the admin
    // screens, never on a customer's button, which quotes `credits` below.
    estimated_cost_cents: frames * 3.5,
    // Asked of the rate card, never computed here. This used to be a hardcoded
    // `{ credits: 0, included: true }`, which is the one thing the training
    // price got right and this got wrong: a price written in the service is a
    // price that disagrees with the rate card the moment either moves.
    credits: CreditLedger.creditsFor(CALIBRATION_METRIC, frames),
    quality: QUALITY,
    samples,
    framings,
  };
}

/**
 * Queue every remaining cell.
 *
 * One transaction, because a half-queued plan measures a subset and then
 * reports a baseline as though it had measured the whole thing.
 */
async function submit(tenantId, loraId, { userId = null, framings = ['medium'], samples = DEFAULT_SAMPLES, ip = null, allowActive = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const row = await context(client, tenantId, loraId);
    // An ACTIVE model normally refuses recalibration: changing a baseline under
    // published work would move the gate the work was judged by. `allowActive`
    // is the operator exception, and it is only safe because of WHAT this queues
    // — cells that have NO baseline yet (a framing never measured). Those add
    // coverage without touching an existing baseline, and faceQc floors at
    // Math.min(calibratedFloor, IDENTITY_FLOOR), so a newly-calibrated framing
    // can only ever LOOSEN or hold the gate, never tighten it below what
    // published work already faced. The `have`-skip below keeps it additive.
    if (row.active && !allowActive) {
      throw new Calibration.CalibrationError(
        'This model is already in use — calibrating it again would change the gate under work already published.',
        { status: 409, code: 'ALREADY_ACTIVE' }
      );
    }

    const vocabulary = await vocabularyFor(client, row.vocabulary_version);

    const presets = await measurable(tenantId, { vocabularyVersion: row.vocabulary_version || 1, client });
    const { rows: done } = await client.query(
      'SELECT preset_key, framing FROM expression_baselines WHERE lora_id = $1',
      [loraId]
    );
    const have = new Set(done.map((d) => `${d.preset_key}:${d.framing}`));

    const dims = DIMENSIONS[QUALITY];
    const run = `c${loraId}-${Date.now().toString(36)}`;

    /**
     * 🐛 What this run will actually BUY, decided before anything is charged.
     *
     * Two exclusions, and the second one is a bug this had the moment
     * calibration started costing credits.
     *
     * A cell with a baseline is already measured — that one was always here.
     * But a frame already QUEUED is also not work this press creates, and the
     * idempotency key made that invisible: `enqueueTx` returns the existing row
     * on conflict, so a second press queued nothing, reported sixty-six job ids
     * and — once there was a price — charged for all sixty-six again. The key
     * protected the jobs from duplication and the customer from nothing.
     *
     * A frame that failed PERMANENTLY is different again: its credits were
     * refunded at settlement, so it is genuinely outstanding and must be both
     * re-queued and re-charged. Its idempotency key is released below for the
     * same reason `seedTraining.submit` releases a failed training run's —
     * otherwise the guard hands back the corpse and the retry is impossible.
     *
     * Counted first so the whole run is paid for in one go. Charging cell by
     * cell as they queue would let a customer run out at cell nine of eleven
     * and keep a model with most of a calibration — which cannot be activated,
     * having spent the credits that would have finished it.
     */
    const { rows: queued } = await client.query(
      `SELECT id, status, payload->>'preset_key' AS preset_key,
              payload->>'framing' AS framing, (payload->>'sample')::int AS sample
         FROM render_jobs
        WHERE stage = 'calib_still' AND tenant_id = $1 AND payload->>'lora_id' = $2`,
      [tenantId, String(loraId)]
    );
    const alive = new Map();
    const spent = [];
    for (const j of queued) {
      const key = `${j.preset_key}:${j.framing}:${j.sample}`;
      if (['failed', 'cancelled'].includes(j.status)) spent.push(j.id);
      else alive.set(key, j.id);
    }
    // Release the keys of the dead, so their frames can be bought again.
    if (spent.length) {
      await client.query(
        'UPDATE render_jobs SET idempotency_key = NULL, updated_at = NOW() WHERE id = ANY($1::int[])',
        [spent]
      );
    }

    const cells = [];
    const wanted = [];
    for (const preset of presets) {
      for (const framing of framings) {
        if (have.has(`${preset.key}:${framing}`)) continue;
        cells.push({ preset_key: preset.key, framing });
        for (let sample = 0; sample < samples; sample += 1) {
          if (alive.has(`${preset.key}:${framing}:${sample}`)) continue;
          wanted.push({ preset, framing, sample });
        }
      }
    }

    const frames = wanted.length;
    const credits = CreditLedger.creditsFor(CALIBRATION_METRIC, frames);
    if (credits > 0) {
      const paid = await CreditLedger.spend(
        client, tenantId, CALIBRATION_METRIC, credits, `calib:${loraId}:${run}`);
      if (!paid) {
        const held = await CreditLedger.balance(client, tenantId);
        throw new Calibration.CalibrationError(
          `Calibrating ${row.slug} needs ${credits} credits for ${frames} photos, and you hold ${held}.`,
          { status: 402, code: 'NOT_ENOUGH_CREDITS' }
        );
      }
    }

    // Whole credits, remainder on the first job — the same split seed frames
    // use, and for the same reason: dividing evenly with a float leaks a
    // fraction on every run, in our favour, which is the direction that never
    // gets reported.
    const perJob = frames > 0 ? Math.floor(credits / frames) : 0;
    const remainder = credits - perJob * frames;

    const jobs = [];

    for (const { preset, framing, sample } of wanted) {
      const n = NUISANCE[sample % NUISANCE.length];
      const seed = seedFor(loraId, preset.key, framing, sample);

      let prompt;
      try {
        prompt = assemblePrompt({
          avatar: { slug: row.slug, identity_block: row.identity_block, avoid_block: row.avoid_block, mode: row.mode },
          lora: { trigger_token: row.trigger_token },
          lookProfile: {
            base_look: row.base_look, lens: row.lens, colour: row.colour,
            grain: row.grain, skin: row.skin,
            natural_asymmetry: row.natural_asymmetry, hair_detail: row.hair_detail,
          },
          shot: {
            framing,
            light_direction: n.light_direction,
            light_quality: n.light_quality,
            expression_key: preset.key,
            pose_key: n.pose_key,
            advanced_append: null,
          },
          scene: { time_of_day: null },
          vocabulary,
          locationText: LOCATIONS[sample % LOCATIONS.length],
          wardrobeText: WARDROBE[sample % WARDROBE.length],
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          throw new Calibration.CalibrationError(err.message, { status: 409, code: 'PROMPT_ASSEMBLY_FAILED' });
        }
        throw err;
      }

      const job = await RenderJob.enqueueTx(client, {
        tenant_id: tenantId,
        stage: 'calib_still',
        runner: 'cloud',
        provider: 'fal',
        // Ahead of a seed pool (120) and a shoot (100), behind training
        // (40). The avatar is mid-setup with nothing usable yet, and every
        // frame here is one the customer is waiting on before they can
        // shoot at all.
        priority: 60,
        label: `Calibrating ${row.slug} ${preset.label} ${framing} ${sample + 1}/${samples}`,
        step_index: jobs.length,
        step_total: null,
        payload: {
          avatar_id: row.avatar_id,
          lora_id: row.lora_id,
          run,
          preset_key: preset.key,
          framing,
          sample,
          generation: {
            prompt,
            width: dims.width,
            height: dims.height,
            megapixels: 1,
            seed,
            candidates: 1,
            steps: 24,
            guidance: 3.5,
            publicly_fetchable: isPubliclyFetchable(),
            // Named, not looked up. The whole reason this module exists:
            // the row is inactive and the shoot path will not resolve it.
            lora: { path: createStorage().readUrl(row.file_path), scale: 0.95, id: row.lora_id },
            expression_key: preset.key,
            framing,
            filenamePrefix: `calib/${preset.key}-${framing}-${sample}`,
          },
          // No `_reserved`: calib_still is not in METERED, so no monthly
          // counter was touched and there is none to reconcile.
          //
          // `_from_credits` there IS, because credits were taken. This one
          // frame's share of the run, so a frame that fails permanently
          // returns exactly what it cost and not a penny of its neighbours'.
          _from_credits: perJob + (jobs.length === 0 ? remainder : 0),
        },
        // The cell and the sample, NOT the run. A second press after a
        // partial failure must re-use the frames that landed rather than
        // buy the whole plan again.
        idempotency_key: `calib:${loraId}:${preset.key}:${framing}:${sample}`,
      });
      if (job) jobs.push(job.id);
    }

    await client.query(
      `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
       VALUES ($1, $2, 'avatar.calibrate.submit', 'avatar_lora', $3, $4, $5::jsonb, $6)`,
      [tenantId, userId, loraId, row.avatar_id,
       JSON.stringify({ run, cells: cells.length, samples, framings, queued: jobs.length,
                        version: row.version, frames, credits }), ip]
    );

    await client.query('COMMIT');
    return {
      run,
      lora_id: row.lora_id,
      avatar_id: row.avatar_id,
      version: row.version,
      cells,
      samples,
      // `frames` is what this press BOUGHT, not the size of the plan — a second
      // press after a partial failure buys only the frames that are missing.
      frames,
      credits,
      queued: jobs.length,
      reused: alive.size,
      // Zero cells is not a failure — it is a model whose every measurable
      // preset already has a baseline, which is what finished looks like.
      complete: cells.length === 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Everything the calibration screen needs, in one read.
 *
 * A separate poll would be a second thing to get wrong, and the face screen is
 * already asking `trainStatus` every three seconds — so this hangs off that
 * answer rather than beside it.
 *
 * The shape is deliberate: it reports STATE, not a response to a request.
 * Every dead end on this screen so far has been the same bug in a different
 * costume — the panel remembered what it was told when a button was pressed
 * and went on saying it after the world moved. So there is nothing here that
 * is not read from a row.
 */
async function status(tenantId, avatarId) {
  const { rows: loras } = await pool.query(
    `SELECT l.id, l.version, l.active, l.face_embedding_mean IS NOT NULL AS has_reference
       FROM avatar_loras l JOIN avatars a ON a.id = l.avatar_id
      WHERE l.avatar_id = $1 AND a.tenant_id = $2
      ORDER BY l.active DESC, l.version DESC
      LIMIT 1`,
    [avatarId, tenantId]
  );
  const lora = loras[0];
  if (!lora) return null;

  const out = {
    lora_id: lora.id,
    version: lora.version,
    active: lora.active,
    has_reference: lora.has_reference,
  };

  if (lora.active) {
    out.state = 'active';
    return out;
  }
  if (!lora.has_reference) {
    out.state = 'blocked';
    out.why = 'This model has no reference face from its training set, so there is nothing to measure against.';
    return out;
  }

  const ready = await Calibration.readiness(tenantId, lora.id);
  out.measured = ready.calibrated;
  out.measurable = ready.measurable;
  out.missing = ready.missing;
  out.ready = ready.ready;

  /**
   * What the next press would cost, and whether they can afford it.
   *
   * Priced on the cells still OUTSTANDING rather than on all of them, because
   * that is what the button will actually buy: a customer who lost two cells to
   * unusable frames is charged for two, not for eleven. `held` travels with it
   * so the screen can say how short they are instead of only that they are.
   */
  const outstanding = ready.missing.length * DEFAULT_SAMPLES;
  out.price = {
    frames: outstanding,
    credits: CreditLedger.creditsFor(CALIBRATION_METRIC, outstanding),
    held: await CreditLedger.balance(pool, tenantId),
  };
  out.price.affordable = out.price.credits <= out.price.held;
  out.price.short = Math.max(0, out.price.credits - out.price.held);

  // The frames, counted by what they are doing rather than by what was asked
  // for. A run is "generating" because rows say so, not because submit
  // returned a number some minutes ago.
  const { rows: fr } = await pool.query(
    `SELECT count(*) FILTER (WHERE status NOT IN ('done','failed','cancelled'))::int AS pending,
            count(*) FILTER (WHERE status = 'done')::int   AS done,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*)::int                                  AS total,
            MAX(EXTRACT(EPOCH FROM (NOW() - created_at))::int) AS age_seconds,
            bool_or(claimed_at IS NOT NULL)                AS ever_claimed
       FROM render_jobs
      WHERE stage = 'calib_still' AND tenant_id = $1 AND payload->>'lora_id' = $2`,
    [tenantId, String(lora.id)]
  );
  out.frames = {
    total: fr[0].total, done: fr[0].done, failed: fr[0].failed, pending: fr[0].pending,
    // Carried because the stalled message counts with it. Deriving `stalled`
    // here and leaving the number behind is how a screen ends up saying
    // "queued for NaN".
    age_seconds: Number(fr[0].age_seconds || 0),
    // Same two-minute rule as the seed check and the training run: something
    // that is merely busy will still have CLAIMED one by then.
    stalled: fr[0].total > 0 && fr[0].ever_claimed === false && Number(fr[0].age_seconds || 0) > 120,
  };

  // The measurements, and — the part that matters — the ones that answered and
  // could not be measured. A cell that failed is the difference between "still
  // working" and "this one needs more frames", and a screen that can only see
  // readiness cannot tell them apart.
  const { rows: em } = await pool.query(
    `SELECT status, payload->>'preset_key' AS preset_key, payload->>'framing' AS framing,
            result->'calibration' AS outcome
       FROM render_jobs
      WHERE stage = 'embed' AND tenant_id = $1 AND payload->>'lora_id' = $2
      ORDER BY id`,
    [tenantId, String(lora.id)]
  );
  out.measurements = {
    total: em.length,
    pending: em.filter((e) => !['done', 'failed', 'cancelled'].includes(e.status)).length,
  };
  out.unmeasurable = em
    .filter((e) => e.outcome && e.outcome.error)
    .map((e) => ({ preset_key: e.preset_key, framing: e.framing, error: e.outcome.error }));

  if (out.ready) out.state = 'ready';
  else if (out.frames.pending || out.measurements.pending) out.state = 'working';
  else if (out.frames.total === 0) out.state = 'none';
  else out.state = 'incomplete';

  // Why nothing is measuring, when nothing is. The same question the seed-set
  // check answers, with the same answer, because it is the same dependency.
  if (['working', 'incomplete'].includes(out.state) && !out.frames.pending) {
    const { EmbedRunner } = require('./embedRunner');
    out.can_measure_here = await EmbedRunner.ready();
    if (!out.can_measure_here) out.why_not = await EmbedRunner.reason();
  }

  return out;
}

module.exports = { preview, submit, status, seedFor, measurable, NUISANCE, QUALITY,
                   CALIBRATION_METRIC, DEFAULT_SAMPLES };
