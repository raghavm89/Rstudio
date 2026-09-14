'use strict';

const pool         = require('../../config/db');
const RenderJob    = require('../../models/renderJob');
const StudioUsage  = require('../../models/studioUsage');
const RunnerPolicy = require('./runnerPolicy');
const { creditCostFor } = require('./creditCost');

/**
 * The one click.
 *
 * Takes a brief and writes the whole plan — project, scene, shots, and every
 * render job with its dependencies — in ONE transaction. Either the customer
 * gets a complete plan with quota reserved, or they get an error and nothing
 * happened. There is no half-created shoot.
 *
 * Declaring the graph up front rather than chaining stage-by-stage is what lets
 * the progress view show nine steps with seven still to come, instead of one
 * spinner. A failure then reads as "stage 4 of 9 — frame 3" rather than "it
 * stopped".
 *
 * The plan for a reel with N frames:
 *
 *   prompt ──┬─ still#1 ─ qc#1 ─┬─ motion#1 ─┐
 *            ├─ still#2 ─ qc#2 ─┼─ motion#2 ─┼─ assemble ─ copy
 *            └─ still#N ─ qc#N ─┴─ motion#N ─┘
 *
 * Stills fan out because they are independent and a worker can take them in any
 * order. Assemble fans in because a reel is not a reel until every clip exists.
 */

const QUALITY_BY_PLAN = { free: '1mp', paid: '2mp' };

/** Free tier gets one candidate; paid gets four and picks the best by QC score. */
const CANDIDATES = { free: 1, paid: 4 };

const SECONDS_PER_CLIP = 5;

function planFor({ kind, frameCount, clipSeconds, intent = 'cloud', resolution = '480p', wantsVoice = false }) {
  const stages = [];
  let step = 0;
  // Runners come from the licence policy, not from literals here. See
  // runnerPolicy.js — stills default to cloud because dev weights are
  // non-commercial and every shoot is intended to be published.
  const runner = (stage) => RunnerPolicy.runnerFor(stage, { intent });

  stages.push({ key: 'prompt', stage: 'prompt', runner: runner('prompt'), label: 'Working out the shots', step: step++ });

  for (let i = 1; i <= frameCount; i += 1) {
    stages.push({ key: `still:${i}`, stage: 'still', runner: runner('still'), after: ['prompt'], label: `Photo ${i}`, step: step,
      meter: { metric: 'credits', amount: creditCostFor({ stage: 'still' }) } });
    stages.push({ key: `qc:${i}`, stage: 'qc', runner: runner('qc'), after: [`still:${i}`], label: `Checking photo ${i}`, step: step });
  }
  step += 1;

  if (kind === 'reel' || kind === 'short' || kind === 'longform') {
    for (let i = 1; i <= frameCount; i += 1) {
      stages.push({
        key: `motion:${i}`, stage: 'motion', runner: runner('motion'), after: [`qc:${i}`],
        label: `Bringing photo ${i} to life`, step,
        // Seconds drive the render; credits drive the wallet. A generative reel
        // is priced per second (creditCost.js), so a clip's credits are its
        // seconds at the resolution's rate — the parts sum to the 30s anchor.
        seconds: clipSeconds,
        meter: { metric: 'credits', amount: creditCostFor({ stage: 'motion', seconds: clipSeconds, resolution }) },
      });
    }
    step += 1;

    // A voiceover is opt-in (see createShoot). Without one the reel is a silent
    // clip — a visual reel should not fail on a voice stage nobody asked for.
    if (wantsVoice) {
      stages.push({ key: 'voice', stage: 'voice', runner: runner('voice'), after: ['prompt'], label: 'Recording the voice', step: step++ });
    }

    stages.push({
      key: 'assemble', stage: 'assemble', runner: runner('assemble'), label: 'Putting it together', step: step++,
      after: [...Array.from({ length: frameCount }, (_, i) => `motion:${i + 1}`), ...(wantsVoice ? ['voice'] : [])],
    });
  }

  const copyAfter = (kind === 'reel' || kind === 'short' || kind === 'longform')
    ? ['assemble']
    : Array.from({ length: frameCount }, (_, i) => `qc:${i + 1}`);

  stages.push({ key: 'copy', stage: 'copy', runner: runner('copy'), after: copyAfter, label: 'Writing the caption', step: step++ });

  return { stages, stepTotal: step };
}

