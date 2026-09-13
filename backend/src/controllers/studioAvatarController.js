'use strict';

const LoraTraining = require('../services/studio/loraTraining');
const Calibration  = require('../services/studio/calibration');
const CalibrationRun = require('../services/studio/calibrationRun');
const LookProfile  = require('../services/studio/lookProfile');
const StudioUsage  = require('../models/studioUsage');
const Identity     = require('../services/studio/identityBlock');
const SeedBatch    = require('../services/studio/seedBatch');
const SeedTraining = require('../services/studio/seedTraining');
const Candidates   = require('./studioCandidateController');
const pool         = require('../config/db');

/**
 * Setting an avatar up: seed set → training → calibration → active.
 *
 * The order is enforced by the services, not by the client walking these
 * endpoints politely. A caller that skips straight to activation gets a 409,
 * because the QC gate is the only thing standing between a drifting model and a
 * published photo of someone who is not quite your avatar.
 */

function fail(res, err) {
  if (err.code === StudioUsage.QUOTA_EXCEEDED) {
    return res.status(402).json({
      error: err.message, code: err.code, metric: err.metric,
      remaining: err.remaining, limit: err.limit,
    });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  throw err;
}

// GET /api/studio/avatars — this tenant's personas.
//
// Replaces a fetch the avatars page was making to the culling service on :5055,
// which has no authentication and no tenant scoping: it answered with whatever
// avatars were in the database. That was survivable while the only avatar was
// Aanya and the only user was Raghav, and stops being survivable on the day a
// second tenant exists.
exports.list = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.mode, a.status, a.identity_block, a.lora_trigger,
            a.bible_version, a.created_at,
            EXISTS (SELECT 1 FROM avatar_loras l WHERE l.avatar_id = a.id AND l.active) AS trained,
            (SELECT COUNT(*) FROM studio_assets s WHERE s.avatar_id = a.id)::int        AS assets,
            /**
             * Where this avatar actually is, not just what it has published.
             *
             * The card said "No photos yet" off "assets" alone — which counts
             * SHOOT output. An avatar with twenty-four candidate frames and
             * eighteen kept has published nothing, so the one line on its card
             * reported the truth about a different thing and read as "nothing
             * has happened". Setting an avatar up is most of the work and all
             * of the waiting; the card is where it should be visible.
             */
            a.anchor_candidate_id IS NOT NULL                                           AS anchor_chosen,
            COALESCE(c.anchors, 0)                                                      AS anchors,
            COALESCE(c.candidates, 0)                                                   AS candidates,
            COALESCE(c.kept, 0)                                                         AS kept,
            -- What the consent gate will say later, computed now: a twin with no
            -- verified record can be created but cannot train, and the list is
            -- where someone should find that out rather than at the train button.
            (a.mode <> 'synthetic' AND NOT EXISTS (
               SELECT 1 FROM consent_records c
                WHERE c.id = a.consent_record_id AND c.verified
             )) AS consent_pending
       FROM avatars a
       -- One grouped pass rather than three subselects per row.
       LEFT JOIN (
         SELECT avatar_id,
                COUNT(*) FILTER (WHERE kind = 'anchor')::int                     AS anchors,
                COUNT(*) FILTER (WHERE kind = 'pool')::int                       AS candidates,
                COUNT(*) FILTER (WHERE kind = 'pool' AND verdict = 'keep')::int  AS kept
           FROM seed_candidates
          WHERE tenant_id = $1
          GROUP BY avatar_id
       ) c ON c.avatar_id = a.id
      WHERE a.tenant_id = $1
      ORDER BY a.id`,
    [req.user.tenant_id]
  );

  // What creating another one would cost, so the page can say "1 of 1 used"
  // rather than offering a button that 402s.
  const client = await pool.connect();
  let limit = 0;
  try { limit = await StudioUsage.limitFor(client, req.user.tenant_id, 'avatars', 'lifetime'); }
  finally { client.release(); }

  return res.json({ avatars: rows, limit, used: rows.length });
};

/**
 * GET /api/studio/avatars/:id — one persona.
 *
 * The face screen used to get everything, the avatar included, from the culling
 * service on :5055. That service reads its avatar list ONCE at startup and then
 * closes the pool — so an avatar created a minute ago does not exist to it, and
 * asking for one produced a 404 whose body has no `candidates` array. The page
 * dereferenced it and threw, which is what greeted the first person to use the
 * new creation form.
 *
 * The avatar now comes from here, authenticated and tenant-scoped. The frames
 * still come from the culling service, because that is where they are — on
 * disk, next to the generator — and the page treats it as optional.
 */
exports.get = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.mode, a.status, a.identity_block, a.avoid_block,
            a.lora_trigger, a.bible_version, a.created_at,
            (SELECT COUNT(*) FROM studio_assets s WHERE s.avatar_id = a.id)::int AS assets,
            EXISTS (SELECT 1 FROM avatar_loras l WHERE l.avatar_id = a.id AND l.active) AS trained,
            (a.mode <> 'synthetic' AND NOT EXISTS (
               SELECT 1 FROM consent_records c WHERE c.id = a.consent_record_id AND c.verified
             )) AS consent_pending
       FROM avatars a
      WHERE a.id = $1 AND a.tenant_id = $2`,
    [Number(req.params.id), req.user.tenant_id]
  );

  // 404 rather than 403 for an avatar belonging to someone else: confirming
  // that an id exists but is not yours is still telling you it exists.
  if (!rows[0]) return res.status(404).json({ error: 'No such avatar' });
  return res.json({ avatar: rows[0] });
};

