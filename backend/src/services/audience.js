'use strict';

/**
 * Token audience — which app a session belongs to.
 *
 * Right now the access token is signed as `{ id, email, role, tenant_id }` with
 * no `aud`, which means a token minted for the rstudio.app dashboard is equally
 * valid on every Studio endpoint, and the reverse. With one app that is merely
 * untidy. With two on separate subdomains it is the exact thing the internal
 * dashboard spec already warns about:
 *
 *   "An admin's session should never accidentally grant access to a client's
 *    data through browser state."
 *
 * Same argument, now across two apps.
 *
 * The audience is derived from the ORIGIN the login came from, not from a field
 * in the request body — a caller must not be able to nominate its own audience,
 * or the claim proves nothing.
 */

const AUDIENCES = ['platform', 'studio', 'admin'];
const DEFAULT_AUDIENCE = 'platform';
const ISSUER = 'rstudio';

/**
 * `AUDIENCE_ORIGINS` maps origin → audience, e.g.
 *   https://studio.rstudio.app=studio,https://admin.rstudio.app=admin
 * Anything unlisted falls back to `platform`, so existing behaviour is unchanged
 * until the map is populated.
 */
function originMap() {
  const raw = process.env.AUDIENCE_ORIGINS || '';
  const map = new Map();
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [origin, audience] = pair.split('=').map((s) => (s || '').trim());
    if (origin && AUDIENCES.includes(audience)) map.set(origin.replace(/\/+$/, ''), audience);
  }
  return map;
}

/** Resolve the audience for a login request. */
function audienceForRequest(req) {
  const origin = (req.headers?.origin || '').replace(/\/+$/, '');
  if (origin) {
    const mapped = originMap().get(origin);
    if (mapped) return mapped;
    // A subdomain convention as a fallback, so a new environment (staging,
    // preview) behaves sensibly before anyone remembers to update the env var.
    try {
      const host = new URL(origin).hostname;
      if (host.startsWith('studio.')) return 'studio';
      if (host.startsWith('admin.'))  return 'admin';
    } catch { /* not a URL — fall through */ }
  }
  return DEFAULT_AUDIENCE;
}

module.exports = { AUDIENCES, DEFAULT_AUDIENCE, ISSUER, audienceForRequest, originMap };
