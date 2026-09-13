'use strict';

const crypto = require('node:crypto');
const pool = require('../../config/db');
const RenderJob = require('../../models/renderJob');
const Seed = require('./seedCandidates');
const SeedExport = require('./seedExport');
const LoraTraining = require('./loraTraining');
const CreditLedger = require('./creditLedger');
const { createStorage, isPubliclyFetchable } = require('./storageFactory');

/**
 * Cull → check → train, as three things the product can do.
 *
 * All of this used to be `node studio/train.js --avatar 3 --yes`, which is a
 * complete answer for the person who owns the repository and none at all for
 * anybody else. What stood in the way was never the wiring: `requestTraining`
 * refuses a seed set that is not confidently one person, and that check needs a
 * face embedding per image, which comes from insightface through a Python
 * subprocess. So the check became a queued stage — `embed` — and this is the
 * service that queues it, reads it, and submits what it approves.
 *
 * ── Why a set fingerprint ───────────────────────────────────────────────────
 * The check and the confirmation are two separate clicks with a person in
 * between, and in between them they can unpick a frame. Training on embeddings
 * of a set that no longer exists would produce a model whose reference vector
 * describes photographs nobody kept — silently, permanently, and for $2. So the
 * embed job records a fingerprint of exactly which frames it measured, and
 * submitting checks it still matches.
 */

/** Exactly which frames were measured, in an order that cannot drift. */
function fingerprint(filenames) {
  const sorted = [...filenames].sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 32);
}

/** The metric a training run would be metered against, if it were metered. */
const TRAINING_METRIC = 'lora_trainings';

class TrainingRefused extends Error {
  constructor(message, { code = null, status = 409, ...rest } = {}) {
    super(message);
    this.name = 'TrainingRefused';
    this.code = code;
    this.status = status;
    Object.assign(this, rest);
  }
}

/**
 * The kept set, or the reason it is not one yet.
 *
 * `keptForExport` is the same gate the export endpoint and the cull screen use
 * — twelve minimum, forty cap, no coverage hole. Training must not have a
 * second opinion about what a usable set is.
 */
async function keptSet(client, tenantId, avatar) {
  const { kept, culledFrom } = await Seed.keptForExport(client, tenantId, avatar.id);
  return { kept, culledFrom, fingerprint: fingerprint(kept.map((k) => k.filename)) };
}

// ── 1. Check ─────────────────────────────────────────────────────────────────

/**
 * Queue the measurement. Nothing is spent here and nothing is submitted.
 *
 * @returns {{job_id: number, fingerprint: string, count: number}}
 */
async function check(client, { tenantId, userId, avatar, ip = null }) {
  const { kept, fingerprint: fp } = await keptSet(client, tenantId, avatar);

  const storage = createStorage();
  const frames = kept.map((c) => ({
    filename: c.filename,
    // Presigned, and never `publicUrl`: these are the training images of a face
    // and that prefix is world-readable so Instagram can fetch from it.
    url: c.storage_key ? storage.readUrl(c.storage_key) : null,
    storage_key: c.storage_key || null,
  }));

  const unreachable = frames.filter((f) => !f.url);
  if (unreachable.length) {
    // Frames with no storage key are files in a persona directory on whichever
    // machine generated them. A worker on another machine cannot fetch those.
    throw new TrainingRefused(
      `${unreachable.length} kept frame${unreachable.length === 1 ? '' : 's'} exist only as local files, `
      + 'so nothing else can read them to measure the face.',
      { code: 'FRAMES_NOT_FETCHABLE' });
  }

  const job = await RenderJob.enqueueTx(client, {
    tenant_id: tenantId,
    stage: 'embed',
    // Not `cloud`. This runs insightface on real hardware, not on fal — the
    // whole reason it is a stage is that the API host cannot be assumed to have
    // Python and a model cache.
    runner: 'mac',
    provider: 'local',
    // Ahead of a candidate pool: somebody is sitting on the screen waiting for
    // this answer, and a pool will happily sit unculled for an hour.
    priority: 60,
    label: `Checking ${avatar.slug}'s seed set`,
    payload: {
      avatar_id: avatar.id,
      set_fingerprint: fp,
      count: frames.length,
      frames,
    },
    // Pressing the button twice must not measure the same set twice.
    idempotency_key: `embed:${avatar.id}:${fp}`,
  });

  await client.query(
    `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
     VALUES ($1, $2, 'avatar.seed_set.check', 'avatar', $3, $3, $4::jsonb, $5)`,
    [tenantId, userId, avatar.id, JSON.stringify({ count: frames.length, fingerprint: fp }), ip]
  );

  return { job_id: job?.id || null, fingerprint: fp, count: frames.length };
}

