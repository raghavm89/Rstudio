'use strict';

const pool        = require('../../config/db');
const RenderJob   = require('../../models/renderJob');
const Calibration = require('./calibration');
const { createStorage } = require('./storageFactory');

/**
 * What happens after a calibration frame lands.
 *
 * Calibration is three steps — generate, embed, record — and something has to
 * carry it from one to the next. The obvious place is a read: have the screen
 * poll, notice the frames are done, and post the next request. That is how the
 * seed set worked and it is wrong here for a reason worth writing down:
 *
 *   A CHAIN DRIVEN BY A READ ONLY ADVANCES WHILE SOMEBODY IS WATCHING.
 *
 * Forty-two frames take minutes. The customer closes the tab, and the run stops
 * between step one and step two — not failed, not queued, just nothing, which
 * is the state that reads as "it's been 33 minutes and still training". The
 * chain has to be driven by the thing that actually knows a step finished, and
 * that is settlement.
 *
 * So this is called from `jobResult.recordArtefacts`, alongside the candidate
 * insert and the LoRA row, and for the same reason they are there: a job
 * finishing is not the same as its result being recorded.
 *
 * ── The unit is the cell, not the run ───────────────────────────────────────
 * `Calibration.recordCell` measures one (preset, framing) and needs all its
 * samples at once — the spread across them IS the measurement. So the trigger
 * is "every frame of this cell has settled", not "every frame of this run",
 * which would make one slow cell hold up the other six for no reason and turn
 * one bad cell into a run that measures nothing.
 */

/** Frames that failed permanently are not waited for — they are never coming. */
const SETTLED = ['done', 'failed', 'cancelled'];

/**
 * A calibration frame settled. Is its cell finished, and if so, measure it.
 *
 * Returns the embed job when it queued one, null otherwise. Never throws: it is
 * called from the path that has already completed a job, and a failure to
 * advance must not roll that completion back and hand the same frame out to be
 * paid for twice.
 */
async function afterFrame(job) {
  const p = job.payload || {};
  const loraId = Number(p.lora_id);
  const presetKey = p.preset_key;
  const framing = p.framing;
  if (!loraId || !presetKey || !framing) return null;

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, status, result
         FROM render_jobs
        WHERE stage = 'calib_still'
          AND payload->>'lora_id'    = $1
          AND payload->>'preset_key' = $2
          AND payload->>'framing'    = $3
        ORDER BY (payload->>'sample')::int`,
      [String(loraId), presetKey, framing]
    );

    const pending = rows.filter((r) => !SETTLED.includes(r.status));
    if (pending.length) return null;

    const storage = createStorage();
    const frames = [];
    for (const r of rows) {
      if (r.status !== 'done') continue;
      const asset = (r.result?.assets || [])[0];
      // A frame with no storage key is a file on whichever machine rendered it,
      // which the embedder — on a different machine by design — cannot fetch.
      if (!asset?.key) continue;
      frames.push({ filename: asset.filename || `job-${r.id}.png`,
                    url: storage.readUrl(asset.key), storage_key: asset.key });
    }

    if (frames.length < Calibration.MIN_SAMPLES) {
      // Measuring four frames would produce a tolerance from noise and then
      // gate every future render with it. Leaving the cell unmeasured is the
      // safe outcome: readiness still lists it as missing and the screen can
      // offer to generate more.
      console.warn(
        `[calibration] ${presetKey}/${framing} on LoRA ${loraId}: only ${frames.length} of `
        + `${rows.length} frames are usable — need ${Calibration.MIN_SAMPLES}, leaving the cell unmeasured`);
      return null;
    }

    const embed = await RenderJob.enqueueTx(client, {
      tenant_id: job.tenant_id,
      stage: 'embed',
      // insightface on real hardware, same as the seed-set check. The API host
      // cannot be assumed to have Python and a model cache.
      runner: 'mac',
      provider: 'local',
      priority: 60,
      label: `Measuring ${presetKey} ${framing}`,
      payload: {
        avatar_id: Number(p.avatar_id) || null,
        lora_id: loraId,
        preset_key: presetKey,
        framing,
        // The flag that makes this a measurement rather than a gate. A seed set
        // refuses if any frame is unusable; a calibration cell expects some to
        // be — a wide shot the detector misses is ordinary, not a failure.
        strict: false,
        // What makes the completion handler recognise its own job. Read off the
        // payload rather than inferred from the presence of `preset_key`,
        // because inference is how an unrelated embed job ends up written into
        // somebody's baselines.
        calibration: true,
        count: frames.length,
        frames,
      },
      // The cell, so two frames of it settling at the same instant queue one
      // measurement rather than two.
      idempotency_key: `calibembed:${loraId}:${presetKey}:${framing}`,
    });

    return embed;
  } catch (err) {
    console.error(`[calibration] could not advance ${presetKey}/${framing}: ${err.message}`);
    return null;
  } finally {
    client.release();
  }
}

/**
 * The embedder answered. Turn the spread into a baseline.
 *
 * `recordCell` owns the judgement — which frames count, how wide the tolerance
 * is, and whether there were enough of them. This only hands it the samples and
 * writes down what it said, including when what it said was no.
 */
async function afterEmbed(job) {
  const p = job.payload || {};
  if (!p.calibration) return null;

  const samples = job.result?.frames;
  if (!Array.isArray(samples)) {
    await note(job.id, { error: 'the embedder returned no per-frame results' });
    console.error(`[calibration] embed job ${job.id} has no per-frame results — was strict:false set?`);
    return null;
  }

  try {
    const out = await Calibration.recordCell({
      tenantId: job.tenant_id,
      loraId: Number(p.lora_id),
      presetKey: p.preset_key,
      framing: p.framing,
      samples,
    });
    await note(job.id, {
      preset_key: p.preset_key, framing: p.framing,
      used: out.used, skipped: out.skipped.length, spread: out.spread,
      expected: Number(out.baseline.expected_similarity), tolerance: Number(out.baseline.tolerance),
    });
    console.log(
      `[calibration] ${p.preset_key}/${p.framing}: ${out.used} samples, `
      + `expected ${Number(out.baseline.expected_similarity).toFixed(3)} `
      + `±${Number(out.baseline.tolerance).toFixed(3)}`);
    return out;
  } catch (err) {
    // Recorded ON THE JOB rather than only logged. A cell that could not be
    // measured is the difference between "still working" and "this one needs
    // more frames", and a screen that can only see readiness cannot tell them
    // apart — which is exactly the shape of every "queued but nothing is
    // happening" report so far.
    await note(job.id, { preset_key: p.preset_key, framing: p.framing,
                         error: err.message, code: err.code || null });
    console.error(`[calibration] ${p.preset_key}/${p.framing} not measured: ${err.message}`);
    return null;
  }
}

/** Write the outcome onto the job, without disturbing what the runner reported. */
async function note(jobId, calibration) {
  try {
    await pool.query(
      `UPDATE render_jobs SET result = result || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [jobId, JSON.stringify({ calibration })]
    );
  } catch (err) {
    console.error(`[calibration] could not annotate job ${jobId}: ${err.message}`);
  }
}

module.exports = { afterFrame, afterEmbed, SETTLED };
