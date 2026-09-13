'use strict';

const crypto = require('crypto');

/**
 * The seed set: what a candidate is, what makes a set complete, and who decided.
 *
 * ── One definition, previously three ────────────────────────────────────────
 * The axis values, the coverage rules and the filename parser lived in
 * `studio/cull.js`. The face screen kept its own copy of the axes and the
 * required counts so it could draw the coverage strip. The export gate used the
 * first; the strip showed the second. Nothing made them agree, and the failure
 * mode is the worst kind — a screen saying a set is complete and an export
 * refusing it, or vice versa.
 *
 * Everything here is pure except the four functions at the bottom that take a
 * client, so the rules can be tested without a database and the browser can be
 * SERVED them rather than keeping a fourth copy.
 */

const ANGLES    = ['front', 'three-quarter', 'profile'];
const FRAMINGS  = ['close', 'medium', 'full'];
const QUALITIES = ['soft', 'hard'];

/**
 * Why twelve and why forty.
 *
 * Below twelve the model has too little to separate the person from what was
 * behind them, and learns the background. Above forty it is diminishing returns
 * on a set that costs real money to curate — and every extra near-duplicate
 * pulls the mean embedding towards whatever that frame happens to be.
 */
const MIN_KEEP = 12;
const MAX_KEEP = 40;

/**
 * Coverage, and why each rule is here.
 *
 * Not arbitrary minimums. Each one names a way the trained model fails when the
 * axis is missing, and each failure is silent — it shows up as drift in a
 * published photo rather than as an error at training time.
 */
const COVERAGE = [
  { key: 'angle',   label: 'All three angles',       need: 3, of: ANGLES,
    why: 'Without a profile the model renders one when asked and it is a different person.' },
  { key: 'framing', label: 'Close, medium and full', need: 3, of: FRAMINGS,
    why: 'Face pixel count changes what the model learned to reproduce.' },
  { key: 'quality', label: 'Soft and hard light',    need: 2, of: QUALITIES,
    why: 'A set shot only in soft light produces a model that cannot hold a face in harsh sun.' },
];

/**
 * Parse the coverage cell back out of a filename.
 *
 * seed-set.js writes `0001-medium-three-quarter-soft-1234567.png`. Parsing from
 * the LEFT breaks on `three-quarter`, which contains the separator. Parsing from
 * the right — seed, then quality, then a known angle — does not.
 */
function parseCandidate(filename) {
  const stem = String(filename).replace(/\.png$/i, '');
  const parts = stem.split('-');
  if (parts.length < 4) return null;

  const seed = parts.pop();
  const quality = parts.pop();
  if (!QUALITIES.includes(quality)) return null;

  const index = parts.shift();
  const framing = parts.shift();
  if (!FRAMINGS.includes(framing)) return null;

  const angle = parts.join('-');
  if (!ANGLES.includes(angle)) return null;

  return { filename, idx: Number(index), framing, angle, quality, seed };
}

/** What is still missing from a selection. The export gate and the strip share it. */
function coverageGaps(kept) {
  const have = {
    angle:   new Set(kept.map((k) => k.angle)),
    framing: new Set(kept.map((k) => k.framing)),
    quality: new Set(kept.map((k) => k.quality)),
  };
  return COVERAGE
    .map((rule) => ({
      ...rule,
      present: rule.of.filter((v) => have[rule.key].has(v)),
      missing: rule.of.filter((v) => !have[rule.key].has(v)),
    }))
    .filter((r) => r.present.length < r.need);
}

/** Everything the browser needs to draw the gate, without restating it. */
const rules = () => ({
  angles: ANGLES, framings: FRAMINGS, qualities: QUALITIES,
  min_keep: MIN_KEEP, max_keep: MAX_KEEP, coverage: COVERAGE,
});

// ── Signed image URLs ────────────────────────────────────────────────────────

/**
 * A candidate image cannot be fetched with a bearer token.
 *
 * `<img src>` sends no Authorization header, and three hundred thumbnails
 * fetched through JavaScript into blob URLs would defeat lazy loading and hold
 * the whole pool in memory. So the read is authorised the way the upload plane
 * already authorises writes: an HMAC over exactly what is being granted, with
 * an expiry.
 *
 * Signed over tenant AND avatar AND filename, so a token for one image is not a
 * token for another, and a token minted for one workspace does not read
 * another's. Ten minutes is longer than any culling session needs a single URL
 * to stay valid and short enough that a copied link is not a lasting grant.
 *
 * These are training photographs. For a `twin` they are photographs of a real
 * person, which is the reason this is not simply a public path like published
 * media is.
 */
const TTL_MS = Number(process.env.STUDIO_CANDIDATE_URL_TTL_MS || 10 * 60 * 1000);

