#!/usr/bin/env node
'use strict';

/**
 * Load a persona bible into the database.
 *
 *   node studio/load-persona.js studio/personas/aanya-kapoor/persona.md --tenant 1
 *
 * The front-matter maps 1:1 onto columns in `avatars`, which is why it is
 * front-matter and not prose — the loader is a straight read rather than a parse
 * of someone's paragraph. The identity and avoid blocks are lifted out of the
 * body by heading, because they are the two pieces of the bible that are
 * concatenated into prompts and must never be reformatted on the way in.
 *
 * Re-running is safe and is the intended way to edit a persona: everything
 * updates in place EXCEPT the identity block, which is refused if it has changed
 * and the bible_version has not been bumped. That refusal is the point — an
 * identity edit invalidates the trained LoRA and every calibrated QC baseline,
 * so it must be a deliberate act with a version behind it, not a typo fix that
 * silently changes her face.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
// The rules about what an identity block may contain live in one module, read by
// this script and by POST /api/studio/avatars. They used to live here as die()
// calls, where an HTTP request could not reach them — so the form would have had
// to restate them, and two statements of one rule is one statement that quietly
// stops being true.
const Identity = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'identityBlock'));

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** Minimal front-matter reader. No YAML dependency for eight scalar fields. */
function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) die('No front-matter found — the file must start with a --- block.');

  const out = {};
  let section = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const nested = line.match(/^\s{2,}([a-z_]+):\s*(.*)$/);
    if (nested && section) {
      out[section][nested[1]] = nested[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const top = line.match(/^([a-z_]+):\s*(.*)$/);
    if (top) {
      const [, key, value] = top;
      if (value.trim() === '') { section = key; out[key] = {}; }
      else { section = null; out[key] = value.trim().replace(/^["']|["']$/g, ''); }
    }
  }
  return out;
}

/**
 * Pull an indented block out from under a heading.
 *
 * HTML comments are stripped first: the template's explanatory comments sit
 * between the heading and the block, and one of them contains the words
 * "flawless skin" as an example of what never to write — reading it in as
 * identity text would put the exact phrase we forbid into every prompt.
 */
function blockUnder(text, heading) {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  const idx = stripped.indexOf(heading);
  if (idx === -1) die(`Heading "${heading}" not found.`);

  const after = stripped.slice(idx + heading.length);
  const lines = [];
  for (const line of after.split(/\r?\n/)) {
    if (/^#{1,3}\s/.test(line)) break;
    if (/^\s{4,}\S/.test(line)) lines.push(line.trim());
    else if (lines.length && !line.trim()) break;
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function tableValue(text, control) {
  const row = text.match(new RegExp(`^\\|\\s*${control}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm'));
  return row ? row[1].trim() : null;
}


function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

/**
 * Work out which tenant this persona belongs to.
 *
 * Everything in Studio is tenant-scoped, so this has to resolve before anything
 * else happens. Left to the database it surfaces as
 * `violates foreign key constraint "avatars_tenant_id_fkey"`, which is true and
 * useless — it does not say which tenants exist or how to make one. In this
 * codebase tenants are only created through the API, so a fresh local database
 * has none at all and the correct next step is not obvious from the error.
 *
 *   --tenant 3               use tenant 3, or list what exists if it does not
 *   --create-tenant "Name"   find-or-create by name (local development)
 *   neither                  use the only tenant, if there is exactly one
 */
async function resolveTenant() {
  const explicit = flag('tenant');
  const create   = flag('create-tenant');

  if (create) {
    const { rows } = await pool.query(
      `INSERT INTO tenants (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
       RETURNING id, name`,
      [create]
    );
    console.log(`\n  Tenant #${rows[0].id} — ${rows[0].name}`);
    return rows[0].id;
  }

  const { rows: tenants } = await pool.query('SELECT id, name FROM tenants ORDER BY id');

  if (explicit) {
    const id = Number(explicit);
    if (tenants.some((t) => t.id === id)) return id;
    die(
      `Tenant ${id} does not exist.\n\n` +
      (tenants.length
        ? `  Tenants you have:\n${tenants.map((t) => `    ${t.id}  ${t.name}`).join('\n')}\n\n` +
          '  Re-run with one of those ids.'
        : '  There are no tenants yet — this codebase only creates them through the API.\n' +
          '  For local development, make one here:\n\n' +
          '    npm run studio:persona -- <persona.md> --create-tenant "Rstudio Studio"')
    );
  }

  if (tenants.length === 1) {
    console.log(`\n  Using the only tenant: #${tenants[0].id} ${tenants[0].name}`);
    return tenants[0].id;
  }
  if (tenants.length === 0) {
    die('There are no tenants yet.\n\n' +
        '  For local development, make one:\n\n' +
        '    npm run studio:persona -- <persona.md> --create-tenant "Rstudio Studio"');
  }
  die(
    `Which tenant? Pass --tenant <id>.\n\n${tenants.map((t) => `    ${t.id}  ${t.name}`).join('\n')}`
  );
}

(async () => {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    die('Usage: node studio/load-persona.js <persona.md> [--tenant N | --create-tenant "Name"]');
  }

  const tenantId = await resolveTenant();

  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const fm = parseFrontMatter(text);

  const identity = blockUnder(text, '## Identity block — FROZEN');
  const avoid    = blockUnder(text, '## Avoid block — FROZEN');

  for (const [field, value] of Object.entries({ slug: fm.slug, name: fm.name, mode: fm.mode, lora_trigger: fm.lora_trigger })) {
    if (!value) die(`Front-matter is missing "${field}".`);
  }
  if (!identity) die('Identity block is empty — refusing to create a faceless persona.');

  // `reference` mode was removed in migration 033. The database refuses it too;
  // this exists so the refusal arrives with its reasoning rather than as a
  // constraint violation.
  if (fm.mode === 'reference') {
    die('mode: reference is not supported and will not be.\n\n'
      + '  Generating a likeness of someone who is not the account holder turns on\n'
      + '  identifiability, not copying — "similar to" is where personality-rights\n'
      + '  cases are won, and stock photos do not carry a release that covers model\n'
      + '  training.\n\n'
      + '  Use `synthetic` for a person who does not exist, or `twin` for your own\n'
      + '  likeness with a verified consent record. If you wanted to point at a face\n'
      + '  rather than describe one, that is what the face catalogue is for.');
  }
  if (!['synthetic', 'twin'].includes(fm.mode)) {
    die(`mode must be synthetic or twin, got "${fm.mode}".`);
  }

  const check = Identity.validate(identity, { name: fm.name });
  if (!check.ok) {
    die(`The identity block will not do:\n\n`
      + check.errors.map((e) => `    · ${e.message}`).join('\n'));
  }
  const words = check.words;

  if (!Identity.validTrigger(fm.lora_trigger)) {
    die(`lora_trigger "${fm.lora_trigger}" must be 6-20 lowercase alphanumerics including a digit — `
      + 'a real word collides with what the base model already knows about it.\n'
      + `    Try: ${Identity.suggestTrigger(fm.name)}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT id, identity_block, bible_version FROM avatars WHERE tenant_id = $1 AND slug = $2',
      [tenantId, fm.slug]
    );

    if (existing[0]) {
      const changed = existing[0].identity_block.replace(/\s+/g, ' ').trim() !== identity;
      const bumped  = Number(fm.bible_version || 1) > Number(existing[0].bible_version || 1);
      if (changed && !bumped) {
        die('The identity block changed but bible_version did not.\n\n'
          + '  An identity edit invalidates the trained LoRA and every calibrated QC baseline —\n'
          + '  it changes her face. Bump bible_version and plan to retrain, or revert the text.');
      }
      if (changed && bumped) {
        console.warn('\n  ⚠️  Identity block changed and bible_version bumped.');
        console.warn('      The existing LoRA no longer matches this description. Retrain before shooting.\n');
      }
    }

    const { rows: [avatar] } = await client.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block,
                            lora_trigger, bible_version, disclosure_line)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, slug) DO UPDATE
         SET name = EXCLUDED.name, mode = EXCLUDED.mode,
             identity_block = EXCLUDED.identity_block, avoid_block = EXCLUDED.avoid_block,
             lora_trigger = EXCLUDED.lora_trigger, bible_version = EXCLUDED.bible_version,
             disclosure_line = EXCLUDED.disclosure_line, updated_at = NOW()
       RETURNING *`,
      [tenantId, fm.slug, fm.name, fm.mode, identity, avoid,
       fm.lora_trigger, Number(fm.bible_version || 1), fm.disclosure_line || null]
    );

    const look = {
      base_look: tableValue(text, 'base_look') || 'editorial',
      lens:      tableValue(text, 'lens')      || 'portrait_85',
      colour:    tableValue(text, 'colour')    || 'warm',
      grain:     tableValue(text, 'grain')     || 'fine',
      skin:      tableValue(text, 'skin')      || 'natural',
      natural_asymmetry: (tableValue(text, 'natural_asymmetry') || 'true') === 'true',
      hair_detail:       (tableValue(text, 'hair_detail') || 'true') === 'true',
    };

    // Every look value must exist in the vocabulary. A typo here would otherwise
    // surface much later as a refused prompt assembly, mid-shoot.
    const { rows: vocab } = await client.query(
      'SELECT facet, option_key FROM prompt_vocabulary WHERE active'
    );
    const known = new Set(vocab.map((v) => `${v.facet}:${v.option_key}`));
    for (const facet of ['base_look', 'lens', 'colour', 'grain', 'skin']) {
      if (!known.has(`${facet}:${look[facet]}`)) {
        die(`Look profile has ${facet} = "${look[facet]}", which the vocabulary does not define.`);
      }
    }

    await client.query(
      `INSERT INTO look_profiles (avatar_id, base_look, lens, colour, grain, skin,
                                  natural_asymmetry, hair_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (avatar_id) DO UPDATE
         SET base_look = EXCLUDED.base_look, lens = EXCLUDED.lens, colour = EXCLUDED.colour,
             grain = EXCLUDED.grain, skin = EXCLUDED.skin,
             natural_asymmetry = EXCLUDED.natural_asymmetry, hair_detail = EXCLUDED.hair_detail,
             updated_at = NOW()`,
      [avatar.id, look.base_look, look.lens, look.colour, look.grain, look.skin,
       look.natural_asymmetry, look.hair_detail]
    );

    await client.query('COMMIT');

    console.log(`\n  ${existing[0] ? 'Updated' : 'Created'} avatar #${avatar.id} — ${avatar.name}`);
    console.log(`  slug          ${avatar.slug}`);
    console.log(`  mode          ${avatar.mode}`);
    console.log(`  trigger       ${avatar.lora_trigger}`);
    console.log(`  identity      ${words} words, frozen at bible_version ${avatar.bible_version}`);
    console.log(`  look profile  ${Object.entries(look).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`\n  Next: generate a candidate pool —`);
    console.log(`    node studio/seed-set.js --avatar ${avatar.id} --count 300\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    die(err.message);
  } finally {
    client.release();
    await pool.end();
  }
})();
