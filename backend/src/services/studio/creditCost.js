'use strict';

/**
 * The rate card, in credits.
 *
 * This is the per-piece pricing settled on 13 Sep 2026 (see
 * claude/credit-denomination-settled.md). It is the one place that turns a
 * thing we are about to render into what it costs the customer, and it is a
 * PURE function of the piece — no database, no tenant, no allowance. Reserve
 * and settle live in StudioUsage; this only says how many credits a piece is.
 *
 * The anchor is a still: one delivered 1 MP photo = 1 credit, chosen because a
 * credit is then ≈ ₹4.50 of our supplier cost and spending a whole wallet
 * reproduces the frozen ~34–48% margins. Everything else is priced relative to
 * that, roughly by supplier cost ÷ ₹4.50:
 *
 *     Still (1 MP)                 1
 *     Budget lipsync   (≤40s)      6     flat, per piece
 *     Premium lipsync  (30s)      35     flat, per piece
 *     Max lipsync      (30s)      48     flat, per piece
 *     Generative reel  480p       50 per 30s   → 5/3 credits/second
 *     Generative reel  720p      100 per 30s   → 10/3 credits/second
 *
 * ── Per piece, not per second ────────────────────────────────────────────────
 * A lipsync video is a flat charge whatever its length: the supplier cost of a
 * talking-head clip is dominated by the model call, not the runtime, so a 12s
 * take and a 38s take cost us about the same and are priced the same. A
 * GENERATIVE reel is different — every second is a fresh image-to-video call
 * that fal bills for — so it is priced per second, anchored so that the
 * headline 30s reel lands exactly on the rate-card number (50 at 480p, 100 at
 * 720p). Charging a generative reel flat would either overcharge a 5s loop or
 * undercharge a 60s one; charging lipsync per second would punish a customer
 * for a pause.
 *
 * ── Why a stills candidate does not multiply the price ───────────────────────
 * A paid shoot renders four candidates per frame and QC keeps the best. Those
 * three extra frames are our cost, not the customer's line item: they pay for
 * one DELIVERED photo, one credit, whatever we burned to make it good. That
 * spend is still recorded — on render_jobs.cost_cents per job — so the margin
 * is visible; it just does not reach the wallet.
 */

/** One delivered photo. Candidates are a cost, not a charge — see above. */
const STILL_CREDITS = 1;

/**
 * Generative reel, credits per second, by output resolution. Anchored on the
 * 30s rate-card price so a 30s reel is exactly 50 (480p) or 100 (720p).
 */
const VIDEO_PER_SECOND = {
  '480p': 50 / 30,
  '720p': 100 / 30,
};
const DEFAULT_RESOLUTION = '480p';

/** Lipsync, flat per piece, by tier. */
const LIPSYNC_CREDITS = {
  budget:  6,
  premium: 35,
  max:     48,
};
const DEFAULT_LIPSYNC_TIER = 'budget';

/** Round to the 2 decimals studio_usage_counters.used actually stores. */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Credits for one rendered piece.
 *
 * @param {object} piece
 * @param {string} piece.stage        'still' | 'motion' | 'lipsync'
 * @param {number} [piece.seconds]    clip length, for a generative reel (motion)
 * @param {string} [piece.resolution] '480p' | '720p', for a generative reel
 * @param {string} [piece.lipsyncTier]'budget' | 'premium' | 'max'
 * @returns {number} credits, rounded to 2 dp. A stage with no rate costs 0 —
 *                   the same statement `credits.js` makes about own-hardware
 *                   steps: absence is "we do not charge for this", not a gap.
 */
function creditCostFor({ stage, seconds, resolution, lipsyncTier } = {}) {
  switch (stage) {
    case 'still':
      return STILL_CREDITS;

    case 'motion': {
      const rate = VIDEO_PER_SECOND[resolution] ?? VIDEO_PER_SECOND[DEFAULT_RESOLUTION];
      const secs = Number(seconds);
      if (!(secs > 0)) return 0;
      return round2(secs * rate);
    }

    case 'lipsync':
      return LIPSYNC_CREDITS[lipsyncTier] ?? LIPSYNC_CREDITS[DEFAULT_LIPSYNC_TIER];

    default:
      return 0;
  }
}

module.exports = {
  creditCostFor,
  STILL_CREDITS,
  VIDEO_PER_SECOND,
  LIPSYNC_CREDITS,
  DEFAULT_RESOLUTION,
  DEFAULT_LIPSYNC_TIER,
};