// GET /api/studio/avatars/rules — what a valid identity block is.
//
// Served rather than restated in the browser. The form checks as you type using
// these lists; the POST below re-checks with the same module and is the
// authority. A copy of the word lists in JavaScript would be a copy that stops
// matching the day someone adds a word here.
exports.identityRules = async (_req, res) => res.json(Identity.rules());

/**
 * POST /api/studio/avatars — create a persona.
 *
 * ── The identity block is the whole reason this is careful ──────────────────
 * It is concatenated verbatim into every prompt this avatar will ever generate
 * and it is frozen: an edit invalidates the trained LoRA and every calibrated
 * QC baseline. Nothing about getting it wrong is visible at the time. So the
 * rules are enforced here rather than trusted to the form, and the refusal
 * names every problem at once.
 */
exports.create = async (req, res) => {
  const body = req.body || {};
  const name = Identity.normalise(body.name);
  const mode = String(body.mode || 'synthetic').trim();

  const fields = {};
  if (!name) return res.status(400).json({ error: 'Give the avatar a name', fields: { name: 'Required.' } });
  if (name.length > 80) fields.name = 'Keep it under 80 characters.';

  // 'reference' is refused by a CHECK constraint in migration 033 as well. This
  // is only so the refusal arrives as a sentence rather than a 500.
  if (!['synthetic', 'twin'].includes(mode)) {
    return res.status(400).json({
      error: 'Unknown mode',
      message: 'An avatar is either synthetic — a person who does not exist — or a twin of the account holder. '
             + 'Generating a likeness of anyone else is not something this product does.',
      code: 'BAD_MODE',
    });
  }

  const identity = Identity.normalise(
    body.identity_block || Identity.compose(body.identity_fields || {})
  );
  const check = Identity.validate(identity, { name });
  if (!check.ok) {
    return res.status(400).json({
      error: 'The identity block will not do',
      message: check.errors.map((e) => e.message).join(' '),
      code: 'IDENTITY_INVALID',
      identity_errors: check.errors,
      words: check.words,
    });
  }

  const slug = Identity.slugify(body.slug || name);
  if (!slug) fields.slug = 'That name has no letters or digits in it to make a slug from.';

  const trigger = String(body.lora_trigger || Identity.suggestTrigger(name)).toLowerCase();
  if (!Identity.validTrigger(trigger)) {
    fields.lora_trigger = '6–20 lowercase letters and digits, including at least one digit. '
      + 'A real word inherits whatever the base model already thinks it looks like.';
  }

  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Some details need fixing', fields });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The lifetime cap, taken inside the transaction. `reserve` is an atomic
    // upsert, so two tabs submitting at once cannot both slip past a limit of
    // one — the second sees the first's increment. Avatars have no credit rate,
    // so this cap cannot be bought around either.
    await StudioUsage.reserve(client, req.user.tenant_id, 'avatars', 1, 'lifetime', slug);

    const { rows } = await client.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block, lora_trigger)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
       ON CONFLICT (tenant_id, slug) DO NOTHING
       RETURNING id, slug, name, mode, status, identity_block, lora_trigger, bible_version, created_at`,
      [req.user.tenant_id, slug, name, mode, identity,
       Identity.normalise(body.avoid_block) || Identity.DEFAULT_AVOID, trigger]
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'You already have an avatar with that name',
        message: `The slug "${slug}" is taken in this workspace. It names the storage prefix as well, so it has to be unique.`,
        code: 'SLUG_TAKEN',
      });
    }
    const avatar = rows[0];

    // The look profile is created with the avatar rather than lazily, because
    // every default in it is a decision — lens, grain, colour — and a row that
    // appears later appears with whatever the defaults were THEN.
    const { rows: lookRows } = await client.query(
      `INSERT INTO look_profiles (avatar_id) VALUES ($1)
       ON CONFLICT (avatar_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [avatar.id]
    );
    const look = lookRows[0];

    await client.query(
      `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
       VALUES ($1, $2, 'avatar.create', 'avatar', $3, $3, $4::jsonb, $5)`,
      [req.user.tenant_id, req.user.id, avatar.id,
       JSON.stringify({ slug, mode, words: check.words }), req.ip || null]
    );

    // Everything above is the avatar and must survive a generation refusal.
    await client.query('SAVEPOINT before_generation');

    /**
     * Start generating, if they asked for it and can pay for it.
     *
     * ── In the same transaction as the avatar, on purpose ───────────────────
     * A committed avatar with half a batch behind it, or jobs pointing at an
     * avatar that rolled back, are both worse than either succeeding alone.
     *
     * ── But a refusal must not lose the avatar ──────────────────────────────
     * The identity block is the expensive part — it is composed carefully, it
     * is frozen, and the avatar slot has already been spent. Throwing it away
     * because this month's still allowance is short would make someone write it
     * twice for a reason that has nothing to do with it. So a quota refusal
     * unwinds only the generation: the transaction is committed WITHOUT it, and
     * the answer says the avatar exists and why the frames did not start.
     */
    let generation = null;
    const wanted = body.generate;
    if (wanted && wanted.count) {
      const refusal = await Candidates.consentRefusal(avatar);
      if (refusal) {
        generation = { queued: 0, refused: refusal };
      } else {
        try {
          /**
           * Faces first, not a pool.
           *
           * Describing a face and immediately being charged for twenty-four
           * frames of a stranger is how the old flow worked, and it did not
           * work: base Flux draws a TYPE of person from text, so those frames
           * were twenty-four different people who all matched the description.
           * What comes back now is a handful of faces to choose between —
           * cheap, and the right question to ask someone who has just written
           * a description: is this them?
           *
           * The pool is queued afterwards, from the chosen face, and costs a
           * fraction of what it used to because the frames now mostly land.
           */
          generation = await SeedBatch.queue(client, {
            tenantId: req.user.tenant_id, userId: req.user.id,
            avatar, look, count: wanted.anchors ?? wanted.count, ip: req.ip,
            kind: 'anchor',
          });
        } catch (err) {
          if (err.code !== StudioUsage.QUOTA_EXCEEDED) throw err;
          // Undo the jobs and the reservation, keep the avatar. SAVEPOINT
          // rather than a second transaction: the avatar is not committed yet,
          // and a rollback here must not take it with them.
          await client.query('ROLLBACK TO SAVEPOINT before_generation');
          generation = {
            queued: 0,
            refused: {
              error: err.message, code: err.code,
              message: 'The avatar was created. Generating its photos costs more than this '
                     + 'month\'s allowance and your credit balance cover — start a smaller '
                     + 'batch, or top up, from the avatar\'s page.',
            },
          };
        }
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({
      avatar,
      // Said on the way out rather than discovered at the train button.
      consent_required: mode !== 'synthetic',
      generation,
      next: `/avatars/${avatar.id}/face`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(res, err);
  } finally {
    client.release();
  }
};

// POST /api/studio/avatars/:id/seed-set — where to upload the training zip.
// Private, not public: these are the training images of a face, and the
// published-media prefix is world-readable so Instagram can fetch from it.
exports.seedSetTarget = async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  res.json(LoraTraining.seedSetTarget({ tenantId: req.user.tenant_id, avatarSlug: slug }));
};

/**
 * The avatar, if it belongs to the caller.
 *
 * Written here rather than imported from the candidate controller: that one
 * selects the columns a culling screen needs, and this one needs the trigger
 * token. A shared helper that selects the union of both is how a query grows a
 * column nobody can explain.
 */
async function ownedAvatar(req, res) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, mode, status, identity_block, lora_trigger, anchor_candidate_id
       FROM avatars WHERE id = $1 AND tenant_id = $2`,
    [Number(req.params.id), req.user.tenant_id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'No such avatar' }); return null; }
  return rows[0];
}

/**
 * Training, as three requests instead of one command.
 *
 * It used to be one endpoint taking `seed_set_url` and `seed_embeddings` in the
 * body — an API shaped for `studio/train.js`, which is the only thing that could
 * produce either. Nobody on a screen can. So the work moved behind these:
 *
 *   POST /train/check   measure the set (queues an `embed` job)
 *   GET  /train         where the check got to, what it found, what it costs
 *   POST /train         having been shown all that, spend the money
 *
 * Two presses on purpose. Training is the most expensive single action in the
 * product and the one that cannot be undone: the reference vector it writes is
 * what every future frame is judged against.
 */

// POST /api/studio/avatars/:id/train/check
exports.trainCheck = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await SeedTraining.check(client, {
      tenantId: req.user.tenant_id, userId: req.user.id, avatar, ip: req.ip,
    });
    await client.query('COMMIT');
    return res.status(202).json(out);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({
        error: err.message, code: err.code, ...(err.gaps ? { gaps: err.gaps } : {}),
      });
    }
    throw err;
  } finally {
    client.release();
  }
};

// GET /api/studio/avatars/:id/train
exports.trainStatus = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  // Polled while a check runs, and it reports a number that is CHANGING.
  res.set('Cache-Control', 'no-store');
  return res.json(await SeedTraining.status(req.user.tenant_id, avatar));
};

// POST /api/studio/avatars/:id/train
exports.train = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await SeedTraining.submit(client, {
      tenantId: req.user.tenant_id, userId: req.user.id, avatar,
      steps: req.body?.steps, ip: req.ip,
    });
    await client.query('COMMIT');
    return res.status(201).json(out);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.name === 'TrainingRefused') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code });
    }
    if (err.status) {
      return res.status(err.status).json({
        error: err.message, code: err.code, ...(err.gaps ? { gaps: err.gaps } : {}),
      });
    }
    return fail(res, err);
  } finally {
    client.release();
  }
};

// GET /api/studio/loras/:id/calibration — the work list, with its price attached
//
// `framings` is the main cost lever and is exposed on purpose. Calibrating all
// three framings for every preset is ~200 frames; medium alone is a third of
// that, and the QC fallback chain degrades sensibly (exact → same expression at
// any framing → permissive floor) rather than rejecting what it has not measured.
// Start at medium, add close and wide once the persona is earning.
exports.calibrationPlan = async (req, res) => {
  const framings = req.query.framings
    ? String(req.query.framings).split(',').map((f) => f.trim()).filter(Boolean)
    : undefined;

  const unknown = (framings || []).filter((f) => !Calibration.FRAMINGS.includes(f));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown framing(s): ${unknown.join(', ')}` });
  }

  try {
    // CalibrationRun.preview rather than Calibration.plan: `plan` lists a cell
    // for every enabled preset, and the run will not queue the blended ones —
    // their frames are generated neutral and readiness never reads them. A
    // quote for work that will not be done is a number nobody can reconcile
    // against the bill.
    res.json(await CalibrationRun.preview(req.user.tenant_id, Number(req.params.id), {
      samples: Math.min(Math.max(parseInt(req.query.samples, 10) || 6, 5), 12),
      ...(framings ? { framings } : {}),
    }));
  } catch (err) {
    return fail(res, err);
  }
};