function signingSecret() {
  const s = process.env.STUDIO_STORAGE_SECRET || process.env.STUDIO_WORKER_TOKEN || process.env.JWT_ACCESS_SECRET;
  if (!s) {
    // Fail closed. An unsigned URL is a forgeable one, and the failure of a
    // missing secret must not be "everything is readable".
    const err = new Error('No secret to sign candidate URLs with — set STUDIO_STORAGE_SECRET.');
    err.status = 503;
    err.code = 'NO_SIGNING_SECRET';
    throw err;
  }
  return s;
}

const payload = (tenantId, avatarId, filename, exp) => `${tenantId}:${avatarId}:${filename}:${exp}`;

function sign(tenantId, avatarId, filename, exp) {
  return crypto.createHmac('sha256', signingSecret())
    .update(payload(tenantId, avatarId, filename, exp))
    .digest('hex');
}

/** The URL the page puts in an `<img>`. */
function signedUrl(tenantId, avatarId, filename, now = Date.now()) {
  const exp = now + TTL_MS;
  const sig = sign(tenantId, avatarId, filename, exp);
  return `/api/studio/avatars/${avatarId}/candidates/img/${encodeURIComponent(filename)}?exp=${exp}&sig=${sig}`;
}

/** Constant-time, and expiry checked before the comparison is even attempted. */
function verify(tenantId, avatarId, filename, exp, sig, now = Date.now()) {
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || expiry < now) return false;

  const expected = Buffer.from(sign(tenantId, avatarId, filename, expiry), 'utf8');
  const given = Buffer.from(String(sig || ''), 'utf8');
  // Length must match before timingSafeEqual, which throws on a mismatch — and
  // the throw itself would be a length oracle.
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

// ── The database ─────────────────────────────────────────────────────────────

/**
 * Register a scanned directory.
 *
 * Upsert rather than insert: the generator may still be running while someone
 * culls, and re-running the registrar must add the new frames without touching
 * the verdicts already recorded on the old ones. `DO UPDATE` on the axes only —
 * `verdict` is deliberately absent from the SET list.
 */
async function register(client, avatarId, files) {
  const parsed = files.map(parseCandidate).filter(Boolean);
  if (!parsed.length) return { registered: 0, skipped: files.length };

  const values = [];
  const params = [];
  parsed.forEach((c, i) => {
    const b = i * 6;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
    params.push(avatarId, c.filename, c.idx, c.angle, c.framing, c.quality);
  });

  const { rowCount } = await client.query(
    `INSERT INTO seed_candidates (avatar_id, filename, idx, angle, framing, quality)
     VALUES ${values.join(', ')}
     ON CONFLICT (avatar_id, filename) DO UPDATE
       SET idx = EXCLUDED.idx, angle = EXCLUDED.angle,
           framing = EXCLUDED.framing, quality = EXCLUDED.quality`,
    params
  );
  return { registered: rowCount, skipped: files.length - parsed.length };
}

/** The pool, its verdicts, and how far off a complete set it is. */
async function list(client, tenantId, avatarId) {
  const { rows } = await client.query(
    // `kind = 'pool'` only. Anchor frames are all one cell, so including them
    // would tell the coverage strip that close/front/soft is six times
    // better covered than it is — and the strip is what the export gate reads.
    `SELECT filename, idx, angle, framing, quality, verdict, storage_key, batch
       FROM seed_candidates
      WHERE avatar_id = $1 AND tenant_id = $2 AND kind = 'pool'
      ORDER BY idx NULLS LAST, filename`,
    [avatarId, tenantId]
  );

  const kept = rows.filter((r) => r.verdict === 'keep');
  return {
    candidates: rows,
    keep:   kept.map((r) => r.filename),
    reject: rows.filter((r) => r.verdict === 'reject').map((r) => r.filename),
    limits: { min: MIN_KEEP, max: MAX_KEEP },
    coverage: COVERAGE,
    gaps: coverageGaps(kept),
  };
}

/** One decision. `verdict` null clears it — which is not the same as rejecting. */
async function mark(client, tenantId, avatarId, filename, verdict, userId) {
  if (verdict !== null && !['keep', 'reject'].includes(verdict)) {
    const err = new Error(`Unknown verdict "${verdict}"`);
    err.status = 400;
    throw err;
  }
  const { rowCount } = await client.query(
    // Both parameters are cast explicitly. Without `$5::int`, Postgres resolves
    // the CASE branches against the other arm — which is a bare NULL — and
    // infers the whole expression as text, then refuses to assign it to an
    // integer column. The error names the column, not the CASE, so it reads as
    // a schema problem rather than a type-inference one.
    `UPDATE seed_candidates
        SET verdict = $4::text,
            decided_at = CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END,
            decided_by = CASE WHEN $4::text IS NULL THEN NULL ELSE $5::int END
      WHERE avatar_id = $1 AND tenant_id = $2 AND filename = $3`,
    [avatarId, tenantId, filename, verdict, userId]
  );
  return rowCount > 0;
}

