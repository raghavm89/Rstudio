'use strict';

const StudioUsage = require('../../models/studioUsage');
const CreditLedger = require('./creditLedger');
const RenderJob = require('../../models/renderJob');
const Seed = require('./seedCandidates');
const SeedPrompt = require('./seedPrompt');
const { createStorage, isPubliclyFetchable } = require('./storageFactory');

/**
 * Queueing a batch of candidate frames.
 *
 * ── Why this is a service and not a controller method ───────────────────────
 * Two things queue a batch: the Generate button on the culling screen, and
 * finishing the New avatar form — because "no photos to choose from yet" with a
 * button on it is a dead end, and the moment somebody has described a face is
 * the moment they want to see it.
 *
 * Both paths spend money, reserve quota, split credits across jobs and rely on
 * an idempotency key. Two copies of that would be two copies that disagree
 * about how much a batch costs, and the one that undercharges is the one nobody
 * reports.
 */

/**
 * What a batch of N frames would cost, in the units the person actually has.
 *
 * ── Counted per avatar, not per month ───────────────────────────────────────
 * Candidate frames used to come out of `still_megapixels`, which is the month's
 * SHOOTING budget. That meant setting an avatar up cost a month of posts — and
 * the arithmetic said no plan could do it even once: a usable pool is about
 * eighty frames and the whole monthly still allowance is 15 on Free, 40 on Pro,
 * 160 on Max.
 *
 * A seed set is a one-off. It is generated once, culled once and trained from
 * once. A monthly budget for a one-off purchase expires unused for everybody
 * not setting up this month and is never enough for anybody who is. So the
 * allowance belongs to the avatar: "this avatar comes with 120 photos to choose
 * from" is a sentence somebody can hold.
 *
 * Megapixels stay out of the answer entirely. Nobody has an intuition for a
 * megapixel; everybody has one for a photo.
 */
async function quote(client, tenantId, count, avatarId = null) {
  const included = await StudioUsage.limitFor(client, tenantId, 'seed_frames', 'lifetime');

  // A quote before the avatar exists — the New avatar form — prices a fresh
  // allowance, which is exactly what a new avatar has.
  let usedForAvatar = 0;
  if (avatarId) {
    const { rows } = await client.query(
      'SELECT seed_frames_used FROM avatars WHERE id = $1 AND tenant_id = $2',
      [avatarId, tenantId]);
    usedForAvatar = Number(rows[0]?.seed_frames_used || 0);
  }
  const includedLeft = Math.max(0, included - usedForAvatar);

  const fromPlan = Math.min(count, includedLeft);
  const overage = count - fromPlan;
  // The rate the ledger charges, not a number typed here. One place decides
  // what a generated frame costs, however it was asked for.
  const creditsNeeded = CreditLedger.creditsFor('still_megapixels', overage * SeedPrompt.MEGAPIXELS_EACH);
  const balance = await CreditLedger.balance(client, tenantId);

  return {
    count,
    megapixels: count * SeedPrompt.MEGAPIXELS_EACH,
    allowance: { included, used: usedForAvatar, left: includedLeft },
    from_plan: fromPlan,
    overage,
    credits_needed: creditsNeeded,
    credits_held: balance,
    credits_short: Math.max(0, creditsNeeded - balance),
    affordable: creditsNeeded <= balance,
    min: Seed.MIN_BATCH,
    max: Seed.MAX_BATCH,
    // The biggest batch this avatar could start right now. What a refusal
    // should offer instead of just refusing.
    affordable_count: affordableCount(includedLeft, balance),
  };
}

/**
 * Take frames from this avatar's allowance, then from credits.
 *
 * ── Why this is not StudioUsage.reserve ─────────────────────────────────────
 * That reserves against (tenant, metric, period). This limit has a fourth
 * dimension — the avatar — and bending a monthly counter into holding a
 * per-avatar cap would have meant a row per avatar in a table keyed by month.
 *
 * The atomicity that matters is still here: the avatar row is locked before it
 * is read, so two tabs cannot both see the same remaining allowance and both
 * spend it.
 *
 * Throws QuotaExceededError, the same shape every other refusal in the product
 * uses, so callers already know how to answer it.
 */
