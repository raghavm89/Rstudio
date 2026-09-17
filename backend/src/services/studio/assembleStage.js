"use strict";

const pool = require("../../config/db");
const JobUpload = require("./jobUpload");
const { createStorage } = require("./storageFactory");
const { runFfmpeg, stitchSegments } = require("./ffmpeg");

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
    const stitchSeg = deps.stitchSegments || stitchSegments;

    // Pull inputs from THIS assemble's own dependencies (frame order = id order),
    // not every motion/voice job in the project — otherwise a re-animate ("new
    // take") would stitch the old take's clips together with the new ones.
    const client = await pool.connect();
    let clips, voice, motionRows, voiceRowsAll, lipRowsAll;
    try {
      const deps2 = Array.isArray(job.depends_on) ? job.depends_on : [];
      const { rows: motion } = await client.query(
        `SELECT id, shot_id, result FROM render_jobs
          WHERE id = ANY($1::int[]) AND stage = 'motion' AND status = 'done'
          ORDER BY id`,
        [deps2]
      );
      motionRows = motion;
      clips = motion.map((m) => firstAssetKey(m.result));
      const { rows: voiceRows } = await client.query(
        `SELECT id, shot_id, result FROM render_jobs
          WHERE id = ANY($1::int[]) AND stage = 'voice' AND status = 'done'
          ORDER BY id`,
        [deps2]
      );
      voiceRowsAll = voiceRows;
      voice = voiceRows[0] ? firstAssetKey(voiceRows[0].result) : null;
      // Per-shot relipped clips (Phase 2b), if any — each carries its own audio.
      const { rows: lipRows } = await client.query(
        `SELECT id, shot_id, result FROM render_jobs
          WHERE id = ANY($1::int[]) AND stage = 'lipsync' AND status = 'done'
          ORDER BY id`,
        [deps2]
      );
      lipRowsAll = lipRows;
    } finally {
      client.release();
    }

    // ── Per-shot dialogue (Phase 2a) ───────────────────────────────────────
    // If the voice jobs are per-shot (they carry a shot_id), each clip gets its
    // OWN line muxed onto it and the segments are concatenated — a multi-speaker
    // reel where each character is heard over their own shot.
    const perShotVoice = (voiceRowsAll || []).some((v) => v.shot_id != null);
    const perShotLip = (lipRowsAll || []).some((l) => l.shot_id != null);
    if (perShotVoice || perShotLip) {
      const toUrl = (k) => (k && /^https?:\/\//i.test(k) ? k : (k ? storage.readUrl(k) : null));
      const voiceByShot = new Map();
      for (const v of (voiceRowsAll || [])) if (v.shot_id != null) voiceByShot.set(v.shot_id, firstAssetKey(v.result));
      const lipByShot = new Map();
      for (const l of (lipRowsAll || [])) if (l.shot_id != null) lipByShot.set(l.shot_id, firstAssetKey(l.result));
      // Per shot: prefer the RELIPPED clip (Phase 2b — lips move, audio already
      // baked in, so no voice mux); else the motion clip with its shot's line
      // muxed on (Phase 2a); else a silent motion clip.
      const segments = motionRows
        .map((m) => {
          const relip = lipByShot.get(m.shot_id);
          if (relip) return { clipUrl: toUrl(relip), voiceUrl: null };
          return { clipUrl: toUrl(firstAssetKey(m.result)), voiceUrl: toUrl(voiceByShot.get(m.shot_id) || null) };
        })
        .filter((seg) => seg.clipUrl);
      if (!segments.length) throw new AssembleError("No finished clips to assemble", { permanent: true });

      const buffer = await stitchSeg({ segments });
      if (!buffer || !buffer.length) throw new AssembleError("assemble produced an empty video", { permanent: false });

      const asset = await JobUpload.store(
        job,
        { filename: "reel.mp4", contentType: "video/mp4", fetch: async () => buffer },
        { kind: "reel" }
      );
      const reelUrl = asset.url || (asset.key ? storage.readUrl(asset.key) : null);
      const pl = job.payload || {};
      await pool.query(
        `INSERT INTO studio_assets
           (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, seconds, qc_status, selected)
         VALUES ($1,$2,$3,$4,$5,'reel',$6,'ffmpeg',$7,'passed',true)`,
        [job.tenant_id, job.project_id, job.shot_id || null, pl.avatar_id || null, pl.lora_id || null, reelUrl,
         (Number(pl.clip_seconds) || 5) * (segments.length || 1)]
      );
      return { video_key: asset.key || asset.url || null, segments: segments.length, perShot: true, bytes: buffer.length };
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
      await pool.query(
        `INSERT INTO studio_assets
           (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, seconds, qc_status, selected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'fal',$8,'passed',true)`,
        [job.tenant_id, job.project_id, job.shot_id || null, pl.avatar_id || null, pl.lora_id || null, (pl._lipsync ? 'clip' : 'reel'), reelUrl, pl.clip_seconds || null]
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

    // Record the stitched reel as a downloadable asset. JobUpload.store only
    // uploads the bytes; without this row the detail page (which lists
    // studio_assets) shows the stills but not the finished reel.
    const reelUrl = asset.url || (asset.key ? storage.readUrl(asset.key) : null);
    const pl = job.payload || {};
    await pool.query(
      `INSERT INTO studio_assets
         (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, seconds, qc_status, selected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ffmpeg',$8,'passed',true)`,
      [job.tenant_id, job.project_id, job.shot_id || null, pl.avatar_id || null, pl.lora_id || null, (pl._lipsync ? 'clip' : 'reel'), reelUrl,
       (Number(pl.clip_seconds) || 5) * (plan.clips.length || 1)]
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
