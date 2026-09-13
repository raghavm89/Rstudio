'use strict';

const Provisioning = require('../services/studio/provisioning');

/**
 * GET /api/studio/me — what the Studio frontend asks first.
 *
 * Three jobs in one call, because they are the same question asked three ways:
 * who is this, do they have a workspace, and is the token in their hand still
 * accurate.
 *
 * It PROVISIONS rather than merely reporting, which covers the case a signup
 * hook cannot: an existing rstudio.app account that arrives at Studio for the
 * first time. That person verified their email months ago, so nothing in the
 * signup path will ever run for them again — yet they have no workspace and
 * every Studio screen would be empty. Doing it here means "has a workspace" is
 * true by the time anything needs it, whichever door they came through.
 */
async function me(req, res) {
  const result = await Provisioning.bootstrap({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name || null,
    role: req.user.role,
    tenant_id: req.user.tenant_id ?? null,
  });

  // `token_stale` is not advice, it is a correctness signal: the caller's token
  // predates the workspace and still claims `tenant_id: null`. Studio reads the
  // tenant from that claim, so acting on this token would scope every query to
  // nothing. The client refreshes before rendering.
  res.json(result);
}

module.exports = { me };
