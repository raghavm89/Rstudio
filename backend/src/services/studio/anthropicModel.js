'use strict';

/**
 * Which Anthropic model to use — resolved against the account, not hardcoded.
 *
 * Pinned ids age out: "claude-3-5-haiku-latest" 404s once retired. So unless an
 * env override is set, ask the key which models it can actually use and pick the
 * cheapest sensible one (a Haiku, else a Sonnet, else whatever is first).
 * Cached for the life of the process.
 */

let cached = null;

async function pickModel(llm, preferred) {
  if (preferred) return preferred;                 // explicit env override always wins
  if (cached) return cached;
  try {
    const page = await llm.models.list({ limit: 100 });
    const ids = ((page && (page.data || page.models)) || []).map((m) => m && m.id).filter(Boolean);
    const pick = ids.find((i) => /haiku/i.test(i)) || ids.find((i) => /sonnet/i.test(i)) || ids[0];
    if (pick) { cached = pick; return pick; }
  } catch (_) { /* fall through to the last-resort default */ }
  return 'claude-3-5-haiku-latest';
}

module.exports = { pickModel };
