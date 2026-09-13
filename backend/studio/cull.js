#!/usr/bin/env node
'use strict';

/**
 * Register candidate frames so they can be culled in the app.
 *
 *     npm run studio:cull                    # every avatar with a candidates/ dir
 *     npm run studio:cull -- --avatar 2
 *     npm run studio:cull -- --dry
 *     npm run studio:cull -- --watch         # keep registering while the generator runs
 *
 * ── This used to be a web server, and that was the problem ──────────────────
 *
 * It listened on :5055 and served the culling screen its data directly. It had
 * no authentication and no tenant scoping — `/api/candidates?avatar=N` answered
 * for any N to anyone who could reach the port, and `/img/<id>/<file>` served
 * the pictures the same way. It read its list of avatars ONCE at startup and
 * then closed its pool, so an avatar created after it started did not exist to
 * it: that is what made the New avatar button lead to a TypeError. And the
 * verdicts lived in `cull-state.json` next to the pictures, where they belonged
 * to a directory rather than to a workspace.
 *
 * None of that survives a second tenant. So the decisions moved into
 * `seed_candidates` and the screen now talks to the authenticated Studio API.
 *
 * What is left is the one job that genuinely belongs on the machine holding the
 * files: reading the directory and telling the database what is in it. The
 * pixels stay here — a candidate pool is hundreds of throwaway frames from
 * local ComfyUI, and uploading them to look at once and delete most of would
 * cost money and time for nothing.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const Seed = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'seedCandidates'));

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

const DRY = has('dry');
const WATCH = has('watch');

const personaRoot = () => process.env.STUDIO_PERSONA_DIR || path.join(__dirname, 'personas');
const baseFor = (a) => arg('dir') || path.join(personaRoot(), a.slug);

/**
 * Import verdicts from the file this script used to write.
 *
 * Runs once per avatar and only fills in rows that have no verdict yet, so it
 * cannot overwrite a decision made in the app afterwards. The file is left in
 * place rather than deleted — it is somebody's work, and a stale copy of it is
 * harmless once nothing reads it.
 *
 * Without this step the fifteen frames already kept for Aanya would have been
 * silently un-decided, and nothing on screen would have said so.
 */
async function importLegacyState(client, avatar, dir) {
  const file = path.join(dir, 'cull-state.json');
  if (!fs.existsSync(file)) return null;

  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { file, imported: 0, unreadable: true }; }

  const pairs = [
    ...(st.keep   || []).map((f) => [f, 'keep']),
    ...(st.reject || []).map((f) => [f, 'reject']),
  ];
  if (!pairs.length) return { file, imported: 0 };
  if (DRY) return { file, imported: pairs.length, dry: true };

  let imported = 0;
  for (const [filename, verdict] of pairs) {
    const { rowCount } = await client.query(
      `UPDATE seed_candidates
          SET verdict = $3, decided_at = COALESCE(decided_at, NOW())
        WHERE avatar_id = $1 AND filename = $2 AND verdict IS NULL`,
      [avatar.id, filename, verdict]
    );
    imported += rowCount;
  }
  return { file, imported };
}

async function registerOne(client, avatar) {
  const dir = baseFor(avatar);
  const candDir = path.join(dir, 'candidates');
  if (!fs.existsSync(candDir)) return { avatar, skipped: 'no candidates directory' };

  const files = fs.readdirSync(candDir).filter((f) => /\.png$/i.test(f));
  if (!files.length) return { avatar, skipped: 'directory is empty' };

  const unparsed = files.filter((f) => !Seed.parseCandidate(f));
  const result = DRY
    ? { registered: files.length - unparsed.length, skipped: unparsed.length }
    : await Seed.register(client, avatar.id, files);

  const legacy = await importLegacyState(client, avatar, dir);

  const { rows: [counts] } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE verdict = 'keep')::int   AS kept,
            COUNT(*) FILTER (WHERE verdict = 'reject')::int AS rejected
       FROM seed_candidates WHERE avatar_id = $1`,
    [avatar.id]
  );

  return { avatar, files: files.length, unparsed, ...result, legacy, counts };
}

async function pass(client, avatars) {
  const out = [];
  for (const a of avatars) out.push(await registerOne(client, a));
  return out;
}

function report(results) {
  for (const r of results) {
    const name = `#${r.avatar.id} ${r.avatar.slug}`.padEnd(26);
    if (r.skipped) { console.log(`  ${name} — ${r.skipped}`); continue; }

    console.log(`  ${name} ${String(r.files).padStart(4)} frames  ` +
      `${String(r.counts.kept).padStart(3)} kept  ${String(r.counts.rejected).padStart(3)} rejected  ` +
      `${r.counts.total - r.counts.kept - r.counts.rejected} undecided`);

    if (r.unparsed.length) {
      // Named rather than counted: a filename the parser does not understand is
      // usually a frame the generator wrote before a naming change, and knowing
      // which one is the difference between fixing it and shrugging.
      console.log(`       ${r.unparsed.length} unreadable name${r.unparsed.length === 1 ? '' : 's'}: ` +
        r.unparsed.slice(0, 3).join(', ') + (r.unparsed.length > 3 ? ' …' : ''));
    }
    if (r.legacy?.unreadable) {
      console.log(`       ⚠ ${path.basename(r.legacy.file)} could not be parsed — decisions in it were NOT imported`);
    } else if (r.legacy?.imported) {
      console.log(`       imported ${r.legacy.imported} decision${r.legacy.imported === 1 ? '' : 's'} from cull-state.json` +
        (r.legacy.dry ? ' (dry run)' : ''));
    }
  }
}

async function main() {
  const only = arg('avatar') ? Number(arg('avatar')) : null;

  // Read every time, not once at startup. The whole reason the old service could
  // not see a new avatar is that it did this once and then closed the pool.
  const { rows: avatars } = await pool.query(
    only
      ? 'SELECT id, slug, name, tenant_id FROM avatars WHERE id = $1'
      : 'SELECT id, slug, name, tenant_id FROM avatars ORDER BY id',
    only ? [only] : []
  );
  if (only && !avatars.length) die(`No avatar #${only}.`);
  if (!avatars.length) die('No avatars yet. Create one at /avatars/new.');

  console.log(`\nRegistering candidates${DRY ? ' (dry run — nothing written)' : ''}\n`);

  const client = await pool.connect();
  try {
    report(await pass(client, avatars));
  } finally {
    client.release();
  }

  if (!WATCH) {
    console.log('\n  Open the culling screen in the Studio app:');
    for (const a of avatars) console.log(`    http://localhost:3100/avatars/${a.id}/face`);
    console.log('');
    return;
  }

  console.log('\n  Watching. New frames are registered every 10s; Ctrl-C to stop.\n');
  const tick = async () => {
    const c = await pool.connect();
    try {
      const { rows: fresh } = await pool.query(
        only ? 'SELECT id, slug, name, tenant_id FROM avatars WHERE id = $1'
             : 'SELECT id, slug, name, tenant_id FROM avatars ORDER BY id',
        only ? [only] : []
      );
      const results = await pass(c, fresh);
      const total = results.reduce((n, r) => n + (r.counts?.total || 0), 0);
      process.stdout.write(`\r  ${new Date().toLocaleTimeString()}  ${total} frames registered   `);
    } finally { c.release(); }
  };
  setInterval(tick, 10_000);
}

main()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => { if (!WATCH) pool.end(); });
