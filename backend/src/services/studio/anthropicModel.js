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
  const order = prefer === 'sonnet' ? [/sonnet/i, /haiku/i] : [/haiku/i, /sonnet/i];
  try {
    const page = await llm.models.list({ limit: 100 });
    const ids = ((page && (page.data || page.models)) || []).map((m) => m && m.id).filter(Boolean);
    let pick = null;
    for (const re of order) { pick = ids.find((i) => re.test(i)); if (pick) break; }
    pick = pick || ids[0];
    if (pick) { cached[prefer] = pick; return pick; }
  } catch (_) { /* fall through to the last-resort default */ }
  return prefer === 'sonnet' ? 'claude-3-5-sonnet-latest' : 'claude-3-5-haiku-latest';
}

module.exports = { pickModel };
