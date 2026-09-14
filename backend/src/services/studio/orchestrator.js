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

/**
 * Load a shoot that is paused at the Gate 2 review, or refuse. Shared by the
 * two reject paths (regenerate, replan): both need a held shoot that isn't
 * already mid-reshoot.
 */
async function loadHeldShoot(client, tenantId, projectId) {
  const { rows: pr } = await client.query(
    `SELECT p.id, p.kind, p.avatar_id, a.subject_type, l.id AS lora_id
       FROM studio_projects p
       JOIN avatars a ON a.id = p.avatar_id
       LEFT JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [projectId, tenantId]
  );
  const proj = pr[0];
  if (!proj) throw Object.assign(new Error('Shoot not found'), { status: 404 });
  const { rows: held } = await client.query(
    `SELECT 1 FROM render_jobs WHERE project_id = $1 AND tenant_id = $2 AND status = 'held' LIMIT 1`,
    [projectId, tenantId]
  );
  if (!held[0]) throw Object.assign(new Error('These stills are not waiting for review — nothing to change.'), { status: 409 });
  const { rows: busy } = await client.query(
    `SELECT 1 FROM render_jobs WHERE project_id = $1 AND status IN ('queued','claimed','running') LIMIT 1`,
    [projectId]
  );
  if (busy[0]) throw Object.assign(new Error('New frames are already on the way — give it a moment.'), { status: 409 });
  return proj;
}

/**
 * The closed-vocabulary clamp for an avatar — the same gate createShoot uses,
 * so a replanned shot can never inject an option the prompt stage would reject.
 */
async function loadVocabClamp(client, avatarId) {
  const verRes = await client.query(
    `SELECT COALESCE(
       (SELECT vocabulary_version FROM look_profiles  WHERE avatar_id = $1 LIMIT 1),
       (SELECT vocabulary_version FROM style_profiles WHERE avatar_id = $1 LIMIT 1)) AS v`,
    [avatarId]
  );
  const version = verRes.rows[0] && verRes.rows[0].v;
  const { rows } = await client.query(
    'SELECT facet, option_key FROM prompt_vocabulary WHERE active AND version = $1',
    [version]
  );
  const byFacet = {};
  for (const r of rows) (byFacet[r.facet] = byFacet[r.facet] || new Set()).add(r.option_key);
  return (facet, val, fallback) => (val && byFacet[facet] && byFacet[facet].has(val)) ? val : fallback;
}

/**
 * Supersede a shoot's current stills and enqueue a fresh prompt -> still -> qc
 * pass (new seeds) for every shot, holding the motion jobs where they are. The
 * shared core of both "regenerate stills" and "edit the plan" — the caller has
 * already loaded and gate-checked the shoot.
 */
async function enqueueFreshStillPass(client, { tenantId, projectId, proj }) {
  const { rows: shots } = await client.query(
    `SELECT sh.id AS shot_id, sh.seq, sh.scene_id
       FROM studio_shots sh
       JOIN studio_scenes sc ON sc.id = sh.scene_id
      WHERE sc.project_id = $1
      ORDER BY sh.seq`,
    [projectId]
  );
  if (!shots.length) throw Object.assign(new Error('This shoot has no shots'), { status: 409 });

  const { rows: pj } = await client.query(
    `SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'prompt' ORDER BY id DESC LIMIT 1`,
    [projectId]
  );
  const prev = (pj[0] && pj[0].payload) || {};
  const candidates = Math.max(1, Number(prev.candidates) || 1);
  const quality = prev.quality || '1mp';
  const resolution = prev.resolution || '480p';

  const perStill = creditCostFor({ stage: 'still' });
  const totalCredits = perStill * shots.length;
  if (totalCredits) await StudioUsage.reserve(client, tenantId, 'credits', totalCredits);

  await client.query(
    `UPDATE studio_assets SET qc_status = 'superseded', selected = false
      WHERE project_id = $1 AND kind = 'still'`,
    [projectId]
  );

  const { rows: mx } = await client.query('SELECT COALESCE(MAX(step_index), -1) AS m FROM render_jobs WHERE project_id = $1', [projectId]);
  let step = Number(mx[0].m) + 1;
  const runner = (stage) => RunnerPolicy.runnerFor(stage, { intent: 'cloud' });

  const promptJob = await RenderJob.enqueueTx(client, {
    tenant_id: tenantId, project_id: projectId, stage: 'prompt', runner: runner('prompt'),
    priority: 100, step_index: step, step_total: 0, label: 'Re-working the shots',
    payload: { avatar_id: proj.avatar_id, lora_id: proj.lora_id, quality, candidates, resolution },
  });
  step += 1;

  const newIds = [promptJob.id];
  for (const sh of shots) {
    const stillJob = await RenderJob.enqueueTx(client, {
      tenant_id: tenantId, project_id: projectId, shot_id: sh.shot_id,
      stage: 'still', runner: runner('still'), priority: 100,
      depends_on: [promptJob.id], step_index: step, step_total: 0,
      label: `Photo ${sh.seq} (new)`,
      payload: {
        avatar_id: proj.avatar_id, lora_id: proj.lora_id, scene_id: sh.scene_id,
        subject_type: proj.subject_type, quality, candidates, resolution,
        _reserved: perStill, _from_credits: 0,
      },
    });
    const qcJob = await RenderJob.enqueueTx(client, {
      tenant_id: tenantId, project_id: projectId, shot_id: sh.shot_id,
      stage: 'qc', runner: runner('qc'), priority: 100,
      depends_on: [stillJob.id], step_index: step, step_total: 0,
      label: `Checking photo ${sh.seq} (new)`,
      payload: { avatar_id: proj.avatar_id },
    });
    newIds.push(stillJob.id, qcJob.id);
  }
  step += 1;

  await client.query('UPDATE render_jobs SET step_total = $2 WHERE id = ANY($1::int[])', [newIds, step]);
  return { shots: shots.length, candidates, credits: totalCredits };
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
    resolution = '480p', reviewStills = null, candidatesPerShot = null,
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
    // Candidates per shot: the pool of still frames rendered for each beat, from
    // which QC (and the human, at Gate 2) pick the best. Defaults by tier; a
    // create-page control may raise or lower it, clamped so cost stays sane.
    const CANDIDATE_MAX = 6;
    const baseCandidates = CANDIDATES[tier] || 1;
    const candidates = (candidatesPerShot != null && Number.isFinite(Number(candidatesPerShot)))
      ? Math.max(1, Math.min(CANDIDATE_MAX, Math.round(Number(candidatesPerShot))))
      : baseCandidates;

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
   * Re-animate a finished shoot's selected stills into a NEW video take. Motion
   * is stochastic, so each run differs — the stills are reused (no re-render, no
   * re-review). Enqueues a fresh motion -> assemble -> copy set with new seeds
   * and reserves only the motion credits. Earlier takes are kept (assemble no
   * longer deletes prior reels), so a shoot accumulates versions.
   */
  async reanimate({ tenantId, projectId, userId = null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: pr } = await client.query(
        `SELECT p.id, p.kind, p.avatar_id, a.subject_type, l.id AS lora_id
           FROM studio_projects p
           JOIN avatars a ON a.id = p.avatar_id
           LEFT JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
          WHERE p.id = $1 AND p.tenant_id = $2`,
        [projectId, tenantId]
      );
      const proj = pr[0];
      if (!proj) throw Object.assign(new Error('Shoot not found'), { status: 404 });
      if (!['reel', 'short', 'longform'].includes(proj.kind)) {
        throw Object.assign(new Error('Only video shoots can be re-animated'), { status: 400 });
      }
      if (!proj.lora_id) throw Object.assign(new Error('This avatar has no trained model'), { status: 409 });

      const { rows: busy } = await client.query(
        `SELECT 1 FROM render_jobs WHERE project_id = $1 AND status IN ('queued','claimed','running','held') LIMIT 1`,
        [projectId]
      );
      if (busy[0]) throw Object.assign(new Error('This shoot is still working — wait for the current take to finish.'), { status: 409 });

      const { rows: shots } = await client.query(
        `SELECT sh.id AS shot_id, sh.seq, sh.framing, sh.duration_seconds,
                sc.continuity AS scene_continuity,
                (SELECT storage_url FROM studio_assets sa
                  WHERE sa.shot_id = sh.id AND sa.kind = 'still' AND sa.selected AND sa.project_id = $1
                  ORDER BY sa.id DESC LIMIT 1) AS still_url
           FROM studio_shots sh
           JOIN studio_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = $1
          ORDER BY sh.seq`,
        [projectId]
      );
      const usable = shots.filter((s) => s.still_url);
      if (!usable.length) throw Object.assign(new Error('No selected stills to animate'), { status: 409 });

      const clipSeconds = Number(usable[0].duration_seconds) || SECONDS_PER_CLIP;
      const { rows: rjm } = await client.query(
        `SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'motion' ORDER BY id DESC LIMIT 1`,
        [projectId]
      );
      const resolution = (rjm[0] && rjm[0].payload && rjm[0].payload.resolution) || '480p';

      const perMotion = creditCostFor({ stage: 'motion', seconds: clipSeconds, resolution });
      const totalCredits = perMotion * usable.length;
      if (totalCredits) await StudioUsage.reserve(client, tenantId, 'credits', totalCredits);

      const { rows: mx } = await client.query('SELECT COALESCE(MAX(step_index), -1) AS m FROM render_jobs WHERE project_id = $1', [projectId]);
      let step = Number(mx[0].m) + 1;

      const { deriveMotionPrompt } = require('./motionPrompt');
      const runner = (stage) => RunnerPolicy.runnerFor(stage, { intent: 'cloud' });
      const motionIds = [];
      for (const sh of usable) {
        const job = await RenderJob.enqueueTx(client, {
          tenant_id: tenantId, project_id: projectId, shot_id: sh.shot_id,
          stage: 'motion', runner: runner('motion'), priority: 100,
          step_index: step, step_total: 0, label: `Bringing photo ${sh.seq} to life (new take)`,
          payload: {
            avatar_id: proj.avatar_id, lora_id: proj.lora_id, resolution, clip_seconds: clipSeconds,
            subject_type: proj.subject_type,
            generation: {
              image_url: sh.still_url,
              motion_prompt: deriveMotionPrompt({ framing: sh.framing, scene_continuity: sh.scene_continuity }),
              resolution, seed: Math.floor(Math.random() * 2000000000), publicly_fetchable: true,
            },
            _reserved: perMotion, _from_credits: 0,
          },
        });
        motionIds.push(job.id);
      }
      step += 1;
      const assemble = await RenderJob.enqueueTx(client, {
        tenant_id: tenantId, project_id: projectId, stage: 'assemble', runner: runner('assemble'),
        depends_on: motionIds, step_index: step, step_total: 0, label: 'Putting it together (new take)',
        payload: { avatar_id: proj.avatar_id, lora_id: proj.lora_id, clip_seconds: clipSeconds },
      });
      step += 1;
      const copyJob = await RenderJob.enqueueTx(client, {
        tenant_id: tenantId, project_id: projectId, stage: 'copy', runner: runner('copy'),
        depends_on: [assemble.id], step_index: step, step_total: 0, label: 'Writing the caption (new take)',
        payload: { avatar_id: proj.avatar_id },
      });
      step += 1;

      await client.query('UPDATE render_jobs SET step_total = $2 WHERE id = ANY($1::int[])', [[...motionIds, assemble.id, copyJob.id], step]);
      await client.query("UPDATE studio_projects SET status = 'generating' WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
      await client.query('COMMIT');
      return { project_id: projectId, motions: motionIds.length, reserved: { credits: totalCredits } };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Regenerate the stills for a shoot that is waiting at the Gate 2 review.
   *
   * The reject path: the user doesn't like the frames and wants a fresh set to
   * pick from, without touching the plan. We supersede the current still
   * candidates (they drop out of the picker and out of QC's selection) and run a
   * fresh prompt -> still -> qc pass for every shot with NEW seeds. The motion
   * jobs stay HELD exactly as they were; when the new QC picks a winner it
   * re-points each held motion at the new frame, so approving later animates the
   * regenerated stills. Only the still stage is charged; motion has not run.
   */
  async regenerateStills({ tenantId, projectId, userId = null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const proj = await loadHeldShoot(client, tenantId, projectId);
      const { shots, candidates, credits } = await enqueueFreshStillPass(client, { tenantId, projectId, proj });
      await client.query("UPDATE studio_projects SET status = 'generating' WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
      await client.query('COMMIT');
      return { project_id: projectId, shots, candidates, reserved: { credits } };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Edit-the-plan, in place. The other reject path: the user reopened this
   * shoot's storyboard, changed the scenes, and wants THIS shoot reshot with the
   * new plan — not a brand-new shoot. We rewrite each shot/scene to the edited
   * values (through the same vocabulary clamp), then run a fresh still pass with
   * the motion jobs still held. The beat COUNT is fixed here — the held motion
   * graph is one job per shot, so changing how many scenes there are is a new
   * shoot, not an edit.
   */
  async replan({ tenantId, projectId, userId = null, scenes: editedScenes = null }) {
    if (!Array.isArray(editedScenes) || !editedScenes.length) {
      throw Object.assign(new Error('scenes[] is required — reopen the plan first'), { status: 400 });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const proj = await loadHeldShoot(client, tenantId, projectId);

      const { rows: shots } = await client.query(
        `SELECT sh.id AS shot_id, sh.scene_id, sh.seq
           FROM studio_shots sh
           JOIN studio_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = $1
          ORDER BY sh.seq`,
        [projectId]
      );

      // The editor sends one card per beat (one shot each); flatten defensively.
      const cards = [];
      for (const sc of editedScenes) {
        const scShots = Array.isArray(sc.shots) && sc.shots.length ? sc.shots : [{}];
        for (const sh of scShots) {
          cards.push({ time_of_day: sc.time_of_day, continuity: sc.continuity || {}, shot: sh || {} });
        }
      }
      if (cards.length !== shots.length) {
        throw Object.assign(new Error('Changing the number of scenes starts a new shoot. Here you can edit the existing scenes and reshoot them.'), { status: 409 });
      }

      const clampVocab = await loadVocabClamp(client, proj.avatar_id);

      // Apply each edited card to its shot (and the shot's scene), in order.
      for (let i = 0; i < shots.length; i += 1) {
        const sh = shots[i];
        const c = cards[i];
        const s = c.shot || {};
        await client.query(
          `UPDATE studio_shots
              SET framing = $2, light_direction = $3, light_quality = $4,
                  expression_key = $5, expression_intensity = $6, pose_key = $7
            WHERE id = $1`,
          [sh.shot_id,
           clampVocab('framing', s.framing, 'medium'),
           clampVocab('light_direction', s.light_direction, 'camera_left'),
           clampVocab('light_quality', s.light_quality, 'soft'),
           clampVocab('expression', s.expression_key, 'neutral'),
           s.expression_intensity || 'medium',
           s.pose_key || null]
        );
        await client.query(
          `UPDATE studio_scenes SET time_of_day = $2, continuity = $3::jsonb WHERE id = $1`,
          [sh.scene_id, clampVocab('time_of_day', c.time_of_day, 'afternoon'), JSON.stringify(c.continuity || {})]
        );
      }

      const { shots: n, candidates, credits } = await enqueueFreshStillPass(client, { tenantId, projectId, proj });
      await client.query("UPDATE studio_projects SET status = 'generating' WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
      await client.query('COMMIT');
      return { project_id: projectId, shots: n, candidates, reserved: { credits } };
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
