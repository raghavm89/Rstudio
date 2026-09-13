'use strict';

/**
 * Credits — what a customer sees, over the meters the system actually keeps.
 *
 * The pricing decision on record is to meter in generated video seconds, because
 * a second maps one-to-one onto the Seedance bill and an abstract unit does not.
 * Credits do not replace that. They are a rate card applied to the same counters
 * at read time:
 *
 *     1 credit  = 1 second of generated video
 *     2 credits = 1 megapixel of stills
 *
 * Nothing is stored in credits. A balance table decremented alongside the
 * counters would be two records of one fact, and they would disagree the first
 * time a job died between the two writes — which is exactly the sort of
 * disagreement nobody notices until a customer is billed for it.
 *
 * The anchor is deliberate: at 1 credit per second, "240 credits" and "240
 * seconds" are the same sentence, so a person can still reason about what they
 * spent. Change RATES and that stops being true — which is the point at which
 * this file needs a much longer comment than this one.
 */

/**
 * Metered unit → credits. A metric absent here does not consume credits.
 *
 * ── The rule, stated once ───────────────────────────────────────────────────
 * **Every step that spends our money at a supplier costs the customer credits.**
 * If fal bills us for it, there is a rate here for it. If it runs on our own
 * hardware — face embedding, prompt assembly, culling — there is not, and that
 * absence is the statement rather than an omission.
 *
 * `lora_trainings` and `lora_calibrations` used to be absent, which made
 * building an avatar free. The argument was that the plan says how many avatars
 * you may have and training is what an avatar IS, so charging again was
 * charging twice. It did not survive the arithmetic:
 *
 *   • A build is ~₹431 of supplier cost (₹200 training, ₹231 calibration), and
 *     retraining was unbounded — every retrain writes a new `avatar_loras`
 *     version, and baselines are keyed per LoRA, so the whole calibration is
 *     re-bought. Nothing counted cycles.
 *   • Free holds 130 credits a month against a build that costs 252, so pricing
 *     is now what stops a free account training a custom LoRA — the job the
 *     `faces_claimed` entitlement was supposed to do and never did, because
 *     nothing ever read it.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 * A credit sells for about ₹2.35 (Pro 850/₹2,000, Max 2,600/₹6,000, top-up
 * 210/₹500). A 1 MP still costs us ₹3.50 and is priced at 2 credits — ₹4.70,
 * a 34% margin. Both rates below hold that same ratio rather than inventing a
 * second one:
 *
 *   lora_calibrations  a calibration frame IS a 1 MP still, so it is the still
 *                      rate. A default run is 66 frames — 132 credits.
 *   lora_trainings     ₹200 flat at fal → 120 credits (₹282).
 */
const RATES = {
  /**
   * The content wallet's own unit. A credit is a credit, so its overage and
   * refund conversions (CreditLedger.creditsFor) are 1:1 — this is what lets the
   * one metric-agnostic reserve/settle path meter the wallet directly. The
   * per-piece rate card that turns a render into credits lives in creditCost.js;
   * the per-unit rates below are the BUILD-time ledger conversions (seed frames,
   * calibration, training), not the content wallet.
   */
  credits:           1,
  video_seconds:     1,
  still_megapixels:  2,
  /** Per training run. One run, one charge, whatever it costs us to retry it. */
  lora_trainings:    120,
  /**
   * Per FRAME, not per run — a run is 66 frames by default and 396 at the
   * widest the endpoint allows. Charging per run would price those the same,
   * and the wide one costs us six times as much.
   */
  lora_calibrations: 2,
};

/** How each metric reads on a page, so the UI does not invent its own names. */
const LABELS = {
  credits:          { label: 'Credits',         unit: ''   },
  video_seconds:    { label: 'Video',           unit: 's'  },
  still_megapixels: { label: 'Stills',          unit: 'MP' },
  publishes:        { label: 'Posts published', unit: ''   },
  avatars:          { label: 'Avatars',         unit: ''   },
  lora_trainings:   { label: 'Models trained',  unit: ''   },
  lora_calibrations:{ label: 'Calibration photos', unit: '' },
  faces_claimed:    { label: 'Faces claimed',   unit: ''   },
};

const round = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Turn a usage summary into a credit position.
 *
 * `summary` is what `StudioUsage.summary()` answers: an object keyed by metric,
 * each with { used, limit, remaining, period, cost_cents }.
 *
 * Only MONTHLY metrics count toward the allowance. Lifetime ones — avatars,
 * faces claimed — are caps on what you may have, not on what you may spend, and
 * folding them in would make a credit mean two different things.
 */
function creditPosition(summary = {}) {
  /**
   * Wallet-first. The enforced monthly balance is now a single `credits` metric
   * (migration 056) — one currency the customer spends per piece. When it is
   * present it IS the position; there is nothing to derive.
   */
  const wallet = summary.credits;
  if (wallet && wallet.period === 'month') {
    const included = Number(wallet.limit ?? 0);
    const used     = Number(wallet.used ?? 0);
    return {
      included:  round(included),
      used:      round(used),
      remaining: round(Math.max(0, included - used)),
      breakdown: [{
        metric:        'credits',
        label:         LABELS.credits?.label ?? 'Credits',
        unit:          '',
        rate:          1,
        units_used:    round(used),
        units_limit:   round(included),
        credits:       round(used),
        credits_limit: round(included),
      }],
    };
  }

  // Legacy fallback: derive credits from the per-unit meters, for any caller
  // still passing a pre-wallet summary (kept so nothing breaks mid-migration).
  const breakdown = [];
  let used = 0;
  let included = 0;

  for (const [metric, rate] of Object.entries(RATES)) {
    const row = summary[metric];
    if (!row || row.period !== 'month') continue;

    const unitsUsed  = Number(row.used ?? 0);
    const unitsLimit = Number(row.limit ?? 0);
    const spent      = unitsUsed * rate;

    used     += spent;
    included += unitsLimit * rate;

    breakdown.push({
      metric,
      label:      LABELS[metric]?.label ?? metric,
      unit:       LABELS[metric]?.unit ?? '',
      rate,
      units_used:  round(unitsUsed),
      units_limit: round(unitsLimit),
      credits:     round(spent),
      credits_limit: round(unitsLimit * rate),
    });
  }

  return {
    included:  round(included),
    used:      round(used),
    // Never below zero. A negative remaining is arithmetic leaking onto a page:
    // the honest statement past the cap is "none left", and the overage belongs
    // in the per-metric row that caused it.
    remaining: round(Math.max(0, included - used)),
    breakdown,
  };
}

module.exports = { RATES, LABELS, creditPosition };
