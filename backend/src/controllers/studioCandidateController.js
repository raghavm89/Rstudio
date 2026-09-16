'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { createStorage, storageDriver } = require('../services/studio/storageFactory');
const Seed = require('../services/studio/seedCandidates');
const SeedPrompt = require('../services/studio/seedPrompt');
const SeedBatch = require('../services/studio/seedBatch');
const SeedExport = require('../services/studio/seedExport');
const StudioUsage = require('../models/studioUsage');

/**
 * Culling, on the authenticated plane.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * A standalone HTTP server on :5055 with no authentication and no tenant
 * scoping. It answered `/api/candidates?avatar=N` for any N to anyone who could
 * reach the port, served the images at `/img/<id>/<file>` the same way, and kept
 * the verdicts in a JSON file beside the pictures. It also read its list of
 * avatars once at startup and then closed its pool, so an avatar created after
 * it started did not exist to it — which is how the New avatar button led
 * straight to a TypeError.
 *
 * ── Where the files still are ───────────────────────────────────────────────
 * On the machine that generated them. That is not a temporary state: the
 * candidate pool is hundreds of throwaway frames from local ComfyUI, and
 * pushing them into object storage to look at them once and delete most of them
 * would cost money and time for nothing. So the DECISIONS are in the database,
 * tenant-scoped and durable, and the PIXELS are read off local disk by an
 * endpoint that checks who is asking.
 */

/** Where a persona's working directory lives. Set on the machine that generates. */
function personaDir(slug) {
  const root = process.env.STUDIO_PERSONA_DIR
    || path.join(__dirname, '..', '..', 'studio', 'personas');
  return path.join(root, slug);
}

/**
 * The avatar, if it is the caller's.
 *
 * 404 rather than 403 for someone else's: confirming an id exists but is not
 * yours still confirms it exists.
 */
async function ownedAvatar(req, res) {
  const { rows } = await pool.query(
    // `anchor_candidate_id` included because everything downstream of it —
    // whether a pool is generated from a face or from a description — turns on
    // it, and a read that omits it silently takes the old path.
    `SELECT id, slug, name, mode, identity_block, anchor_candidate_id
       FROM avatars WHERE id = $1 AND tenant_id = $2`,
    [Number(req.params.id), req.user.tenant_id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'No such avatar' }); return null; }
  return rows[0];
}

