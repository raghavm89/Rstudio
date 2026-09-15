'use strict';

/**
 * Which Anthropic model to use — resolved against the account, not hardcoded.
 *
 * Pinned ids age out: "claude-3-5-haiku-latest" 404s once retired. So unless an
 * env override is set, ask the key which models it can actually use and pick the
 * cheapest sensible one (a Haiku, else a Sonnet, else whatever is first).
 * Cached for the life of the process.
 */

const cached = {};

/**
 * Resolve a model from the account. `prefer` picks the tier when nothing is
 * pinned: 'haiku' (default) for cheap high-volume work (captions, the plan
 * draft), 'sonnet' for judgement work (the plan reviewer). An explicit
 * `preferred` id always wins. Cached per tier for the process.
 */
async function pickModel(llm, preferred, { prefer = 'haiku' } = {}) {
  if (preferred) return preferred;                 // explicit env override always wins
  if (cached[prefer]) return cached[prefer];
  // Tier preference, best-effort: opus for judgement (the plan reviewer), sonnet
  // for solid drafting, haiku for cheap high-volume. Each falls back DOWN the
  // ladder if its tier is not on the account, so a missing Opus becomes Sonnet.
  const order = prefer === 'opus' ? [/opus/i, /sonnet/i, /haiku/i]
    : prefer === 'sonnet' ? [/sonnet/i, /haiku/i, /opus/i]
    : [/haiku/i, /sonnet/i];
  try {
    const page = await llm.models.list({ limit: 100 });
    const ids = ((page && (page.data || page.models)) || []).map((m) => m && m.id).filter(Boolean);
    let pick = null;
    for (const re of order) { pick = ids.find((i) => re.test(i)); if (pick) break; }
    pick = pick || ids[0];
    if (pick) { cached[prefer] = pick; return pick; }
  } catch (_) { /* fall through to the last-resort default */ }
  // Can't read the list: don't guess an Opus id that may 404 — a known Sonnet is
  // the safe premium fallback, a known Haiku the safe cheap one.
  return prefer === 'haiku' ? 'claude-3-5-haiku-latest' : 'claude-3-5-sonnet-latest';
}

module.exports = { pickModel };
