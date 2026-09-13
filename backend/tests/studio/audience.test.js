'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const { audienceForRequest, AUDIENCES } = require('../../src/services/audience');
const requireAudience = require('../../src/middleware/requireAudience');

const req = (user, headers = {}) => ({ user, headers, method: 'GET', originalUrl: '/api/studio/usage' });
function res() {
  const r = { statusCode: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const run = (mw, request) => {
  const response = res();
  let nexted = false;
  mw(request, response, () => { nexted = true; });
  return { response, nexted };
};

// Keep each test honest about the env it depends on.
const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

// ── Deriving the audience ─────────────────────────────────────────────────────

test('audience comes from the Origin, never from the request body', () => {
  withEnv({ AUDIENCE_ORIGINS: 'https://studio.rstudio.app=studio,https://admin.rstudio.app=admin' }, () => {
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://studio.rstudio.app' } }), 'studio');
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://admin.rstudio.app' } }), 'admin');
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://rstudio.app' } }), 'platform');
    // A caller that could nominate its own audience would make the claim useless.
    assert.strictEqual(audienceForRequest({ headers: {}, body: { aud: 'admin' } }), 'platform');
  });
});

test('a trailing slash on the Origin does not defeat the map', () => {
  withEnv({ AUDIENCE_ORIGINS: 'https://studio.rstudio.app=studio' }, () => {
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://studio.rstudio.app/' } }), 'studio');
  });
});

test('an unmapped subdomain still resolves sensibly, so staging is not a surprise', () => {
  withEnv({ AUDIENCE_ORIGINS: null }, () => {
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://studio.staging.rstudio.app' } }), 'studio');
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://admin.staging.rstudio.app' } }), 'admin');
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://app.rstudio.app' } }), 'platform');
  });
});

test('with no configuration at all, everything is platform — existing behaviour unchanged', () => {
  withEnv({ AUDIENCE_ORIGINS: null }, () => {
    assert.strictEqual(audienceForRequest({ headers: {} }), 'platform');
  });
});

test('a junk mapping is ignored rather than creating a bogus audience', () => {
  withEnv({ AUDIENCE_ORIGINS: 'https://evil.example=superuser,=studio,garbage' }, () => {
    assert.strictEqual(audienceForRequest({ headers: { origin: 'https://evil.example' } }), 'platform');
  });
});

// ── Enforcing it ──────────────────────────────────────────────────────────────

test('a studio token passes a studio route', () => {
  const { nexted } = run(requireAudience('studio', 'admin'), req({ id: 1, aud: 'studio' }));
  assert.strictEqual(nexted, true);
});

test('THE POINT: a dashboard token is refused on a Studio route', () => {
  const { response, nexted } = run(requireAudience('studio', 'admin'), req({ id: 1, aud: 'platform' }));
  assert.strictEqual(nexted, false);
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(response.body.code, 'TOKEN_AUDIENCE_MISMATCH');
});

test('a cross-app token is refused even during the grace period', () => {
  // Otherwise the grace period would defeat the entire reason for the claim.
  withEnv({ ENFORCE_TOKEN_AUDIENCE: null }, () => {
    const { response, nexted } = run(requireAudience('studio'), req({ id: 1, aud: 'platform' }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(response.statusCode, 403);
  });
});

test('a legacy token with no aud is allowed while enforcement is off', () => {
  withEnv({ ENFORCE_TOKEN_AUDIENCE: null }, () => {
    const { nexted } = run(requireAudience('studio'), req({ id: 1 }));
    assert.strictEqual(nexted, true, 'turning this on must not sign everyone out mid-session');
  });
});

test('a legacy token is refused once enforcement is switched on', () => {
  withEnv({ ENFORCE_TOKEN_AUDIENCE: 'true' }, () => {
    const { response, nexted } = run(requireAudience('studio'), req({ id: 1 }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(response.body.code, 'TOKEN_AUDIENCE_MISSING');
  });
});

test('admin can operate Studio, because support needs to without a second login', () => {
  const { nexted } = run(requireAudience('studio', 'admin'), req({ id: 1, aud: 'admin' }));
  assert.strictEqual(nexted, true);
});

test('the middleware refuses to be constructed with a nonsense audience', () => {
  assert.throws(() => requireAudience('wizard'), /at least one of/);
  assert.throws(() => requireAudience(), /at least one of/);
});

test('the audience vocabulary is closed', () => {
  assert.deepStrictEqual(AUDIENCES, ['platform', 'studio', 'admin']);
});
