"use strict";

const pool = require("../../config/db");
const JobUpload = require("./jobUpload");
const { createStorage } = require("./storageFactory");
const { runFfmpeg } = require("./ffmpeg");

/**
 * The `assemble` stage — stitch a shoot's motion clips (and voiceover) into one
 * finished video.
 *
 * Runs on the server runner (it needs the database and tenant content, which a
 * render worker is deliberately not trusted with). It PULLS its inputs from the
 * completed dependency jobs rather than having them pushed onto its payload:
 * the motion clips are `result.assets` on the finished motion jobs, the
 * voiceover is the finished voice job. depends_on already guarantees they are
 * done before this runs.
 *
 * One clip and no voiceover is a passthrough — the clip already IS the
 * deliverable, so re-encoding it would spend CPU to make an identical file.
 * Anything else goes through ffmpeg (isolated in ./ffmpeg so this logic stays
 * testable).
 */

class AssembleError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "AssembleError";
    this.permanent = permanent;
  }
}

/** The storage key (or url) of a finished job's first asset, or null. */
function firstAssetKey(result) {
  const a = (result && Array.isArray(result.assets) && result.assets[0]) || null;
  return a ? (a.key || a.url || null) : null;
}

/**
 * Decide what assembling these inputs means. Pure, so it is unit-tested without
 * a database or ffmpeg.
 * @returns {{mode:'passthrough'|'stitch', clips:string[], voice:string|null}}
 */
function decideAssembly({ clips, voice }) {
  const list = (clips || []).filter(Boolean);
  const v = voice || null;
  if (!list.length) {
    const e = new AssembleError("No finished clips to assemble", { permanent: true });
    throw e;
  }
  if (list.length === 1 && !v) return { mode: "passthrough", clips: list, voice: null };
  return { mode: "stitch", clips: list, voice: v };
}

const AssembleStage = {
  AssembleError,
  firstAssetKey,
  decideAssembly,

  async execute(job, deps = {}) {
    if (job.stage !== "assemble") {
      throw new AssembleError(`Not an assemble job: stage is "${job.stage}"`, { permanent: true });
    }
    const storage = deps.storage || createStorage();
    const stitch = deps.stitch || runFfmpeg;

    // Pull inputs from the finished dependency jobs (frame order = id order).
    const client = await pool.connect();
    let clips, voice;
    try {
      const { rows: motion } = await client.query(
        `SELECT result FROM render_jobs
          WHERE project_id = $1 AND stage = 'motion' AND status = 'done'
          ORDER BY id`,
        [job.project_id]
      );
      clips = motion.map((m) => firstAssetKey(m.result));
      const { rows: voiceRows } = await client.query(
        `SELECT result FROM render_jobs
          WHERE project_id = $1 AND stage = 'voice' AND status = 'done'
          ORDER BY id LIMIT 1`,
        [job.project_id]
      );
      voice = voiceRows[0] ? firstAssetKey(voiceRows[0].result) : null;
    } finally {
      client.release();
    }

    const plan = decideAssembly({ clips, voice });

    if (plan.mode === "passthrough") {
      // The single clip IS the finished reel — no re-encode. But it must still be
      // recorded as a downloadable `reel` asset: the detail page lists
      // studio_assets, so without this row the reel has nowhere to download from
      // (only the still shows). Point the asset at the clip already in storage.
      const clipKey = plan.clips[0];
      const reelUrl = /^https?:\/\//i.test(clipKey) ? clipKey : storage.readUrl(clipKey);
      const pl = job.payload || {};
      await pool.query(`DELETE FROM studio_assets WHERE project_id = $1 AND kind = 'reel'`, [job.project_id]);
      await pool.query(
        `INSERT INTO studio_assets
           (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, seconds, qc_status, selected)
         VALUES ($1,$2,$3,$4,$5,'reel',$6,'fal',$7,'passed',true)`,
        [job.tenant_id, job.project_id, job.shot_id || null, pl.avatar_id || null, pl.lora_id || null, reelUrl, pl.clip_seconds || null]
      );
      return { video_key: clipKey, clips: plan.clips, voice: null, passthrough: true };
    }

    const clipUrls = plan.clips.map((k) => storage.readUrl(k));
    const voiceUrl = plan.voice ? storage.readUrl(plan.voice) : null;
    const buffer = await stitch({ clipUrls, voiceUrl });
    if (!buffer || !buffer.length) {
      throw new AssembleError("assemble produced an empty video", { permanent: false });
    }

    const asset = await JobUpload.store(
      job,
      { filename: "reel.mp4", contentType: "video/mp4", fetch: async () => buffer },
      { kind: "reel" }
    );

    return {
      video_key: asset.key || asset.url || null,
      clips: plan.clips,
      voice: plan.voice,
      passthrough: false,
      bytes: buffer.length,
    };
  },
};

module.exports = AssembleStage;