const Orchestrator = {
  planFor,

  /**
   * Create a shoot.
   *
   * @param {object} input
   * @param {number} input.tenantId
   * @param {number} input.avatarId
   * @param {string} input.kind          post | carousel | reel | short | longform
   * @param {number} input.frameCount
   * @param {object} input.brief         concept, hook, caption angle
   * @param {Array}  input.shots         one entry per frame — picker selections
   * @param {string} input.tier          'free' | 'paid'
   * @param {string} input.idempotencyKey  a retried click must not double-spend
   */
  async createShoot({
    tenantId, avatarId, userId = null, kind = 'post', frameCount = 4,
    brief = {}, shots = [], scene = {}, scenes = null, tier = 'free',
    clipSeconds = SECONDS_PER_CLIP, idempotencyKey = null, intent = 'cloud',
    resolution = '480p', reviewStills = null,
  }) {
    if (!tenantId) throw Object.assign(new Error('tenantId is required'), { status: 400 });
    if (!avatarId) throw Object.assign(new Error('avatarId is required'), { status: 400 });
    // A shoot bound to a publishing slot cannot claim to be local-only R&D.
    RunnerPolicy.assertIntentAllowed(intent, { willPublish: Boolean(brief.slot_type) });

    // Normalize to a list of SCENES, each with its own shots. A multi-location
    // reel passes scenes[]; the flat scene+shots form (templates, tests) is
    // wrapped as one scene. Total shots drive the DAG and the cost, so cap them.
    const MAX_SHOTS = 10;
    let sceneList;
    if (Array.isArray(scenes) && scenes.length) {
      sceneList = scenes.map((sc) => ({ ...sc, shots: Array.isArray(sc.shots) ? sc.shots : [] }));
    } else {
      // Flat / back-compat path (templates, direct create). Honor frameCount so a
      // call with a frame count but no explicit shots still gets that many.
      const flat = Array.isArray(shots) ? shots.slice() : [];
      const want = Math.max(1, Number(frameCount) || 1);
      while (flat.length < want) flat.push({});
      sceneList = [{ location_key: scene.location_key, time_of_day: scene.time_of_day, continuity: scene.continuity, shots: flat }];
    }
    if (!sceneList.reduce((n, sc) => n + sc.shots.length, 0)) {
      sceneList = [{ ...(sceneList[0] || {}), shots: [{}] }];   // always at least one shot
    }
    {
      let budget = MAX_SHOTS; const trimmed = [];
      for (const sc of sceneList) {
        if (budget <= 0) break;
        const take = sc.shots.slice(0, budget);
        if (!take.length) continue;
        trimmed.push({ ...sc, shots: take });
        budget -= take.length;
      }
      sceneList = trimmed;
    }
    const frameTotal = sceneList.reduce((n, sc) => n + sc.shots.length, 0);

    const quality    = QUALITY_BY_PLAN[tier] || '1mp';
    const candidates = CANDIDATES[tier] || 1;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // An avatar cannot generate until it is real: an active LoRA, a look
      // profile, and — for a twin or reference persona — a verified consent
      // record. Checked here rather than at the worker, so the refusal arrives
      // before quota is spent.
      const { rows: avatarRows } = await client.query(
        `SELECT a.*, l.id AS lora_id, lp.avatar_id AS has_look_profile,
                sp.avatar_id AS has_style_profile, c.verified AS consent_verified
           FROM avatars a
           LEFT JOIN avatar_loras   l  ON l.avatar_id = a.id AND l.active
           LEFT JOIN look_profiles  lp ON lp.avatar_id = a.id
           LEFT JOIN style_profiles sp ON sp.avatar_id = a.id
           LEFT JOIN consent_records c ON c.id = a.consent_record_id
          WHERE a.id = $1 AND (
                  a.tenant_id = $2
               OR (a.is_catalogue AND EXISTS (
                    SELECT 1 FROM catalogue_selections s
                     WHERE s.avatar_id = a.id AND s.tenant_id = $2))
                )`,
        [avatarId, tenantId]
      );
      const avatar = avatarRows[0];
      if (!avatar) throw Object.assign(new Error('Avatar not found'), { status: 404 });
      if (!avatar.lora_id) throw Object.assign(new Error('This avatar has no trained model yet'), { status: 409 });
      // A character is set up when it has a STYLE profile; a person a look profile.
      const hasProfile = avatar.subject_type === 'character' ? avatar.has_style_profile : avatar.has_look_profile;
      if (!hasProfile) {
        const which = avatar.subject_type === 'character' ? 'style' : 'look';
        throw Object.assign(new Error(`This avatar has no ${which} profile yet`), { status: 409 });
      }
      if (avatar.mode !== 'synthetic' && !avatar.consent_verified) {
        throw Object.assign(
          new Error('This avatar depicts a real person and has no verified consent record'),
          { status: 403 }
        );
      }

      // A voiceover is opt-in: scheduled only when the brief carries an explicit
      // spoken line AND the avatar has a locked voice AND a TTS provider is
      // configured. A visual reel ("Ganesh Chaturthi glow up") has a concept but
      // no intended narration — it stays a silent clip rather than failing on a
      // voice stage. The concept/hook are NOT treated as a spoken line.
      const spokenLine = brief && (brief.script || brief.voiceover);
      const wantsVoice = Boolean(
        spokenLine && String(spokenLine).trim() &&
        avatar.voice_id &&
        (avatar.voice_provider || 'elevenlabs') === 'elevenlabs' &&
        process.env.ELEVENLABS_API_KEY
      );
      const { stages, stepTotal } = planFor({ kind, frameCount: frameTotal, clipSeconds, intent, resolution, wantsVoice });

      // ── Vocabulary clamp ─────────────────────────────────────────────────
      // Every shoot passes through here, so this is where a shot/scene value is
      // forced to be one the vocabulary defines. A stale template or an
      // out-of-date picker cannot inject an option the prompt stage rejects
      // (this is exactly how "light_direction.backlit" reached the renderer).
      const verRes = await client.query(
        `SELECT COALESCE(
           (SELECT vocabulary_version FROM look_profiles  WHERE avatar_id = $1 LIMIT 1),
           (SELECT vocabulary_version FROM style_profiles WHERE avatar_id = $1 LIMIT 1)) AS v`,
        [avatarId]
      );
      const vocabVersion = verRes.rows[0] && verRes.rows[0].v;
      const { rows: vocabRows } = await client.query(
        'SELECT facet, option_key FROM prompt_vocabulary WHERE active AND version = $1',
        [vocabVersion]
      );
      const vocabByFacet = {};
      for (const r of vocabRows) (vocabByFacet[r.facet] = vocabByFacet[r.facet] || new Set()).add(r.option_key);
      const clampVocab = (facet, val, fallback) =>
        (val && vocabByFacet[facet] && vocabByFacet[facet].has(val)) ? val : fallback;

      // ── The content graph ──────────────────────────────────────────────────
      const { rows: [project] } = await client.query(
        `INSERT INTO studio_projects (tenant_id, avatar_id, title, kind, slot_type, brief, trend_source, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'generating',$8) RETURNING *`,
        [tenantId, avatarId, brief.title || '', kind, brief.slot_type || null,
         JSON.stringify(brief), brief.trend_source || 'manual', userId]
      );

      // One studio_scene per scene (its own location / wardrobe / time), with its
      // shots flattened under them in order. Shot `seq` is GLOBAL across the reel
      // so the stitch order is stable and filenames never collide between scenes.
      const shotRows = [];
      let firstSceneId = null;
      let sceneSeq = 0;
      for (const sc of sceneList) {
        sceneSeq += 1;
        const { rows: [sceneRow] } = await client.query(
          `INSERT INTO studio_scenes (project_id, seq, location_key, time_of_day, continuity)
           VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
          [project.id, sceneSeq, sc.location_key || null, clampVocab('time_of_day', sc.time_of_day, 'afternoon'),
           JSON.stringify(sc.continuity || {})]
        );
        if (!firstSceneId) firstSceneId = sceneRow.id;
        for (const rawShot of sc.shots) {
          const s = rawShot || {};
          const { rows: [shot] } = await client.query(
            `INSERT INTO studio_shots
               (scene_id, seq, framing, light_direction, light_quality,
                expression_key, expression_intensity, wardrobe_key, pose_key,
                duration_seconds, advanced_append)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [sceneRow.id, shotRows.length + 1,
             clampVocab('framing', s.framing, 'medium'), clampVocab('light_direction', s.light_direction, 'camera_left'), clampVocab('light_quality', s.light_quality, 'soft'),
             clampVocab('expression', s.expression_key, 'neutral'), s.expression_intensity || 'medium',
             s.wardrobe_key || null, s.pose_key || null,
             kind === 'post' || kind === 'carousel' ? null : clipSeconds,
             s.advanced_append || null]
          );
          // v1 writes exactly one character per shot. Two rows here means a
          // two-shot: expensive, fragile, and QC'd per face.
          await client.query(
            `INSERT INTO studio_shot_characters (shot_id, avatar_id, lora_id, role)
             VALUES ($1,$2,$3,'subject')`,
            [shot.id, avatarId, avatar.lora_id]
          );
          shotRows.push(shot);
        }
      }

      // ── Quota, before any job exists ───────────────────────────────────────
      // One wallet, one currency. Every rendered piece costs credits per the
      // rate card (creditCost.js), carried on its stage's `meter`. The whole
      // shoot is reserved in one atomic call — reserving per stage would let a
      // shoot get half-queued and then refused, leaving orphan jobs and a
      // partially-spent wallet.
      const creditStages = stages.filter((s) => s.meter?.metric === 'credits');
      const totalCredits = creditStages.reduce((n, s) => n + Number(s.meter.amount || 0), 0);
      const creditTake = totalCredits
        ? await StudioUsage.reserve(client, tenantId, 'credits', totalCredits)
        : null;

      /**
       * Spread any purchased credits across the jobs that will settle them.
       *
       * The reservation above is taken for the whole shoot at once — deliberately,
       * so a shoot cannot get half-queued and then refused. But settlement
       * happens per job, and a job refunds only what its own payload says it
       * spent. Without this, a shoot that dipped into bought credits and then
       * had a piece fail would keep that piece's share of the purchase.
       *
       * Proportional to each job's own credit cost, so the parts sum to the
       * whole and no job can refund more than its share.
       */
      const purchasedCredits = Number(creditTake?.from_credits || 0);
      const shareOfCredits = (amount) => {
        if (!purchasedCredits || !totalCredits) return 0;
        return Math.round((purchasedCredits * (Number(amount) / totalCredits)) * 100) / 100;
      };

      // ── Gate 2: hold the expensive stages for review ──────────────────────
      // For a motion shoot with the stills-review gate on, everything downstream
      // of QC (motion, voice, assemble, copy) is created HELD, not queued — so
      // the stills render and the pipeline STOPS. The user reviews the frames and
      // approves; POST /shoots/:id/approve flips the held jobs to queued and the
      // video renders. Nothing expensive runs (and motion never settles a charge)
      // until a human has seen the stills.
      const isMotionKind = kind === 'reel' || kind === 'short' || kind === 'longform';
      const gate = reviewStills === null ? isMotionKind : Boolean(reviewStills);
      const HELD_STAGES = new Set(['motion', 'voice', 'assemble', 'copy']);

      // ── The job graph ──────────────────────────────────────────────────────
      const byKey = new Map();
      for (const spec of stages) {
        const shotIndex = spec.key.includes(':') ? Number(spec.key.split(':')[1]) : null;
        const shot = shotIndex ? shotRows[shotIndex - 1] : null;

        const job = await RenderJob.enqueueTx(client, {
          tenant_id: tenantId,
          project_id: project.id,
          shot_id: shot ? shot.id : null,
          stage: spec.stage,
          runner: spec.runner,
          priority: tier === 'paid' ? 50 : 100,
          depends_on: (spec.after || []).map((k) => byKey.get(k)).filter(Boolean),
          step_index: spec.step,
          step_total: stepTotal,
          label: spec.label,
          status: (gate && HELD_STAGES.has(spec.stage)) ? 'held' : 'queued',
          payload: {
            avatar_id: avatarId,
            lora_id: avatar.lora_id,
            scene_id: shot ? shot.scene_id : firstSceneId,
            subject_type: avatar.subject_type,
            quality,
            candidates,
            clip_seconds: spec.seconds ?? null,
            resolution,
            _reserved: spec.meter?.metric === 'credits' ? Number(spec.meter.amount || 0) : 0,
            _from_credits: spec.meter?.metric === 'credits' ? shareOfCredits(spec.meter.amount) : 0,
          },
          idempotency_key: idempotencyKey ? `${idempotencyKey}:${spec.key}` : null,
        });
        byKey.set(spec.key, job.id);
      }

      await client.query('COMMIT');

      return {
        project,
        scene_id: firstSceneId,
        scene_count: sceneSeq,
        shots: shotRows,
        job_count: byKey.size,
        step_total: stepTotal,
        reserved: { credits: totalCredits },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * What the progress view renders.
   *
   * Grouped by step so nine jobs across four steps read as four rows, and a step
   * is only "done" when every job in it is.
   */
  async progress(tenantId, projectId) {
    const { rows } = await pool.query(
      `SELECT step_index, step_total, label,
              COUNT(*)::int                                        AS total,
              COUNT(*) FILTER (WHERE status = 'done')::int         AS done,
              COUNT(*) FILTER (WHERE status = 'failed')::int       AS failed,
              COUNT(*) FILTER (WHERE status = 'blocked')::int      AS blocked,
              COUNT(*) FILTER (WHERE status = 'held')::int          AS held,
              COUNT(*) FILTER (WHERE status IN ('claimed','running'))::int AS running,
              MIN(step_index)                                      AS ord
         FROM render_jobs
        WHERE tenant_id = $1 AND project_id = $2
        GROUP BY step_index, step_total, label
        ORDER BY ord, label`,
      [tenantId, projectId]
    );

    const steps = rows.map((r) => ({
      step: r.step_index,
      label: r.label,
      total: r.total,
      done: r.done,
      failed: r.failed,
      blocked: r.blocked,
      held: r.held,
      running: r.running,
      status: r.failed ? 'failed'
        : r.blocked ? 'blocked'
        : r.done === r.total ? 'done'
        : r.held ? 'held'
        : r.running ? 'running'
        : 'waiting',
    }));

    const totals = steps.reduce((acc, s) => ({
      done: acc.done + s.done, total: acc.total + s.total,
      failed: acc.failed + s.failed, blocked: acc.blocked + s.blocked,
      held: acc.held + s.held,
    }), { done: 0, total: 0, failed: 0, blocked: 0, held: 0 });

    // At the review gate: every non-held job is done and held jobs remain, so the
    // shoot is waiting on the user, not on a worker.
    const atGate = totals.held > 0 && (totals.done + totals.held) === totals.total;

    return {
      steps,
      ...totals,
      percent: totals.total ? Math.round((totals.done / totals.total) * 100) : 0,
      status: totals.failed ? 'failed'
        : (totals.done === totals.total && totals.total) ? 'done'
        : atGate ? 'review'
        : 'running',
    };
  },
};

module.exports = Orchestrator;
