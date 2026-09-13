#!/usr/bin/env node
'use strict';

/**
 * Which column actually holds a user's password hash?
 *
 * The codebase disagrees with itself. `User.create` inserts into `password` and
 * `login` reads `user.password`; but the change-password handler, the reset-
 * password handler and the OAuth signup all write `password_hash` — on the same
 * table. If both columns exist, an account can be written down one path and read
 * down the other, and the symptom is either a silent "your new password does not
 * work" or a 500 from bcrypt being handed undefined.
 *
 *     node studio/doctor-auth.js
 *
 * Reads only. Prints no hashes.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));

(async () => {
  const { rows: cols } = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN ('password','password_hash')
      ORDER BY column_name`
  );

  console.log('\nPassword columns on `users`\n');
  if (!cols.length) { console.log('  neither `password` nor `password_hash` exists — something is very wrong\n'); return; }
  for (const c of cols) console.log(`  ${c.column_name.padEnd(14)} nullable: ${c.is_nullable}`);

  const has = (n) => cols.some((c) => c.column_name === n);
  const parts = [];
  if (has('password'))      parts.push("COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '') AS with_password");
  if (has('password_hash')) parts.push("COUNT(*) FILTER (WHERE password_hash IS NOT NULL AND password_hash <> '') AS with_hash");

  const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS total, ${parts.join(', ')} FROM users`);
  console.log(`\n  users total            ${n.total}`);
  if (has('password'))      console.log(`  with password set      ${n.with_password}`);
  if (has('password_hash')) console.log(`  with password_hash set ${n.with_hash}`);

  if (has('password') && has('password_hash')) {
    const { rows: [split] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE (password IS NULL OR password = '') AND password_hash IS NOT NULL AND password_hash <> ''`
    );
    console.log('\n  ⚠ Both columns exist.');
    console.log(`  ${split.n} account(s) have a hash in password_hash but nothing in password.`);
    console.log('  Those accounts cannot sign in with a password: login reads `password`,');
    console.log('  while reset-password, change-password and OAuth signup all write');
    console.log('  `password_hash`. A reset would report success and change nothing usable.');
    if (split.n) {
      const { rows } = await pool.query(
        `SELECT id, email, role FROM users
          WHERE (password IS NULL OR password = '') AND password_hash IS NOT NULL AND password_hash <> ''
          ORDER BY id LIMIT 10`
      );
      console.log('\n  Affected:');
      for (const r of rows) console.log(`    #${String(r.id).padEnd(5)} ${r.email}`);
    }
  }

  const { rows: [none] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE ${has('password') ? "(password IS NULL OR password = '')" : 'TRUE'}`
      + (has('password_hash') ? " AND (password_hash IS NULL OR password_hash = '')" : '')
  );
  if (none.n) {
    console.log(`\n  ${none.n} account(s) have no password at all — OAuth-only, or created without one.`);
    console.log('  Signing in with a password will now be refused politely rather than 500ing.');
  }
  console.log('');
})().catch((e) => { console.error(`\n  ✗ ${e.message}\n`); process.exitCode = 1; }).finally(() => pool.end());