// GET /api/studio/avatars/:id/candidates
exports.list = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const client = await pool.connect();
  let out;
  try {
    out = await Seed.list(client, req.user.tenant_id, avatar.id);
  } finally {
    client.release();
  }

  // Each candidate carries its own signed URL. Minted per response rather than
  // stored, so the grant expires on its own and a stale page has to ask again.
  const candidates = out.candidates.map((c) => ({
    ...c,
    url: Seed.signedUrl(req.user.tenant_id, avatar.id, c.filename),
  }));

  /**
   * Is a batch still arriving?
   *
   * Without this, the seconds between queueing eighty jobs and the first frame
   * landing look exactly like never having generated anything — the screen says
   * "no photos to choose from yet" to somebody who just paid for eighty of
   * them, which reads as the money having vanished.
   */
  const { rows: live } = await pool.query(
    `SELECT payload->>'batch' AS batch,
            -- anchor or pool. The screen says "faces to choose from" for one
            -- and "photos" for the other, and getting that wrong tells somebody
            -- their pool is arriving when what is arriving is six headshots.
            MIN(payload->>'kind')                                        AS kind,
            COUNT(*)::int                                                AS jobs,
            COUNT(*) FILTER (WHERE status IN ('queued','claimed','running'))::int AS pending,
            COUNT(*) FILTER (WHERE status = 'failed')::int               AS failed,
            -- Has anything ever picked one of these up? A batch where every job
            -- is still 'queued' and none was ever claimed is not slow, it is
            -- unattended: no worker is asking for this stage. Without this the
            -- screen shows "0 of 24" forever and looks like it is working.
            COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int           AS ever_claimed,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int            AS age_seconds
       FROM render_jobs
      WHERE stage = 'seed_still' AND tenant_id = $1 AND payload->>'avatar_id' = $2
      GROUP BY 1
      ORDER BY MAX(id) DESC
      LIMIT 1`,
    [req.user.tenant_id, String(avatar.id)]
  );
  const batchRow = live[0] || null;
  const generating = batchRow && batchRow.pending > 0
    ? {
      batch: batchRow.batch,
      kind: batchRow.kind === 'anchor' ? 'anchor' : 'pool',
      queued: batchRow.jobs,
      pending: batchRow.pending,
      failed: batchRow.failed,
      landed: out.candidates.filter((c) => c.batch === batchRow.batch).length,
      age_seconds: Number(batchRow.age_seconds || 0),
      // Two minutes with nothing ever claimed. A frame takes tens of seconds,
      // so a renderer that is merely busy will still have taken ONE by then;
      // zero claims after two minutes means nobody is listening for this stage.
      stalled: Number(batchRow.ever_claimed) === 0 && Number(batchRow.age_seconds || 0) > 120,
    }
    : null;

  /**
   * And if it has stalled, why.
   *
   * "Nothing has started these" is true but useless on its own — it describes
   * the symptom the screen is already showing. There is exactly one common
   * cause now that renders run in the API process: no fal key, so the runner
   * declined to claim work it could not perform. Asking costs a property read.
   *
   * Only asked when something is actually wrong, so a healthy poll does no
   * extra work.
   */
  if (generating && generating.stalled) {
    const { CloudRunner } = require('../services/studio/cloudRunner');
    generating.renderer_ready = await CloudRunner.ready();
  }

  /**
   * Never cached.
   *
   * Express puts an ETag on every JSON response, so a poll whose body has not
   * changed comes back 304 and the browser serves the previous body. That is
   * usually a saving and here it is a lie: this endpoint exists to report a
   * number that is CHANGING, and the log filled with
   * `GET /candidates 304` while a batch sat at "0 of 24 finished".
   */
  res.set('Cache-Control', 'no-store');

  /**
   * The faces offered as a choice, alongside the pool.
   *
   * On the same response rather than a second endpoint because the screen is
   * one screen with several states, and the state it is in depends on both:
   * no anchors is "describe and generate", anchors with none chosen is "which
   * of these is the person", a chosen anchor and no pool is "now make the
   * pool". Two polls to decide one thing is two ways to be half-updated.
   */
  const anchorRows = await Seed.anchors(pool, req.user.tenant_id, avatar.id);

  return res.json({
    generating,
    anchors: anchorRows.map((a) => ({
      id: a.id,
      filename: a.filename,
      chosen: a.chosen === true,
      url: Seed.signedUrl(req.user.tenant_id, avatar.id, a.filename),
    })),
    anchor_chosen_id: avatar.anchor_candidate_id || null,
    // identity_block included because the empty state quotes it back — the
    // frozen description is the one thing worth re-reading before spending
    // money generating three hundred frames from it.
    avatar: {
      id: avatar.id, name: avatar.name, slug: avatar.slug,
      mode: avatar.mode, identity_block: avatar.identity_block,
    },
    ...out,
    candidates,
    // Whether the pixels are reachable from here at all. A pool registered on a
    // different machine is a real situation, and "the images are 404ing" is a
    // worse answer than saying so.
    // True when the pixels are reachable from here: either the persona
    // directory is on this machine, or the frames were generated by the queue
    // and live in storage. A pool registered on somebody else's laptop is
    // neither, and "the images are 404ing" is a worse answer than saying so.
    frames_present: out.candidates.some((c) => c.storage_key)
      || fs.existsSync(path.join(personaDir(avatar.slug), 'candidates')),
  });
};