// ── 2. Status ────────────────────────────────────────────────────────────────

/** The most recent measurement of this avatar's seed set, whatever state it is in. */
async function latestEmbedJob(avatarId, tenantId) {
  const { rows } = await pool.query(
    `SELECT id, status, error, result, payload, created_at,
            claimed_at IS NOT NULL                            AS ever_claimed,
            EXTRACT(EPOCH FROM (NOW() - created_at))::int     AS age_seconds
       FROM render_jobs
      WHERE stage = 'embed' AND tenant_id = $1 AND payload->>'avatar_id' = $2
      ORDER BY id DESC
      LIMIT 1`,
    [tenantId, String(avatarId)]
  );
  return rows[0] || null;
}

/**
 * Everything the Train screen needs, in one read.
 *
 * The coherence check runs HERE rather than on the worker, deliberately. The
 * worker measures; it does not judge. Where the threshold sits, and what
 * happens when a frame falls below it, is a product decision that belongs on
 * the machine that owns the product — and a worker that could decide a set was
 * fine is a worker that could approve spending.
 */
async function status(tenantId, avatar) {
  const out = {
    /**
     * What this costs the CUSTOMER, in the unit they hold.
     *
     * Never cents. What fal charges us is an internal number: it belongs in
     * `cost_cents` on the job, where the self-hosting decision is read out of
     * it, and on the admin screens. Quoting it on a customer's button tells
     * them our supplier's price and invites them to do arithmetic about our
     * margin — and it is not even the number they would pay.
     *
     * Asked of the rate card rather than hardcoded, so this needs no edit if
     * training is ever priced: `lora_trainings` has no rate today, which is
     * what makes it included with the avatar.
     */
    price: {
      credits: CreditLedger.creditsFor(TRAINING_METRIC, 1),
      get included() { return this.credits === 0; },
    },
    gate: null,
    check: null,
    coherence: null,
    stale: false,
    training: null,
  };

  const { rows: loras } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE active)::int AS active
       FROM avatar_loras WHERE avatar_id = $1`, [avatar.id]);
  out.versions = loras[0].n;
  // Was `trained: false`, always, initialised and never computed.
  out.trained = loras[0].active > 0;

  /**
   * And the step after training, on the same read.
   *
   * Not a second poll. The face screen already asks this every three seconds,
   * and "Trained — version 1" with no way forward was the dead end: the copy
   * told the person calibration decides the likeness thresholds and then
   * offered them nothing to press. One screen, one answer.
   */
  if (out.versions > 0) {
    out.calibration = await require('./calibrationRun').status(tenantId, avatar.id);
  }

  /**
   * The training run itself.
   *
   * Submitting used to be the end of what this screen knew: it said "Training
   * queued as version 1" and then said that forever, whether the run was
   * working, finished, or had failed twenty seconds later. Which is the same
   * dead end a queued candidate batch used to be — and the reason the answer to
   * "is anything happening" has to come from the job row rather than from the
   * fact that a request once succeeded.
   */
  const { rows: runs } = await pool.query(
    `SELECT id, status, error, payload, attempts, max_attempts,
            claimed_at IS NOT NULL                         AS ever_claimed,
            EXTRACT(EPOCH FROM (NOW() - created_at))::int  AS age_seconds,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at)))::int AS running_seconds,
            -- Claimed by something that has stopped reporting. Between reaps a
            -- job in this state still says "running", and from the outside a
            -- job nobody is working on is indistinguishable from one that is.
            (lease_expires_at IS NOT NULL AND lease_expires_at < NOW()) AS lease_expired
       FROM render_jobs
      WHERE stage = 'lora_train' AND tenant_id = $1 AND payload->>'avatar_id' = $2
      ORDER BY id DESC LIMIT 1`,
    [tenantId, String(avatar.id)]
  );
  if (runs[0]) {
    const run = runs[0];
    out.training = {
      job_id: run.id,
      version: run.payload?.version ?? null,
      status: run.status,
      error: run.error || null,
      attempts: Number(run.attempts || 0),
      age_seconds: Number(run.age_seconds || 0),
      running_seconds: Number(run.running_seconds || 0),
      // Same two-minute rule as everywhere else: a renderer that is merely busy
      // will still have CLAIMED something by then.
      stalled: Number(run.ever_claimed) === 0 && Number(run.age_seconds || 0) > 120,
      // Claimed, and then whatever held it stopped. The reaper puts it back on
      // the queue within a minute; saying so beats counting at somebody.
      abandoned: run.lease_expired === true && ['claimed', 'running'].includes(run.status),
    };
    if (out.training.stalled) {
      const { CloudRunner } = require('./cloudRunner');
      out.training.renderer_ready = await CloudRunner.ready();
    }
  }

  let set = null;
  try {
    set = await keptSet(pool, tenantId, avatar);
    out.gate = { ok: true, count: set.kept.length, culled_from: set.culledFrom };
  } catch (err) {
    out.gate = { ok: false, error: err.message, code: err.code, gaps: err.gaps || null };
    return out;
  }

  const job = await latestEmbedJob(avatar.id, tenantId);
  if (!job) return out;

  out.check = {
    job_id: job.id,
    status: job.status,
    error: job.error || null,
    age_seconds: Number(job.age_seconds || 0),
    // Same reasoning as a candidate batch: two minutes with nothing ever
    // claimed is not slow, it is unattended. This stage in particular needs a
    // worker running, so saying so is the difference between a screen that
    // explains itself and one that counts at somebody.
    stalled: Number(job.ever_claimed) === 0 && Number(job.age_seconds || 0) > 120,
  };

  /**
   * And if it has stalled, whether this machine could ever have run it.
   *
   * "Nothing has started the check" is the symptom the screen is already
   * showing. There are two causes and they need different sentences: this
   * server cannot measure faces at all (no insightface — the job is waiting for
   * a machine that can), or it can and something else is wrong. Asked only when
   * something has actually gone quiet, so a healthy poll pays nothing.
   */
  if (out.check.stalled) {
    const { EmbedRunner } = require('./embedRunner');
    out.check.can_measure_here = await EmbedRunner.ready();
    out.check.why_not = out.check.can_measure_here ? null : await EmbedRunner.reason();
  }

  // Measured a different set from the one that is kept now.
  out.stale = job.payload?.set_fingerprint !== set.fingerprint;
  if (out.stale || job.status !== 'done') return out;

  const embeddings = job.result?.embeddings;
  if (!Array.isArray(embeddings) || !embeddings.length) {
    out.check.error = 'The check finished but measured nothing.';
    return out;
  }

  try {
    const coherence = LoraTraining.checkSeedCoherence(embeddings);
    out.coherence = {
      coherent: coherence.coherent,
      minimum: coherence.minimum,
      mean: coherence.mean ?? null,
      // Names, not indices. "Frame 7 is an outlier" is not something anybody can
      // act on while looking at a grid of pictures.
      outliers: (coherence.outliers || []).map((o) => ({
        filename: job.payload?.frames?.[o.index]?.filename ?? `#${o.index}`,
        similarity: o.similarity,
      })),
    };
  } catch (err) {
    out.coherence = { coherent: false, error: err.message };
  }
  return out;
}

