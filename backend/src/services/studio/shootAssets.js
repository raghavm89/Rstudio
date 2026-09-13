"use strict";

const { createStorage } = require("./storageFactory");

/**
 * What a finished SHOOT still leaves behind, and how the motion stage gets its
 * input.
 *
 * A still job renders one or more candidate frames. Two things have to happen
 * when it finishes, and neither did before:
 *
 *   1. The frames become `studio_assets` rows. Without this the bytes sit in
 *      storage, the money is spent, and nothing downstream — QC, the library,
 *      publishing — can find them. This mirrors what `recordArtefacts` already
 *      does for seed frames and trained LoRAs.
 *
 *   2. A frame is handed to this shot's MOTION job as `generation.image_url`,
 *      so the image-to-video stage has something to animate. Motion reads
 *      `gen.image_url`; nothing was ever writing it, so a video shoot stalled
 *      the moment the stills were done.
 *
 * Frames are recorded as `qc_status = 'pending'` and NONE is marked `selected`:
 * choosing the best candidate is the QC stage's job, not this one. Until QC
 * runs, the FIRST candidate is used as the motion input — a functional default,
 * not a quality judgement. When the QC stage lands it will set `selected` and
 * re-point the motion input at the chosen frame.
 */

/** The storage key (or url) of a stored asset. */
function assetKey(a) {
  return (a && (a.key || a.url)) || null;
}

async function recordStillAndFeedMotion(client, { existing, done, result }) {
  const p = existing.payload || {};
  const gen = p.generation || {};
  const assets = Array.isArray(result.assets) ? result.assets : [];
  if (!assets.length) {
    console.error(`[job ${done.id}] still reported no asset — nothing recorded, motion left without an image`);
    return { assets: 0, motionFed: false };
  }

  const storage = createStorage();
  const tenantId = existing.tenant_id ?? done.tenant_id;
  const projectId = existing.project_id ?? done.project_id;
  const shotId = existing.shot_id ?? null;
  const perCandidateCost = Math.round(Number(done.cost_cents || 0) / assets.length);

  const urls = [];
  for (let i = 0; i < assets.length; i += 1) {
    const key = assetKey(assets[i]);
    const url = key ? storage.readUrl(key) : null;
    urls.push(url);
    await client.query(
      `INSERT INTO studio_assets
         (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, prompt,
          seed, provider, model, width, height, megapixels, cost_cents, candidate_index,
          qc_status, selected)
       VALUES ($1,$2,$3,$4,$5,'still',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',false)`,
      [
        tenantId, projectId, shotId, p.avatar_id || null, p.lora_id || null,
        url, gen.prompt || null,
        result.seed ?? gen.seed ?? null,
        result.provider || "fal", result.model || null,
        gen.width || null, gen.height || null,
        Number(done.megapixels || gen.megapixels || 0) || null,
        perCandidateCost, i,
      ]
    );
  }

  // Hand the first frame to this shot's motion job so image-to-video has an
  // input. Only for video kinds — a photo post has no motion job, and this is a
  // no-op there.
  let motionFed = false;
  const image = urls[0];
  if (image && shotId) {
    const { rows: motion } = await client.query(
      `SELECT id, payload FROM render_jobs
        WHERE project_id = $1 AND stage = 'motion' AND shot_id = $2
        ORDER BY id LIMIT 1`,
      [projectId, shotId]
    );
    if (motion[0]) {
      const g = { ...(motion[0].payload?.generation || {}), image_url: image };
      await client.query(
        `UPDATE render_jobs
            SET payload = jsonb_set(payload, '{generation}', $2::jsonb, true), updated_at = NOW()
          WHERE id = $1`,
        [motion[0].id, JSON.stringify(g)]
      );
      motionFed = true;
    }
  }

  return { assets: assets.length, motionFed };
}

module.exports = { recordStillAndFeedMotion, assetKey };
