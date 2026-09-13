'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * The copy does not decide who the avatar is.
 *
 * `components/Shell.jsx` has said so since it was written — "Aanya is one
 * persona; a customer may build any, and a product that says 'her' throughout
 * has quietly decided for them" — and the app's own navigation follows it:
 * Find the face → Set the look → Shoot.
 *
 * The landing page did not. It said "Find her face", "Set her look", "every
 * photo she ever takes", "checked against her likeness", and the browser tab
 * said "Find her face, set her look, shoot." A customer building a 52-year-old
 * man read all of that before the product ever asked him anything.
 *
 * Same shape as `.lp-msg` being styled only in landing.css: the app got the
 * rule, the surfaces around it did not.
 */

const GENDERED = /\b(her|hers|herself|she|girl|his|him|himself)\b/i;

/**
 * Comments, gone. A comment may say "her" honestly — the demo footage IS one
 * persona, and describing it accurately is not the product speaking.
 *
 * `//` only when it opens a line, or every `https://` in the file disappears
 * and the check quietly stops seeing most of it.
 */
const rendered = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : (e.name.endsWith('.jsx') ? [full] : []);
});

test('no screen decides the avatar is a woman', () => {
  const files = [...walk(path.join(FE, 'app')), ...walk(path.join(FE, 'components'))];
  assert.ok(files.length > 10, `expected a real tree, found ${files.length}`);

  const found = [];
  for (const f of files) {
    rendered(read(f)).split('\n').forEach((line, i) => {
      const hit = line.match(GENDERED);
      if (hit) found.push(`${path.relative(FE, f)}:${i + 1} — "${hit[0]}" in: ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepStrictEqual(found, [], `\n  ${found.join('\n  ')}\n`);

  // The stripper has to strip comments and keep everything else, or this passes
  // by looking at nothing.
  assert.strictEqual(rendered('  // her\nkeep her\n').trim(), 'keep her');
  assert.strictEqual(rendered('/* her */x').trim(), 'x');
  assert.match(rendered('const u = "https://x/y";'), /https:\/\//,
    'a naive // strip eats every URL and most of the file with it');
});

test('the pipeline is named after the step, not after a pronoun', () => {
  // The rule the app already followed, now that the landing page does too.
  const landing = rendered(read(path.join(FE, 'components', 'Landing.jsx')));
  assert.match(landing, /<h3>Find the face<\/h3>/);
  assert.match(landing, /<h3>Set the look<\/h3>/);

  const shell = read(path.join(FE, 'components', 'Shell.jsx'));
  assert.match(shell, /COPY IS PERSONA-NEUTRAL/, 'and the reason stays written down');

  // The tab title and every share card.
  assert.match(read(path.join(FE, 'app', 'layout.jsx')),
    /description: 'Find the face, set the look, shoot\.'/);
});

test('🐛 no prompt fragment decides it either', () => {
  // This one is not copy. `prompt_vocabulary.fragment` is concatenated verbatim
  // into the prompt for every frame that uses it, so
  //
  //   lens / environmental_35 → "…the room visible behind her"
  //
  // sent "her" to the model alongside a man's identity block, arguing with it
  // in the one place they could not both win. And a look profile is chosen once
  // and LOCKED, so it would have gone into every photograph that avatar ever
  // took, with no reason on any screen for why the face drifted.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const found = [];

  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = read(path.join(dir, f));
    // Only the fragments — a migration's own prose may say anything.
    for (const m of sql.matchAll(/'([^']*)'\s*,\s*\d+\s*\)/g)) {
      if (GENDERED.test(m[1])) found.push(`${f}: "${m[1].slice(0, 70)}"`);
    }
  }
  assert.deepStrictEqual(found, [], `\n  ${found.join('\n  ')}\n`);

  // The seed a fresh database is born from, specifically.
  const seed = read(path.join(dir, '030_studio_seed.sql'));
  assert.match(seed, /the room visible behind the subject/);
  assert.ok(!/behind her/.test(seed), 'a new workspace must not inherit it');

  // And the repair for databases already carrying it.
  const repair = read(path.join(dir, '052_ungendered_vocabulary.sql'));
  assert.match(repair, /UPDATE prompt_vocabulary/);
  assert.match(repair, /option_key = 'environmental_35'/);
  assert.match(repair, /LIKE '%behind her%'/, 'scoped to the row that has it');
});

test('a stage label says what is happening, not who it happens to', () => {
  const orch = read(path.join(ROOT, 'src', 'services', 'studio', 'orchestrator.js'));
  const labels = [...orch.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 4, `expected the shoot's stage labels, found ${labels.length}`);
  for (const label of labels) {
    assert.ok(!GENDERED.test(label), `stage label "${label}" decides who the avatar is`);
  }
  assert.ok(labels.includes('Recording the voice'));
});