// ── 3. Submit ────────────────────────────────────────────────────────────────

/**
 * Train, having been asked twice.
 *
 * Re-checks everything rather than trusting what the screen was showing: the
 * gate, the fingerprint, and the coherence result. A screen can be stale, a
 * request can be replayed, and this is the one action in the product that is
 * both expensive and permanent.
 */
async function submit(client, { tenantId, userId, avatar, steps = 1000, ip = null }) {
  const set = await keptSet(client, tenantId, avatar);
  const job = await latestEmbedJob(avatar.id, tenantId);

  if (!job || job.status !== 'done') {
    throw new TrainingRefused('This seed set has not been checked yet.', { code: 'NOT_CHECKED' });
  }
  if (job.payload?.set_fingerprint !== set.fingerprint) {
    throw new TrainingRefused(
      'The kept photos changed after the check. Run the check again so the model is trained on what is actually kept.',
      { code: 'SET_CHANGED' });
  }

  const embeddings = job.result?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== set.kept.length) {
    throw new TrainingRefused('The check does not match the set it measured.', { code: 'CHECK_MISMATCH' });
  }

  /**
   * Has this exact set already been submitted?
   *
   * `requestTraining` carries an idempotency key, and that is enough to stop a
   * second ROW — but not a second RESERVATION. It spends an avatar slot when
   * the version is 1, and the version comes from `avatar_loras`, which is not
   * written until the job COMPLETES. So a second confirm twenty seconds later
   * computed version 1 again and reserved a second avatar against the plan
   * before the insert deduplicated itself. Measured: the second press failed
   * with "Not enough avatars remaining" on a workspace that had spent nothing.
   *
   * So the question is asked here, where a training run is identified by the
   * set it trains on, rather than left to a uniqueness constraint two layers
   * down that only protects the last step.
   */
  const key = `train:${avatar.id}:${set.fingerprint}`;
  const { rows: existing } = await client.query(
    `SELECT * FROM render_jobs WHERE idempotency_key = $1 AND tenant_id = $2`, [key, tenantId]);
  const prior = existing[0];

  // A run that is alive, or that produced a model, IS this submission.
  if (prior && !['failed', 'cancelled'].includes(prior.status)) {
    return {
      job: prior,
      version: prior.payload?.version ?? null,
      already_submitted: true,
    };
  }

  /**
   * A run that FAILED is finished with its key.
   *
   * Without releasing it, retrying the same set could never work: the key
   * identifies a submission, `enqueueTx` is ON CONFLICT DO NOTHING and then
   * re-selects, and the guard above would hand the failed job back forever. The
   * screen said "press Train again once the cause is fixed" and pressing it
   * would have returned the same failure, with no new job and no way out except
   * unpicking a frame to change the fingerprint.
   *
   * Released rather than reused so the retry is a NEW row: it gets its own
   * attempt budget, which matters most for the failure that produced this —
   * "no attempts remain" after a server restart burned all three.
   */
  if (prior) {
    /**
     * On the POOL, not on the caller's transaction — and this is load-bearing.
     *
     * `requestTraining` opens its OWN connection and transaction. An UPDATE
     * made here on the caller's uncommitted transaction is invisible to that
     * one, so its INSERT hits the still-live unique index on the key and blocks
     * waiting for this transaction to commit — which is waiting for it. The
     * request hangs until something times out. Measured: `submit` never
     * returned.
     *
     * Committing it separately is also correct on its own terms. Releasing a
     * dead job's key is not part of the new submission's atomicity: if
     * everything after this fails, what is left behind is a failed job without
     * an idempotency key, which is exactly what a failed job should be.
     */
    await pool.query(
      'UPDATE render_jobs SET idempotency_key = NULL, updated_at = NOW() WHERE id = $1', [prior.id]);
  }

  // The zip is built HERE rather than at check time, so it is the set that was
  // just re-verified rather than one assembled minutes ago.
  const seedSet = await SeedExport.publish({
    kept: set.kept,
    avatarSlug: avatar.slug,
    tenantId,
    candidatesDir: null,
    manifest: {
      avatar: avatar.slug,
      avatar_id: avatar.id,
      count: set.kept.length,
      culled_from: set.culledFrom,
      set_fingerprint: set.fingerprint,
      selected_at: new Date().toISOString(),
      files: set.kept.map((k) => k.filename),
    },
  });

  const out = await LoraTraining.requestTraining({
    tenantId,
    avatarId: avatar.id,
    userId,
    seedSetUrl: seedSet.url,
    seedEmbeddings: embeddings,
    triggerToken: avatar.lora_trigger,
    steps,
    // The same set twice is the same training run. The guard above catches the
    // ordinary double-press; this is the backstop for two requests racing.
    idempotencyKey: key,
  });

  await pool.query(
    `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
     VALUES ($1, $2, 'avatar.train.submit', 'avatar', $3, $3, $4::jsonb, $5)`,
    [tenantId, userId, avatar.id,
     JSON.stringify({ count: set.kept.length, fingerprint: set.fingerprint,
                      seed_set_key: seedSet.key, version: out.version }), ip]
  );

  return { ...out, seed_set: { key: seedSet.key, bytes: seedSet.bytes,
                               publicly_fetchable: isPubliclyFetchable() } };
}

module.exports = { check, status, submit, fingerprint, keptSet, latestEmbedJob, TrainingRefused };
