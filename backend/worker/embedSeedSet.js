'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeEmbedder } = require('./embedderFactory');

/**
 * Measuring the faces in a seed set.
 *
 * Its own module because two things run it and neither may have its own copy:
 * `worker/index.js` when a machine other than the API holds insightface, and
 * `src/services/studio/embedRunner.js` when the API's own machine does. Two
 * copies of a measurement is two answers to "is this one person", and the one
 * that is wrong is the one nobody re-reads.
 *
 * Lives under `worker/` rather than `src/services/` for the same reason
 * `stageKinds` has no requires: the render worker must not be able to reach the
 * database, so what it imports must not pull `config/db` in behind it. Nothing
 * here touches Postgres.
 */

/**
 * It measures and reports. It does not decide whether the set is good enough:
 * where that threshold sits is a product decision, and a runner that could
 * decide a set was fine is a runner that could approve spending $2.
 *
 * ── Two questions, one measurement ──────────────────────────────────────────
 * A SEED SET asks "is this one person, and may we train on it" — one unusable
 * frame is a reason to stop, because the answer is about the set as a whole and
 * the customer is about to pay to train on it. That is `strict`, and it is the
 * default.
 *
 * CALIBRATION asks "how far does this expression move the geometry" — and there
 * the unusable frames are the ordinary case rather than the exception. A full
 * shot where the face is forty pixels across, a profile the detector misses,
 * somebody walking through the background of a cafe: refusing the whole cell
 * for one of those throws away five good measurements and leaves the model
 * unactivatable for want of a sixth. `Calibration.recordCell` already knows
 * what to do with them — it skips structurally broken frames, keeps low scores,
 * and refuses only if fewer than five survive.
 *
 * So `strict: false` reports per frame instead of throwing, and the decision
 * stays where it was: with the service, not the runner.
 */
async function runEmbed(job) {
  const strict = job.payload?.strict !== false;
  const frames = job.payload?.frames || [];
  if (!frames.length) {
    throw Object.assign(new Error('Embed job carries no frames'), { permanent: true });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `embed-${job.id}-`));
  const embedder = makeEmbedder(job.payload?.subject_type);
  const embeddings = [];
  // Collected rather than thrown on the first one: if three of eighteen frames
  // are unusable somebody wants all three now, not to run this twice more
  // discovering them one at a time.
  const unusable = [];
  /**
   * One entry per INPUT frame, in input order, usable or not.
   *
   * Non-strict callers need the alignment: `recordCell` counts what it skipped
   * and says which, and a caller that only got the survivors cannot tell six
   * clean frames from twelve frames half of which failed. Strict callers get
   * this too, without the vectors — the same 512 floats in the job result twice
   * is a quarter of a megabyte of JSONB per training run for nothing.
   */
  const measured = [];

  try {
    await embedder.start();

    for (const frame of frames) {
      const res = await fetch(frame.url);
      if (!res.ok) throw new Error(`${frame.filename} → ${res.status} fetching the frame`);
      const file = path.join(dir, path.basename(frame.filename));
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

      const out = await embedder.embed(file);
      if (!Array.isArray(out.embedding)) {
        // A frame with no face comes back ok:true with a null embedding — the
        // embedder measures, it does not judge. A full-length shot where the
        // face is small, or a profile the detector misses, is a real case.
        unusable.push({ filename: frame.filename,
                        why: out.faces === 0 ? 'no face detected' : `no embedding (faces: ${out.faces ?? '?'})` });
        // `faces` is reported as a NUMBER even when the embedder said nothing,
        // because `recordCell` reads it to tell 'no_face' from
        // 'multiple_faces', and `undefined !== 1` would file every one of them
        // under the wrong reason.
        measured.push({ filename: frame.filename, faces: Number(out.faces || 0), embedding: null });
      } else if (out.faces > 1) {
        // Two faces means the model learns whichever the detector picked, and
        // the set's mean drifts toward somebody who is not them.
        unusable.push({ filename: frame.filename, why: `${out.faces} faces in frame` });
        measured.push({ filename: frame.filename, faces: Number(out.faces), embedding: null });
      } else {
        embeddings.push(out.embedding);
        measured.push({ filename: frame.filename, faces: 1,
                        embedding: strict ? null : out.embedding });
      }
      fs.unlinkSync(file);
    }
  } catch (err) {
    // Not permanent: a missing python, a cold model download or a dropped fetch
    // are all things that are different on the next attempt.
    throw new Error(`Face embedding failed: ${err.message}`);
  } finally {
    embedder.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (strict && unusable.length) {
    throw Object.assign(
      new Error(`${unusable.length} of ${frames.length} frames cannot go in a seed set: `
        + unusable.map((u) => `${u.filename} (${u.why})`).join(', ')),
      { permanent: true });
  }

  // Not even a non-strict caller can do anything with nothing, and letting it
  // through would report a cell of zero samples as a successful measurement.
  if (!strict && !embeddings.length) {
    throw Object.assign(
      new Error(`None of the ${frames.length} frames had a usable face: `
        + unusable.map((u) => `${u.filename} (${u.why})`).join(', ')),
      { permanent: true });
  }

  return {
    ok: true,
    result: { embeddings, count: embeddings.length, frames: measured, unusable, strict,
              set_fingerprint: job.payload.set_fingerprint },
    megapixels: 0,
    seconds_generated: 0,
    // Nobody charges for this. It costs the electricity of whatever laptop ran
    // it, and reporting a number here would put a fiction in the cost table the
    // self-hosting decision is read out of.
    cost_cents: 0,
  };
}

module.exports = { runEmbed };