// POST /api/studio/loras/:id/calibration/run — generate the frames to measure
//
// The half that was missing. `calibrate.js` said so plainly: it "does not
// generate or record anything… the recording loop is still to build", which
// left `activate` refusing every model for want of baselines nothing could
// produce.
exports.calibrationRun = async (req, res) => {
  const raw = req.body?.framings;
  const framings = Array.isArray(raw) && raw.length ? raw.map((f) => String(f).trim()).filter(Boolean) : undefined;

  const unknown = (framings || []).filter((f) => !Calibration.FRAMINGS.includes(f));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown framing(s): ${unknown.join(', ')}` });
  }

  try {
    res.json(await CalibrationRun.submit(req.user.tenant_id, Number(req.params.id), {
      userId: req.user.id,
      // Five is the floor `Calibration.recordCell` enforces, so six is the
      // smallest sample that survives one structurally broken frame. Asking
      // for fewer buys a plan that cannot be recorded.
      samples: Math.min(Math.max(parseInt(req.body?.samples, 10) || 6, 6), 12),
      ...(framings ? { framings } : {}),
      ip: req.ip,
    }));
  } catch (err) {
    return fail(res, err);
  }
};

// POST /api/studio/loras/:id/calibration — record one (preset, framing) cell
exports.recordCell = async (req, res) => {
  const { preset_key, framing = 'medium', samples } = req.body;
  if (!preset_key) return res.status(400).json({ error: 'preset_key is required' });
  if (!Array.isArray(samples)) return res.status(400).json({ error: 'samples must be an array' });

  try {
    res.json(await Calibration.recordCell({
      tenantId: req.user.tenant_id,
      loraId: Number(req.params.id),
      presetKey: preset_key,
      framing,
      samples,
    }));
  } catch (err) {
    return fail(res, err);
  }
};

// GET /api/studio/loras/:id/readiness
exports.readiness = async (req, res) => {
  try {
    res.json(await Calibration.readiness(req.user.tenant_id, Number(req.params.id)));
  } catch (err) {
    return fail(res, err);
  }
};

// POST /api/studio/loras/:id/activate — calibration complete, model goes live
exports.activate = async (req, res) => {
  try {
    res.json(await Calibration.finish(req.user.tenant_id, Number(req.params.id)));
  } catch (err) {
    return fail(res, err);
  }
};

// GET /api/studio/avatars/:id/look — everything the look screen needs in one call
exports.look = async (req, res) => {
  try {
    res.json(await LookProfile.describe(req.user.tenant_id, Number(req.params.id)));
  } catch (err) {
    return fail(res, err);
  }
};

// PUT /api/studio/avatars/:id/look
exports.updateLook = async (req, res) => {
  try {
    res.json(await LookProfile.update(req.user.tenant_id, Number(req.params.id), req.body || {}));
  } catch (err) {
    return fail(res, err);
  }
};