// POST /api/studio/avatars/:id/candidates  { filename, verdict }
//
// `verdict: null` clears a decision, which is not the same as rejecting — the
// difference is the whole progress count.
exports.mark = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const filename = String(req.body?.filename || '');
  const verdict = req.body?.verdict ?? null;
  if (!filename) return res.status(400).json({ error: 'Which candidate?' });

  const client = await pool.connect();
  try {
    const ok = await Seed.mark(client, req.user.tenant_id, avatar.id, filename, verdict, req.user.id);
    if (!ok) return res.status(404).json({ error: 'No such candidate for this avatar' });
    // The coverage strip is recomputed from the database rather than from the
    // browser's idea of what it just clicked, so a dropped request shows up as
    // the strip not moving instead of as two views quietly disagreeing.
    return res.json(await Seed.list(client, req.user.tenant_id, avatar.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
};

/**
 * GET /api/studio/avatars/:id/candidates/:filename?exp=&sig=
 *
 * Registered BEFORE `authenticate` in the router, and authorised by its own
 * signature instead — an `<img>` tag sends no Authorization header, and pulling
 * three hundred thumbnails through fetch into blob URLs would defeat lazy
 * loading and hold the whole pool in memory.
 *
 * The signature covers tenant, avatar and filename together, so a grant for one
 * image is not a grant for another and a grant minted in one workspace does not
 * read another's.
 */
exports.image = async (req, res) => {
  const avatarId = Number(req.params.id);
  const filename = path.basename(String(req.params.filename || ''));
  const { exp, sig } = req.query;

  // The tenant is not in the URL: it is looked up from the avatar and then the
  // signature must match it. A tenant id in the query string would be a value
  // the caller chooses, and the signature would be proving their own claim.
  const { rows } = await pool.query(
    `SELECT a.tenant_id, a.slug, c.storage_key
       FROM avatars a
       LEFT JOIN seed_candidates c ON c.avatar_id = a.id AND c.filename = $2
      WHERE a.id = $1`,
    [avatarId, filename]
  );
  const avatar = rows[0];

  // One answer for every failure. A different status for "no such avatar" and
  // "bad signature" tells an unauthenticated caller which ids exist.
  const deny = () => res.status(404).json({ error: 'Not found' });

  if (!avatar) return deny();
  let valid = false;
  try {
    valid = Seed.verify(avatar.tenant_id, avatarId, filename, exp, sig);
  } catch (err) {
    if (err.code === 'NO_SIGNING_SECRET') return res.status(503).json({ error: err.message, code: err.code });
    throw err;
  }
  if (!valid) return deny();

  // Private: the URL is a bearer grant, so a shared cache holding the bytes
  // would outlive the grant that fetched them.
  const headers = {
    'Content-Type': 'image/png',
    'Cache-Control': `private, max-age=${Math.floor(Seed.TTL_MS / 1000)}`,
  };

  /**
   * Two places a frame can be, and which one is not a guess.
   *
   * A row with a storage key was generated by the queue and the bytes are in
   * object storage. A row without one is a file in the persona directory,
   * written by studio/seed-set.js on somebody's own machine. Both paths stay:
   * the local one costs nothing and is how R&D happens, the queued one is how
   * the product works.
   */
  if (avatar.storage_key) {
    if (storageDriver() === 's3') {
      // Redirected rather than proxied. Streaming a few hundred thumbnails
      // through this process to add nothing to them would make the API the
      // bottleneck in the one screen that shows three hundred images at once.
      //
      // `readUrl` presigns rather than using `publicUrl` — its own comment says
      // it is for "private assets — seed images, consent videos — that must not
      // be public", which is exactly these. A public URL here would undo the
      // signature this endpoint just checked.
      let url;
      try { url = createStorage().readUrl(avatar.storage_key, { expiresIn: 900 }); } catch { return deny(); }
      if (!url) return deny();
      res.setHeader('Cache-Control', headers['Cache-Control']);
      return res.redirect(302, url);
    }
    let stored;
    try { stored = createStorage().get(avatar.storage_key); } catch { return deny(); }
    res.writeHead(200, { ...headers, 'Content-Type': stored.contentType });
    return fs.createReadStream(stored.path).pipe(res);
  }

  const dir = path.resolve(personaDir(avatar.slug), 'candidates');
  const file = path.resolve(dir, filename);
  // basename() above already removes any traversal; this is the second lock,
  // because a symlinked persona directory would slip past the first.
  if (file !== dir && !file.startsWith(dir + path.sep)) return deny();
  if (!fs.existsSync(file)) return deny();

  res.writeHead(200, headers);
  return fs.createReadStream(file).pipe(res);
};

/**
 * POST /api/studio/avatars/:id/seed-set/export
 *
 * Copies the kept frames into `seed/` and writes the manifest the trainer
 * reads. The gate — count and coverage — is enforced in the service, before a
 * single file is copied, so a refused export leaves nothing half-written.
 */
exports.exportSet = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const client = await pool.connect();
  let kept, culledFrom;
  try {
    ({ kept, culledFrom } = await Seed.keptForExport(client, req.user.tenant_id, avatar.id));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...(err.gaps ? { gaps: err.gaps } : {}) });
    }
    throw err;
  } finally {
    client.release();
  }

  const manifest = {
    avatar: avatar.slug,
    avatar_id: avatar.id,
    count: kept.length,
    culled_from: culledFrom,
    selected_at: new Date().toISOString(),
    coverage: {
      angles:    [...new Set(kept.map((k) => k.angle))],
      framings:  [...new Set(kept.map((k) => k.framing))],
      qualities: [...new Set(kept.map((k) => k.quality))],
    },
    files: kept.map((k) => k.filename),
  };

  /**
   * The export is a zip in storage, not a folder on this machine.
   *
   * It used to copy the frames into `studio/personas/<slug>/seed/` and hand
   * back a filesystem path — a complete description of how one person on one
   * laptop did it. Queue-generated frames are objects in storage, so every one
   * failed the file check and the screen said "12 kept frames are not on this
   * machine" about frames the product had just generated; and the remedy it
   * offered was to copy a directory, which a customer cannot do and would not
   * want to. A folder on the API server is also not what training consumes:
   * fal fetches a zip.
   */
  let seedSet;
  try {
    seedSet = await SeedExport.publish({
      kept,
      avatarSlug: avatar.slug,
      tenantId: req.user.tenant_id,
      candidatesDir: path.join(personaDir(avatar.slug), 'candidates'),
      manifest,
    });
  } catch (err) {
    if (err.code === 'FRAME_MISSING') {
      // Only reachable for frames with no storage key — the local R&D path,
      // where the pictures really are files somebody may have moved.
      return res.status(409).json({
        error: 'Some kept frames could not be read',
        message: `${err.message}. These were generated on this machine rather than by the queue, `
               + 'so the files have to be where they were made.',
        code: 'FRAMES_NOT_LOCAL',
      });
    }
    throw err;
  }

  await pool.query(
    `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
     VALUES ($1, $2, 'avatar.seed_set.export', 'avatar', $3, $3, $4::jsonb, $5)`,
    [req.user.tenant_id, req.user.id, avatar.id,
     JSON.stringify({ count: kept.length, culled_from: culledFrom,
                      seed_set_key: seedSet.key, bytes: seedSet.bytes }), req.ip || null]
  );

  return res.json({
    ok: true,
    ...manifest,
    seed_set_url: seedSet.url,
    seed_set_key: seedSet.key,
    bytes: seedSet.bytes,
    publicly_fetchable: seedSet.publicly_fetchable,
  });
};

