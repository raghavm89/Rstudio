'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * One name for the password hash, enforced by reading the source.
 *
 * `users.password` and `users.password_hash` were both live at once, in
 * different files, with nothing checking they agreed:
 *
 *   user.js         INSERT ... (password)
 *   oauth.js        INSERT ... (password_hash)
 *   userController  SELECT password  …  UPDATE password_hash   ← in ONE function
 *   authController  read user.password, write password_hash
 *
 * The live database had only `password_hash`, so sign-up died on the INSERT.
 * That was the lucky half. Sign-in read `user.password`, got undefined, decided
 * the account had no local password and told every password user their account
 * was created with Google — a confident wrong answer, no error, no log line.
 *
 * This is a source scan rather than a list of approved files, for the same
 * reason the stage-contract test is: a list has to be updated by whoever just
 * forgot to update the other file.
 */

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Comments stripped before scanning.
 *
 * The whole point of a fix like this is that someone writes down why it was
 * wrong, and the explanation has to name the wrong thing to be worth reading. A
 * scan that cannot tell prose from code makes the comment the violation and
 * quietly pressures the next person to delete the history instead of the bug.
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const files = jsFiles(SRC).map((f) => ({ f, src: stripComments(fs.readFileSync(f, 'utf8')) }));
const rel = (f) => path.relative(path.join(__dirname, '..'), f);

test('no SQL names `password` as a column on users', () => {
  const offenders = [];
  for (const { f, src } of files) {
    // INSERT INTO users (…, password, …) — the bare name, not password_hash and
    // not password_reset_token.
    for (const m of src.matchAll(/INSERT\s+INTO\s+users\s*\(([^)]*)\)/gi)) {
      const cols = m[1].split(',').map((c) => c.trim());
      if (cols.includes('password')) offenders.push(`${rel(f)}  INSERT INTO users (… password …)`);
    }
    if (/SELECT\s+password\s+FROM\s+users/i.test(src))  offenders.push(`${rel(f)}  SELECT password FROM users`);
    if (/UPDATE\s+users\s+SET\s+password\s*=/i.test(src)) offenders.push(`${rel(f)}  UPDATE users SET password =`);
  }
  assert.deepStrictEqual(
    offenders, [],
    `these name the column that does not exist:\n    ${offenders.join('\n    ')}`
  );
});

test('the login path reads password_hash', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'controllers', 'authController.js'), 'utf8'));
  assert.match(
    src, /user\.password_hash/,
    'login must read user.password_hash — reading user.password reports every '
    + 'password account as an OAuth account instead of failing'
  );
  // A bare `user.password` read (not `.password_hash`, not `req.body`).
  const bare = [...src.matchAll(/\buser\.password\b(?!_hash)/g)];
  assert.strictEqual(bare.length, 0, 'a bare `user.password` read is still present');
});

test('change-password reads and writes the same column', () => {
  // It used to SELECT one and UPDATE the other, so it could not work against
  // either schema — whichever database you had, one of its two statements named
  // a column that was not there.
  const src = stripComments(fs.readFileSync(path.join(SRC, 'controllers', 'userController.js'), 'utf8'));
  const reads  = /SELECT\s+password_hash\s+FROM\s+users/i.test(src);
  const writes = /UPDATE\s+users\s+SET\s+password_hash\s*=/i.test(src);
  assert.ok(reads,  'change-password must SELECT password_hash');
  assert.ok(writes, 'change-password must UPDATE password_hash');
});

test('a migration reconciles the column name', () => {
  // Fixing only the code repairs the live database and breaks every fresh one:
  // a database built from 001 has `password`. Without this migration the bug
  // simply changes which environment it lives in.
  const dir = path.join(SRC, 'db', 'migrations');
  const found = fs.readdirSync(dir).some((f) => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return /RENAME\s+COLUMN\s+password\s+TO\s+password_hash/i.test(sql);
  });
  assert.ok(found, 'no migration renames users.password to users.password_hash');
});
