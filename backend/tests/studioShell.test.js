'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * The app shell: routes that exist, and one design system.
 *
 * Renaming a route touches a dozen files and every one of them fails the same
 * quiet way — a link that 404s, which nobody notices until they click it. And
 * two of the references that LOOK like the renamed route are API paths that must
 * not move, so a careless find-and-replace breaks the look screen instead.
 */

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const routeFile = (r) => (r === '/' ? path.join(FE, 'app', 'page.jsx')
                                    : path.join(FE, 'app', r.replace(/^\//, ''), 'page.jsx'));

test('every sidebar destination has a page', () => {
  const src = read(path.join(FE, 'components', 'Shell.jsx'));
  const hrefs = [...src.matchAll(/href: '(\/[a-z-]*)'/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 5, 'found almost no nav items — has the shell changed shape?');
  const missing = hrefs.filter((r) => !fs.existsSync(routeFile(r)));
  assert.deepStrictEqual(missing, [], `nav points at routes with no page: ${missing.join(', ')}`);
});

test('the avatar route and the API path agree', () => {
  // /api/studio/avatars/:id/look is the BACKEND's name for the resource, and it
  // is still an avatar. Only the screen was renamed. A find-and-replace that
  // took these too would break the look screen with a 404 from the API.
  const look = read(path.join(FE, 'app', 'avatars', '[id]', 'look', 'page.jsx'));
  assert.match(look, /useResource\(`\/avatars\//, 'the look screen must still call the avatars API');

  // /studio was this section's route for about an hour. Studio is the whole
  // dashboard, so the section inside it cannot share the name.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.jsx?$/.test(e.name)) continue;
      const src = read(p);
      for (const m of src.matchAll(/href=(?:"|\{`)(\/studio[^"`]*)/g)) {
        offenders.push(`${path.relative(FE, p)}: ${m[1]}`);
      }
    }
  };
  walk(path.join(FE, 'app'));
  walk(path.join(FE, 'components'));
  assert.deepStrictEqual(offenders, [], `links point at the retired route:\n    ${offenders.join('\n    ')}`);
});

test('the old route still redirects, with its tail', () => {
  const cfg = read(path.join(FE, 'next.config.js'));
  assert.match(cfg, /source: '\/studio'/,          'no redirect for the index');
  assert.match(cfg, /source: '\/studio\/:path\*'/, 'no redirect for the children — a link mid-setup would land on the index');
});

test('the password screens are reachable without a session', () => {
  // They are for people who cannot sign in. Left out of PUBLIC_ROUTES the guard
  // bounces the emailed link to /login and the reset dead-ends one click from
  // the end.
  const src = read(path.join(FE, 'components', 'AuthProvider.jsx'));
  const m = src.match(/const PUBLIC_ROUTES = (\[[^\]]*\])/);
  assert.ok(m, 'PUBLIC_ROUTES not found');
  const routes = JSON.parse(m[1].replace(/'/g, '"'));
  for (const r of ['/forgot-password', '/reset-password', '/login', '/signup', '/auth/callback', '/']) {
    assert.ok(routes.includes(r), `${r} must be public`);
  }
  assert.ok(!routes.includes('/studio'), '/studio must stay guarded');
});

test('the app and the landing page share one palette', () => {
  // The complaint that started this: signing in felt like a different company.
  const app = read(path.join(FE, 'app', 'globals.css'));
  const lp  = read(path.join(FE, 'app', 'landing.css'));

  for (const token of ['#F6F3EC', '#14120F', '#D9D2C4', '#5B3DF5']) {
    assert.ok(app.includes(token), `the app is missing the shared value ${token}`);
    assert.ok(lp.includes(token),  `the landing page is missing the shared value ${token}`);
  }
  // And the didone must be available to the app, not just declared on the page.
  assert.match(app, /--display:\s*'Bodoni Moda'/, 'the app has no display face');
  assert.match(app, /h1 \{[\s\S]{0,120}var\(--display\)/, 'page titles should use the display face');
});

test('the sidebar names the dashboard once, and offers a way out', () => {
  // Studio is the whole dashboard, so the wordmark belongs at the top — once.
  // The section below it is Avatar, which is why they no longer collide.
  const src = read(path.join(FE, 'components', 'Shell.jsx'));
  assert.match(src, /brand-name">Rstudio</, 'the sidebar should name the dashboard');
  assert.ok(!/label: 'Studio'/.test(src), 'no nav item may also be called Studio');
  // The app had no route back to the public site at all.
  assert.match(src, /brand-out/, 'there should be a link back to the landing page');
});

test('the sign-out button is the same button as everywhere else', () => {
  const src = read(path.join(FE, 'components', 'Shell.jsx'));
  const m = src.match(/className="([^"]*)"[^>]*onClick=\{signOut\}/);
  assert.ok(m, 'sign out button not found');
  // `ghost tiny` is not a button class — no `.btn`, so it inherited the
  // browser's default chrome and matched nothing in the product.
  assert.match(m[1], /\bbtn\b/, `sign out uses "${m[1]}", which is not the shared button`);
});

test('the product copy does not decide the customer\'s persona for them', () => {
  // Aanya is one persona. A product sold to creators that says "her" throughout
  // has quietly chosen for everyone who wanted to build someone else.
  const files = [
    ['components', 'Shell.jsx'],
    ['app', 'avatars', 'page.jsx'],
    ['app', 'avatars', '[id]', 'face', 'page.jsx'],
    ['app', 'avatars', '[id]', 'look', 'page.jsx'],
    ['app', 'avatars', '[id]', 'shoot', 'page.jsx'],
    ['app', 'insights', 'page.jsx'],
  ];
  const offenders = [];
  for (const parts of files) {
    const p = path.join(FE, ...parts);
    // Comments explaining the decision are allowed to name it.
    const src = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/\b(her|she|his|him)\b/gi)) {
      offenders.push(`${parts.join('/')}: "${m[1]}"`);
    }
  }
  assert.deepStrictEqual(offenders, [], `gendered copy in the app:\n    ${offenders.join('\n    ')}`);
});

test('the usage meter reads the shape the API returns', () => {
  // `summary()` answers an object keyed by metric. The meter called .find() on
  // it — `?.` meant no error, just undefined, and the `|| 240` fallback turned
  // that into a confident "0 / 240s". It had never shown a real number.
  const src = read(path.join(FE, 'components', 'Shell.jsx'));
  assert.ok(!/usage\?\.usage\?\.find/.test(src), 'the meter must not treat the summary as an array');
  assert.match(src, /usage\?\.usage\?\.video_seconds/, 'the meter should key into the metric');

  const model = read(path.join(ROOT, 'src', 'models', 'studioUsage.js'));
  assert.match(model, /out\[metric\] = \{/, 'summary() should still be keyed by metric — if this changed, the meter must too');
});

test('the profile endpoint is not folded into the hot path', () => {
  // /me runs on every cold start and provisions a workspace. Billing details
  // have no business on that request.
  const routes = read(path.join(ROOT, 'src', 'routes', 'studio.js'));
  assert.match(routes, /router\.get\('\/profile'/);
  assert.match(routes, /router\.put\('\/profile'/);

  const me = read(path.join(ROOT, 'src', 'controllers', 'studioMeController.js'));
  assert.ok(!/gstin|billing_/.test(me), '/me must not carry billing fields');
});

test('billing validation refuses what an invoice cannot use', () => {
  const c = require('../src/controllers/studioProfileController');
  assert.strictEqual(c.IN_STATES.length, 36, 'expected 36 Indian states and union territories');
  assert.ok(c.GSTIN_SHAPE.test('27AAPFU0939F1ZV'), 'a well-formed GSTIN must pass');
  for (const bad of ['27AAPFU0939F1Z', '27AAPFU0939F1ZVX', 'AAPFU0939F1ZV27', '']) {
    assert.ok(!c.GSTIN_SHAPE.test(bad), `${bad || '(empty)'} should not pass the shape check`);
  }
  // The state must be its own column — it decides CGST+SGST versus IGST.
  assert.ok(c.BILLING_FIELDS.includes('billing_state'));
  assert.ok(c.BILLING_FIELDS.includes('gstin'));
});