/**
 * GET /api/studio/candidates/quote?count=N
 *
 * Not scoped to an avatar, because the New avatar form needs a price before the
 * avatar exists — the cost depends on the workspace's allowance and balance,
 * never on which avatar the frames are for.
 */
exports.tenantQuote = async (req, res) => {
  const count = SeedBatch.clampCount(req.query.count);
  const client = await pool.connect();
  try {
    return res.json(await SeedBatch.quote(client, req.user.tenant_id, count));
  } finally {
    client.release();
  }
};

// GET /api/studio/avatars/:id/candidates/quote?count=N — the same answer, from
// the culling screen, where the avatar is already in hand.
exports.quote = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const count = SeedBatch.clampCount(req.query.count);
  const client = await pool.connect();
  try {
    // Priced against THIS avatar's remaining allowance — the tenant-level quote
    // above prices a fresh one, which is what a new avatar has.
    return res.json(await SeedBatch.quote(client, req.user.tenant_id, count, avatar.id));
  } finally {
    client.release();
  }
};

/**
 * POST /api/studio/avatars/:id/candidates/generate  { count }
 *
 * The manual path: topping a pool up, or starting one that was skipped or
 * refused at creation. Creating an avatar queues the first batch itself.
 */
exports.generate = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const refusal = await consentRefusal(avatar);
  if (refusal) return res.status(409).json(refusal);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const look = (await client.query(
      'SELECT * FROM look_profiles WHERE avatar_id = $1', [avatar.id])).rows[0];
    if (!look) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This avatar has no look profile',
        message: 'The look profile is created with the avatar; this one predates that. '
               + 'Re-saving the look on the avatar page will create it.',
        code: 'NO_LOOK_PROFILE',
      });
    }

    let out;
    try {
      out = await SeedBatch.queue(client, {
        tenantId: req.user.tenant_id, userId: req.user.id,
        avatar, look, count: req.body?.count, ip: req.ip,
        // The same endpoint queues both, because they are the same act: frames
        // billed the same way against the same allowance. Only what they are
        // FOR differs, and the caller is the one who knows that.
        kind: req.body?.kind === 'anchor' ? 'anchor' : 'pool',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === StudioUsage.QUOTA_EXCEEDED) {
        const c2 = await pool.connect();
        let priced;
        try {
          priced = await SeedBatch.quote(
            c2, req.user.tenant_id, SeedBatch.clampCount(req.body?.count), avatar.id);
        } finally { c2.release(); }
        return res.status(402).json({
          error: err.message, code: err.code, metric: err.metric,
          remaining: err.remaining, limit: err.limit, quote: priced,
          message: priced.affordable_count >= Seed.MIN_BATCH
            ? `This avatar has ${priced.allowance.left} of its ${priced.allowance.included} photos left, `
              + `so that needs ${priced.credits_needed} credits and you hold ${priced.credits_held}. `
              + `You could generate ${priced.affordable_count} now, or top up for the full batch.`
            : `This avatar has ${priced.allowance.left} of its ${priced.allowance.included} photos left, `
              + `so that needs ${priced.credits_needed} credits and you hold ${priced.credits_held}. `
              + 'Top up to generate more.',
        });
      }
      throw err;
    }

    await client.query('COMMIT');
    return res.status(202).json({
      ok: true, ...out,
      message: `${out.queued} frames queued. They appear here as they finish — usually a few minutes.`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * A twin depicts a real person, so the material used to train it needs recorded
 * consent from that person. Checked before any quota is spent: refusing only at
 * training would mean the frames existed first, which is the thing consent is
 * about.
 *
 * Exported so avatar creation applies the same rule rather than restating it.
 */
async function consentRefusal(avatar) {
  if (avatar.mode === 'synthetic') return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM consent_records c
       JOIN avatars a ON a.consent_record_id = c.id
      WHERE a.id = $1 AND c.verified`, [avatar.id]);
  if (rows.length) return null;
  return {
    error: 'This avatar needs a verified consent record first',
    message: 'A twin depicts a real person, so the material used to train it needs recorded '
           + 'consent from that person. Capture it on the clone page for this avatar.',
    code: 'CONSENT_REQUIRED',
  };
}
exports.consentRefusal = consentRefusal;

// GET /api/studio/candidates/rules — the coverage gate, served rather than restated.
exports.rules = async (_req, res) => res.json(Seed.rules());

/**
 * GET /avatars/:id/anchors — the faces offered as a choice, and which is taken.
 *
 * A separate read from the candidate list because it answers a different
 * question at a different moment: "which of these is the person", asked once
 * before a pool exists, rather than "does this frame look like them", asked
 * forty times afterwards.
 */
exports.anchors = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const rows = await Seed.anchors(pool, req.user.tenant_id, avatar.id);
  res.set('Cache-Control', 'no-store');
  return res.json({
    anchors: rows.map((a) => ({
      id: a.id,
      filename: a.filename,
      seed: a.seed,
      chosen: a.chosen === true,
      url: Seed.signedUrl(req.user.tenant_id, avatar.id, a.filename),
    })),
    chosen_id: avatar.anchor_candidate_id || null,
    avatar: { id: avatar.id, name: avatar.name, identity_block: avatar.identity_block },
  });
};

/**
 * POST /avatars/:id/anchor — this one is the face.
 *
 * Nothing is generated here. Choosing is free and reversible right up until a
 * pool is queued from it, which is deliberate: the choice is the single most
 * consequential thing the customer does, because every later frame and the
 * LoRA after them all descend from it.
 */
exports.chooseAnchor = async (req, res) => {
  const avatar = await ownedAvatar(req, res);
  if (!avatar) return undefined;

  const id = Number(req.body?.candidate_id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'candidate_id (a positive integer) is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await Seed.chooseAnchor(client, req.user.tenant_id, avatar.id, id);
    await client.query(
      `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
       VALUES ($1, $2, 'avatar.anchor.choose', 'avatar', $3, $3, $4::jsonb, $5)`,
      [req.user.tenant_id, req.user.id, avatar.id, JSON.stringify({ candidate_id: id }), req.ip]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  } finally {
    client.release();
  }

  return res.json({ chosen_id: id });
};