/**
 * The export gate.
 *
 * Refuses on count and on coverage, and says which. A folder of files cannot
 * enforce either, which is the entire reason culling is a screen.
 */
async function keptForExport(client, tenantId, avatarId) {
  const { rows } = await client.query(
    // `storage_key` included, because it is what says WHERE the picture is.
    // Without it the export could only look on the local disk, and every
    // queue-generated frame — which is every frame the product itself makes —
    // came back as "not on this machine".
    `SELECT filename, idx, angle, framing, quality, storage_key
       FROM seed_candidates
      WHERE avatar_id = $1 AND tenant_id = $2 AND verdict = 'keep' AND kind = 'pool'
      ORDER BY idx NULLS LAST, filename`,
    [avatarId, tenantId]
  );
  const { rows: [{ n }] } = await client.query(
    "SELECT COUNT(*)::int AS n FROM seed_candidates WHERE avatar_id = $1 AND tenant_id = $2 AND kind = 'pool'",
    [avatarId, tenantId]
  );

  if (rows.length < MIN_KEEP) {
    const err = new Error(
      `Only ${rows.length} kept. A seed set needs at least ${MIN_KEEP} — fewer and the model learns the background instead of the face.`);
    err.status = 409; err.code = 'TOO_FEW';
    throw err;
  }
  if (rows.length > MAX_KEEP) {
    const err = new Error(`${rows.length} kept. The cap is ${MAX_KEEP}; past that it is diminishing returns.`);
    err.status = 409; err.code = 'TOO_MANY';
    throw err;
  }

  const gaps = coverageGaps(rows);
  if (gaps.length) {
    const err = new Error('This set has a coverage hole. A model only holds in the conditions it was trained on.');
    err.status = 409; err.code = 'COVERAGE_HOLE';
    err.gaps = gaps.map((g) => `${g.label} — missing ${g.missing.join(', ')}. ${g.why}`);
    throw err;
  }

  return { kept: rows, culledFrom: n };
}

module.exports = {
  ANGLES, FRAMINGS, QUALITIES, MIN_KEEP, MAX_KEEP, COVERAGE,
  parseCandidate, coverageGaps, rules,
  signedUrl, sign, verify, TTL_MS,
  register, list, mark, keptForExport,
};

// ── Generating a pool ────────────────────────────────────────────────────────

/**
 * How many frames a batch may be.
 *
 * The floor is 24. The gate has 18 cells — three framings by three angles by
 * two lights — and the grid walk covers all 18 within any 24 consecutive
 * frames. Below that a batch cannot produce an exportable set however good the
 * frames are, so offering it would be selling somebody a result they cannot
 * use. It also gives no margin: at exactly 18 every single frame would have to
 * be a keeper.
 *
 * The ceiling is 400 because that is the top of the range the culling screen is
 * usable at, and because 400 frames is 400 megapixels — worth a deliberate
 * second batch rather than one slip of a keyboard.
 */
const MIN_BATCH = 24;
const MAX_BATCH = 400;

/** What already exists per gate cell, so a second batch fills the gaps. */
async function cellCounts(client, avatarId) {
  const { rows } = await client.query(
    // `kind = 'pool'` only, and this is load-bearing rather than tidy.
    //
    // This map is what makes a second batch fill the THINNEST cells first. Every
    // anchor frame is close/front/soft, so counting them tells the walk that
    // one gate cell is already well covered — and it then skips it. But anchors
    // are not in the cullable pool (see `list`), so nothing would ever cover
    // close/front/soft and the export gate could never be satisfied. Measured:
    // 24 pool frames after 6 anchors spanned 17 of the 18 gate cells, and the
    // missing one was exactly close/front/soft.
    `SELECT framing, angle, quality, COUNT(*)::int AS n
       FROM seed_candidates
      WHERE avatar_id = $1 AND framing IS NOT NULL AND kind = 'pool'
      GROUP BY framing, angle, quality`,
    [avatarId]
  );
  return new Map(rows.map((r) => [`${r.framing}|${r.angle}|${r.quality}`, r.n]));
}

/** The highest frame number so far, so a second batch continues the numbering. */
async function nextIndex(client, avatarId) {
  const { rows } = await client.query(
    'SELECT COALESCE(MAX(idx), 0)::int AS max FROM seed_candidates WHERE avatar_id = $1',
    [avatarId]
  );
  return rows[0].max + 1;
}

