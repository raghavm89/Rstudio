#!/usr/bin/env node
/**
 * One-time bootstrap script: creates the first system admin.
 *
 * Usage (interactive):
 *   node scripts/create-admin.js
 *
 * Usage (non-interactive — useful for CI/Docker):
 *   ADMIN_NAME="Raghav" ADMIN_EMAIL="admin@rach.dev" ADMIN_PASSWORD="s3cr3t!" node scripts/create-admin.js
 *
 * The script is idempotent — if an admin with the given email already exists
 * it exits cleanly without making any changes.
 */

'use strict';

require('dotenv').config();

const readline = require('readline');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;

const pool = new Pool({
  host    : process.env.DB_HOST,
  port    : process.env.DB_PORT,
  database: process.env.DB_NAME,
  user    : process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max     : 3,
  connectionTimeoutMillis: 5000,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function promptSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        if (ch === '') process.exit();
        resolve(value);
      } else if (ch === '' || ch === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        value += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║     Rach.Dev Admin Setup Wizard      ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════╝${RESET}\n`);

  // ── Resolve credentials (env vars → interactive prompt) ───────────────────
  let name     = process.env.ADMIN_NAME     || '';
  let email    = process.env.ADMIN_EMAIL    || '';
  let password = process.env.ADMIN_PASSWORD || '';

  const nonInteractive = name && email && password;

  if (!nonInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (!name)  name  = (await prompt(rl, `${BOLD}Full name${RESET}:  `)).trim();
    if (!email) email = (await prompt(rl, `${BOLD}Email${RESET}:      `)).trim().toLowerCase();
    rl.close();
    if (!password) password = await promptSecret(`${BOLD}Password${RESET}:   `);
  } else {
    email = email.toLowerCase();
    console.log(`${YELLOW}Running non-interactively from env vars.${RESET}`);
    console.log(`  Name:  ${name}`);
    console.log(`  Email: ${email}\n`);
  }

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!name || !email || !password) {
    console.error(`\n${RED}✗ name, email, and password are all required.${RESET}`);
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`\n${RED}✗ Invalid email address.${RESET}`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error(`\n${RED}✗ Password must be at least 8 characters.${RESET}`);
    process.exit(1);
  }

  // ── Database operations ────────────────────────────────────────────────────
  console.log(`\n${YELLOW}Connecting to database…${RESET}`);
  const client = await pool.connect();

  try {
    // Check for existing admin with this email
    const { rows: existing } = await client.query(
      `SELECT id, role FROM users WHERE email = $1`,
      [email]
    );

    if (existing.length > 0) {
      const u = existing[0];
      if (u.role === 'admin') {
        console.log(`${YELLOW}⚠  An admin with email "${email}" already exists (id=${u.id}). Nothing changed.${RESET}\n`);
        process.exit(0);
      }
      console.error(`${RED}✗ A user with email "${email}" already exists with role "${u.role}".${RESET}`);
      console.error(`${RED}  To promote them run:  PATCH /api/users/${u.id}/role  { "role": "admin" }${RESET}\n`);
      process.exit(1);
    }

    console.log(`${YELLOW}Hashing password…${RESET}`);
    const hashed = await bcrypt.hash(password, BCRYPT_COST);

    console.log(`${YELLOW}Creating admin user…${RESET}`);
    const { rows } = await client.query(
      `INSERT INTO users
         (name, email, password, role, email_verified, phone_verified, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', TRUE, TRUE, NOW(), NOW())
       RETURNING id, name, email, role`,
      [name, email, hashed]
    );

    const admin = rows[0];

    console.log(`\n${GREEN}${BOLD}✓ Admin created successfully!${RESET}`);
    console.log(`${GREEN}  ID:    ${admin.id}${RESET}`);
    console.log(`${GREEN}  Name:  ${admin.name}${RESET}`);
    console.log(`${GREEN}  Email: ${admin.email}${RESET}`);
    console.log(`${GREEN}  Role:  ${admin.role}${RESET}\n`);
    console.log(`${CYAN}You can now sign in at your frontend with these credentials.${RESET}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n${RED}✗ Unexpected error:${RESET}`, err.message);
  process.exit(1);
});