async function reserveFrames(client, tenantId, avatarId, count) {
  // Locked before read. Without this, two batches started at the same instant
  // both see "120 left" and both take it.
  const { rows } = await client.query(
    'SELECT seed_frames_used FROM avatars WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [avatarId, tenantId]);
  if (!rows[0]) {
    const err = new Error('No such avatar');
    err.status = 404;
    throw err;
  }

  const included = await StudioUsage.limitFor(client, tenantId, 'seed_frames', 'lifetime');
  const used = Number(rows[0].seed_frames_used || 0);
  const includedLeft = Math.max(0, included - used);

  const fromPlan = Math.min(count, includedLeft);
  const overage = count - fromPlan;
  const creditsNeeded = CreditLedger.creditsFor('still_megapixels', overage * SeedPrompt.MEGAPIXELS_EACH);

  if (creditsNeeded > 0) {
    const paid = await CreditLedger.spend(
      client, tenantId, 'still_megapixels', creditsNeeded, `seed:${avatarId}:${Date.now()}`);
    if (!paid) {
      const balance = await CreditLedger.balance(client, tenantId);
      const err = new Error(
        `${count} photos needs ${creditsNeeded} credits past this avatar's included ${included}, `
        + `and you hold ${balance}.`);
      err.code = StudioUsage.QUOTA_EXCEEDED;
      err.metric = 'seed_frames';
      err.remaining = includedLeft;
      err.limit = included;
      throw err;
    }
  }

  // Only the plan part increments the avatar's counter. Frames bought with
  // credits were paid for separately and must not eat an allowance that was
  // already spent — otherwise buying more makes the next batch cost more too.
  if (fromPlan > 0) {
    await client.query(
      'UPDATE avatars SET seed_frames_used = seed_frames_used + $2 WHERE id = $1',
      [avatarId, fromPlan]);
  }

  return { from_plan: fromPlan, from_credits: creditsNeeded, included, included_left: includedLeft - fromPlan };
}

/**
 * Give a frame's reservation back.
 *
 * Called when a job fails permanently. The allowance returns to the avatar and
 * the credits return to the ledger — a frame fal refused is a frame nobody got,
 * and charging for it would make failures profitable.
 */
async function releaseFrame(client, { tenantId, avatarId, fromPlan = 0, fromCredits = 0, reference }) {
  if (fromPlan > 0) {
    // GREATEST guards the floor: a double-settle must not drive the counter
    // negative and hand out an allowance nobody paid for.
    await client.query(
      'UPDATE avatars SET seed_frames_used = GREATEST(0, seed_frames_used - $2) WHERE id = $1',
      [avatarId, fromPlan]);
  }
  if (fromCredits > 0) {
    await CreditLedger.refund(client, tenantId, fromCredits, reference, 'seed frame did not generate');
  }
}

/** How many frames the allowance plus the balance actually covers. */
function affordableCount(includedLeft, balance) {
  const framesFromCredits = CreditLedger.unitsFor
    ? Math.floor(CreditLedger.unitsFor('still_megapixels', balance) / SeedPrompt.MEGAPIXELS_EACH)
    : 0;
  return Math.max(0, Math.floor(includedLeft) + framesFromCredits);
}

function clampCount(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return Seed.MIN_BATCH;
  return Math.min(Math.max(n, Seed.MIN_BATCH), Seed.MAX_BATCH);
}

/**
 * Queue one batch.
 *
 * Takes a client so the caller decides the transaction: the Generate button
 * owns its own, and avatar creation wants the batch queued in the SAME one that
 * created the avatar, so a half-created avatar with jobs pointing at it cannot
 * exist.
 *
 * Throws QuotaExceededError with the quote attached — the caller decides
 * whether that is a 402 or a note on an otherwise successful creation.
 */
/**
 * Where the face comes from.
 *
 * A pool frame is generated FROM the anchor rather than alongside it, which is
 * the whole reason the pool is worth culling: text describes a type of person,
 * so independent draws are different people who match the description. Returns
 * null when the avatar has no anchor yet, and a null reference renders exactly
 * as this did before — the old text-only path, still there for every avatar
 * created before any of this existed.
 */
async function anchorReference(client, avatar) {
  if (!avatar.anchor_candidate_id) return null;

  const { rows } = await client.query(
    `SELECT id, filename, storage_key FROM seed_candidates
      WHERE id = $1 AND avatar_id = $2 AND kind = 'anchor'`,
    [avatar.anchor_candidate_id, avatar.id]
  );
  const anchor = rows[0];
  // The anchor was deleted out from under the avatar (the column is ON DELETE
  // SET NULL, but a stale row read is still possible). Falling back to the
  // text-only path is right: it generates something rather than refusing, and
  // the screen can see the avatar is unanchored.
  if (!anchor || !anchor.storage_key) return null;

  return {
    reference_image_url: createStorage().readUrl(anchor.storage_key),
    // Decided here, where the storage driver is known, rather than guessed by
    // the renderer from the shape of a URL. On local disk fal cannot fetch it
    // and the provider pushes the bytes through fal's own storage first.
    publicly_fetchable: isPubliclyFetchable(),
    anchor_candidate_id: anchor.id,
  };
}

/**
 * @param {'pool'|'anchor'} kind  'anchor' queues the handful of independent
 *   draws the customer chooses the face from; 'pool' queues the frames
 *   generated from that choice. One function rather than two because
 *   everything between the two — pricing, the reservation, the credit split,
 *   the idempotency key, the audit line — is identical, and two copies of that
 *   is two copies that disagree about what a frame costs.
 */
async function queue(client, { tenantId, userId, avatar, look, count, ip = null, kind = 'pool' }) {
  const anchoring = kind === 'anchor';
  const frames = anchoring ? SeedPrompt.clampAnchors(count) : clampCount(count);

  const { rows: vocabRows } = await client.query(
    // `option_key`, not `key`. The table has never called it `key`, and
    // guessing produced a query that parsed and failed only when it ran.
    `SELECT facet, option_key, fragment FROM prompt_vocabulary WHERE version = $1 AND active`,
    [look?.vocabulary_version || 1]
  );
  // Missing vocabulary is not fatal here the way it is for a shoot: an absent
  // fragment drops out and the identity block still carries the face. A pool
  // with plainer lighting language is worth more than a refusal.
  const vocab = {};
  for (const v of vocabRows) (vocab[v.facet] ||= {})[v.option_key] = v.fragment;

  const priced = await quote(client, tenantId, frames, avatar.id);

  // Throws QuotaExceededError. Taken for the WHOLE batch: forty jobs that each
  // pass their own check and then run out at frame thirty-one is a
  // half-generated pool nobody asked for and everybody paid for.
  const taken = await reserveFrames(client, tenantId, avatar.id, frames);

  const batch = `${anchoring ? 'a' : 'b'}${Date.now().toString(36)}`;
  const startIndex = await Seed.nextIndex(client, avatar.id);
  const planned = anchoring
    ? SeedPrompt.planAnchors({ avatar, look, vocab, count: frames, startIndex })
    : SeedPrompt.plan({ avatar, look, vocab, count: frames, startIndex,
                        have: await Seed.cellCounts(client, avatar.id) });

  // Anchors are the draws themselves, so they are never generated from one.
  const reference = anchoring ? null : await anchorReference(client, avatar);

  // Whole credits, remainder on the first job. Splitting evenly with a float
  // leaks a fraction on every batch, in our favour, which is the direction that
  // never gets reported.
  const fromCredits = Number(taken?.from_credits || 0);
  const perJob = Math.floor(fromCredits / frames);
  const remainder = fromCredits - perJob * frames;

  // The allowance half is split the same way, because a failed frame has to
  // return exactly what it took — and the first `from_plan` frames are the ones
  // that came out of the allowance.
  const planFrames = Number(taken?.from_plan || 0);

  const jobs = [];
  for (const [i, frame] of planned.entries()) {
    const job = await RenderJob.enqueueTx(client, {
      tenant_id: tenantId,
      stage: 'seed_still',
      runner: 'cloud',
      provider: 'fal',
      // Behind a shoot: someone waiting on a post they are about to publish
      // outranks a pool that will sit unculled for an hour anyway.
      priority: 120,
      label: frame.label,
      payload: {
        avatar_id: avatar.id,
        batch,
        idx: frame.index,
        cell: frame.cell,
        kind,
        generation: {
          prompt: frame.prompt,
          width: SeedPrompt.WIDTH,
          height: SeedPrompt.HEIGHT,
          steps: 24,
          guidance: 3.5,
          seed: frame.seed,
          filenamePrefix: frame.label,
          // Present only when there is a face to hold. Its presence is what
          // makes the provider use the identity-preserving endpoint, so an
          // unanchored avatar renders exactly as it always did.
          ...(reference || {}),
          // No `lora` key at all. The provider refuses a seed job that carries
          // one, because a trained face in the set that defines that face is
          // circular.
        },
        // What this one frame took, so settling it can give exactly that back.
        // `_reserved` stays for the cost-accounting path, which still counts
        // megapixels; `_seed_plan` is the avatar allowance, which is frames.
        _reserved: SeedPrompt.MEGAPIXELS_EACH,
        _seed_plan: i < planFrames ? 1 : 0,
        _from_credits: perJob + (i === 0 ? remainder : 0),
      },
      // A double-clicked button must not buy two pools.
      idempotency_key: `seed:${avatar.id}:${batch}:${frame.index}`,
    });
    if (job) jobs.push(job.id);
  }

  await client.query(
    `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, avatar_id, meta, ip)
     VALUES ($1, $2, 'avatar.candidates.generate', 'avatar', $3, $3, $4::jsonb, $5)`,
    [tenantId, userId, avatar.id,
     JSON.stringify({ batch, kind, count: frames, from_plan: planFrames, from_credits: fromCredits,
                      anchored: Boolean(reference) }), ip]
  );

  return {
    batch, kind, queued: jobs.length,
    anchored: Boolean(reference),
    quote: { ...priced, from_credits: fromCredits },
  };
}

module.exports = { quote, queue, clampCount, affordableCount, reserveFrames, releaseFrame, anchorReference };