/**
 * Record a finished frame.
 *
 * The axes come from the JOB, not from parsing the filename. The local path
 * encodes them in the name because a directory has nowhere else to put them;
 * a queued job carries its own cell, and re-deriving it from a string the
 * worker composed would be inventing a way to be wrong.
 */
async function recordGenerated(client, { avatarId, filename, idx, cell, seed, storageKey, jobId, batch, kind = 'pool' }) {
  const { rows } = await client.query(
    `INSERT INTO seed_candidates
       (avatar_id, filename, idx, angle, framing, quality, seed, storage_key, job_id, batch, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (avatar_id, filename) DO UPDATE
       SET storage_key = EXCLUDED.storage_key, job_id = EXCLUDED.job_id
     RETURNING id`,
    [avatarId, filename, idx, cell.angle, cell.framing, cell.quality,
     seed === undefined || seed === null ? null : String(seed), storageKey, jobId, batch,
     kind === 'anchor' ? 'anchor' : 'pool']
  );
  return rows[0]?.id || null;
}

/**
 * The faces offered as a choice, and which one was taken.
 *
 * Separate from `list` because they are not part of the pool being culled: six
 * frames of one cell would skew the coverage strip, and the question they
 * answer — "which of these is the person" — is asked once, before the pool
 * exists, rather than forty times afterwards.
 */
async function anchors(client, tenantId, avatarId) {
  const { rows } = await client.query(
    `SELECT c.id, c.filename, c.seed, c.storage_key, c.batch, c.idx,
            -- COALESCE, because "c.id = NULL" is NULL rather than false, and an
            -- avatar with no anchor yet is the ordinary case. Without it every
            -- anchor comes back chosen: null, which is neither true nor false
            -- to anything that reads it.
            COALESCE(c.id = a.anchor_candidate_id, false) AS chosen
       FROM seed_candidates c
       JOIN avatars a ON a.id = c.avatar_id
      WHERE c.avatar_id = $1 AND c.tenant_id = $2 AND c.kind = 'anchor'
      ORDER BY c.idx NULLS LAST, c.filename`,
    [avatarId, tenantId]
  );
  return rows;
}

/**
 * Choose the face.
 *
 * Refuses a candidate that is not an anchor of THIS avatar — the id arrives
 * from a request, and an avatar whose face is another tenant's frame is a
 * cross-tenant read dressed as a preference.
 */
async function chooseAnchor(client, tenantId, avatarId, candidateId) {
  const { rows } = await client.query(
    `SELECT id, storage_key FROM seed_candidates
      WHERE id = $1 AND avatar_id = $2 AND tenant_id = $3 AND kind = 'anchor'`,
    [candidateId, avatarId, tenantId]
  );
  if (!rows[0]) {
    const err = new Error('That is not one of this avatar\'s anchor faces');
    err.status = 404;
    err.code = 'NOT_AN_ANCHOR';
    throw err;
  }
  if (!rows[0].storage_key) {
    // fal FETCHES the reference rather than receiving it, so a frame that only
    // exists as a file in a persona directory cannot be one.
    const err = new Error(
      'That face is a local file rather than a stored one, so it cannot be used as the reference. '
      + 'Generate the faces from the product rather than from the command line.');
    err.status = 409;
    err.code = 'ANCHOR_NOT_STORED';
    throw err;
  }
  await client.query('UPDATE avatars SET anchor_candidate_id = $1 WHERE id = $2 AND tenant_id = $3',
    [candidateId, avatarId, tenantId]);
  return rows[0];
}

/** How a batch is getting on: what was asked for, what has landed, what failed. */
async function batchProgress(client, avatarId, batch) {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM seed_candidates
         WHERE avatar_id = $1 AND batch = $2)                                   AS landed,
       (SELECT COUNT(*)::int FROM render_jobs
         WHERE stage = 'seed_still' AND payload->>'batch' = $2)                 AS jobs,
       (SELECT COUNT(*)::int FROM render_jobs
         WHERE stage = 'seed_still' AND payload->>'batch' = $2 AND status = 'failed') AS failed,
       (SELECT COUNT(*)::int FROM render_jobs
         WHERE stage = 'seed_still' AND payload->>'batch' = $2
           AND status IN ('queued','claimed','running'))                        AS pending`,
    [avatarId, batch]
  );
  return rows[0];
}

module.exports.anchors = anchors;
module.exports.chooseAnchor = chooseAnchor;
module.exports.MIN_BATCH = MIN_BATCH;
module.exports.MAX_BATCH = MAX_BATCH;
module.exports.cellCounts = cellCounts;
module.exports.nextIndex = nextIndex;
module.exports.recordGenerated = recordGenerated;
module.exports.batchProgress = batchProgress;
