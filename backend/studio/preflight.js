#!/usr/bin/env node
'use strict';

/**
 * Studio preflight — checks what is actually wired before you go looking for it.
 *
 * Every check here corresponds to a failure that is otherwise diagnosed several
 * steps later and somewhere unhelpful: a 413 on a training request, a worker
 * that never claims anything, a shoot that renders fine and then cannot be
 * published because storage is on a laptop.
 *
 *   node studio/preflight.js
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');

let bad = 0;
const ok   = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); bad += 1; };

console.log('\nStudio preflight\n');

// ── Wiring ────────────────────────────────────────────────────────────────────
console.log('Wiring');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
app.includes("app.use('/api/studio'") ? ok('routes mounted in app.js')
                                      : fail("app.js does not mount '/api/studio'");
app.includes('serverRunner')          ? ok('server runner started')
                                      : fail('app.js does not start the server runner');

const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'authController.js'), 'utf8');
auth.includes('audienceForRequest')   ? ok('auth patch applied')
                                      : fail('authController.js is missing the aud claim');

for (const m of ['services/studio/promptStage', 'services/studio/calibration',
                 'services/studio/storageFactory', 'routes/studio']) {
  try { require(path.join(__dirname, '..', 'src', m)); ok(`${m} resolves`); }
  catch (err) { fail(`${m}: ${err.message}`); }
}

// ── Database ──────────────────────────────────────────────────────────────────
console.log('\nDatabase');
(async () => {
  const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
  try {
    const { rows: t } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
        ('avatars','avatar_loras','look_profiles','render_jobs','studio_projects',
         'expression_baselines','expression_presets','prompt_vocabulary')`
    );
    const have = new Set(t.map((r) => r.table_name));
    for (const name of ['avatars','avatar_loras','look_profiles','render_jobs',
                        'studio_projects','expression_baselines','expression_presets','prompt_vocabulary']) {
      have.has(name) ? ok(`table ${name}`) : fail(`table ${name} missing — run migrations 026-032`);
    }

    const { rows: c } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='render_jobs' AND column_name='cost_cents'`
    );
    c[0]?.data_type === 'numeric'
      ? ok('cost_cents is numeric (032 applied)')
      : fail('cost_cents is still integer — migration 032 did not apply');

    const { rows: v } = await pool.query('SELECT COUNT(*)::int n FROM prompt_vocabulary WHERE active');
    v[0].n > 0 ? ok(`${v[0].n} vocabulary rows`) : fail('prompt_vocabulary is empty — run migration 030');

    const { rows: p } = await pool.query('SELECT COUNT(*)::int n FROM expression_presets WHERE enabled');
    p[0].n > 0 ? ok(`${p[0].n} expression presets`) : fail('no expression presets — run migration 030');
  } catch (err) {
    fail(`cannot query: ${err.message}`);
  }

  // ── Configuration ───────────────────────────────────────────────────────────
  console.log('\nConfiguration');

  // "Set" and "correct" are different things. A typo'd key does not announce
  // itself — it surfaces as every job cycling through its attempt budget, which
  // reads as "generation is slow" rather than "your key is wrong". So the key is
  // actually exercised against fal unless --offline is passed.
  if (!process.env.FAL_KEY) {
    fail('FAL_KEY is not set — nothing can generate. Get one at https://fal.ai/dashboard/keys');
  } else if (process.argv.includes('--offline')) {
    ok('FAL_KEY set (not verified — --offline)');
  } else {
    // Exercise the exact call the worker makes on the local-storage path, not a
    // generic ping. `storage_type=fal-cdn-v3` is required — omitting it returns
    // 403, which reads as "your key is revoked" and is not: on fal, 403 means the
    // key is valid but lacks scope for the endpoint AS ADDRESSED, and 401 is the
    // bad-key case. That distinction cost a debugging round trip, so the check
    // reports it explicitly rather than lumping both into "check the key".
    try {
      const res = await fetch(
        'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
        {
          method: 'POST',
          headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content_type: 'text/plain', file_name: 'preflight.txt' }),
        }
      );
      if (res.ok) {
        ok('FAL_KEY verified — storage upload works, so training and video will too');
      } else if (res.status === 401) {
        fail('FAL_KEY rejected (401) — the key is wrong or revoked. https://fal.ai/dashboard/keys');
      } else if (res.status === 403) {
        fail('FAL_KEY refused (403) — the key is valid but lacks scope for storage. '
           + 'Check it is an API-scope key, and that the account has billing set up.');
      } else {
        warn(`fal answered ${res.status} — the key may be fine but fal is unhappy`);
      }
    } catch (err) {
      warn(`could not reach fal to verify the key: ${err.message}`);
    }
  }

  process.env.STUDIO_WORKER_TOKEN ? ok('STUDIO_WORKER_TOKEN set')
                                  : fail('STUDIO_WORKER_TOKEN is not set — worker routes fail closed with 503');

  const { createStorage, storageDriver, isPubliclyFetchable } =
    require(path.join(__dirname, '..', 'src', 'services', 'studio', 'storageFactory'));
  const driver = storageDriver();
  try {
    const s = createStorage();
    if (s.configured) {
      ok(`storage driver "${driver}" configured`);
      if (driver === 'local') {
        const dir = process.env.STUDIO_STORAGE_DIR || path.join(process.cwd(), 'studio-storage');
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        ok(`storage dir writable: ${dir}`);

        // Sign, redeem and read back one object. The directory being writable is
        // not the same as the upload path working end to end.
        const t = s.uploadTarget({
          tenantId: 0, avatarSlug: '_preflight', projectId: 'check', kind: 'asset',
          filename: 'ping.png', contentType: 'image/png',
        });
        const q = Object.fromEntries(new URL(t.url).searchParams);
        s.put(q.key, { contentType: q.ct, expiresAt: q.exp, signature: q.sig, body: Buffer.from('ping') });
        s.get(q.key);
        ok('signed upload round-trips');
        // Best effort. A preflight that fails because it could not tidy up is
        // reporting on itself rather than on the system.
        try { fs.unlinkSync(s.pathFor(q.key)); } catch { /* leave the crumb */ }
      }
    } else if (driver === 'local') {
      fail('STUDIO_STORAGE_SECRET is not set — without it every upload URL is forgeable, '
         + 'so the server refuses to mint any. Generate: openssl rand -hex 32');
    } else {
      fail(`storage driver "${driver}" is not configured — check the S3_* vars`);
    }
  } catch (err) {
    fail(`storage: ${err.message}`);
  }

  isPubliclyFetchable()
    ? ok('storage is publicly fetchable — publishing will work')
    : warn('storage is NOT publicly fetchable. Fine for development: fal uploads are ' +
           'routed through fal\'s own storage automatically. Instagram publishing needs ' +
           'a real bucket or a tunnel.');

  const limit = process.env.STUDIO_JSON_LIMIT || '8mb';
  ok(`studio JSON limit ${limit} (a 16-image seed set is ~160 KB)`);

  console.log(bad ? `\n${bad} problem(s).\n` : '\nAll good.\n');
  await pool.end();
  process.exit(bad ? 1 : 0);
})();
