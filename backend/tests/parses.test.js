'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Does every server module still parse?
 *
 * Twice in one session a backtick inside a SQL comment ended the template
 * literal it was sitting in — once in `seedCandidates.anchors`, once in the
 * avatar list — and the file only failed when something first required it.
 *
 * **This file deliberately requires nothing from the product.** The first
 * attempt at this check lived in a suite that imports the very modules it
 * checks, so a broken one took the whole suite down before the check could run:
 * 35 tests became "0 passed, 1 failed" with a stack trace instead of a sentence.
 * A guard that cannot survive the failure it is guarding against is not a guard.
 */
test('every module under src/ and worker/ parses', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });

  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'worker'))];
  assert.ok(files.length > 30, `expected a real tree, found ${files.length} files`);

  const broken = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
      const why = String(err.stderr).split('\n').find((l) => /Error/.test(l)) || 'did not parse';
      broken.push(`${path.relative(ROOT, f)} — ${why.trim()}`);
    }
  }
  assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
});

test('the CLI scripts parse too', () => {
  // They are the only path to some steps, and nothing imports them, so a syntax
  // error in one is invisible until somebody needs it most.
  const dir = path.join(ROOT, 'studio');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
  assert.ok(files.length > 0);

  const broken = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch { broken.push(path.relative(ROOT, f)); }
  }
  assert.deepStrictEqual(broken, []);
});

test('no SQL comment carries a backtick', () => {
  // Three times in this build a backtick inside a `-- …` comment ended the
  // template literal it was sitting in. `node --check` above catches it, but
  // only after the fact and with "missing ) after argument list" — a message
  // that points at the query and not at the quote mark inside it. This names it.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });

  const found = [];
  for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'worker'))]) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*--/.test(line) && line.includes('`')) {
        found.push(`${path.relative(ROOT, f)}:${i + 1} — ${line.trim().slice(0, 70)}`);
      }
    });
  }
  assert.deepStrictEqual(found, [],
    `\n  a backtick here ends the template literal it is inside:\n  ${found.join('\n  ')}\n`);
});
