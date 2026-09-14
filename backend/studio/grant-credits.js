#!/usr/bin/env node
'use strict';

/**
 * Local-dev credit grant.
 *
 * Build steps (train, calibration) are paid from the PURCHASED credit balance
 * (credit_ledger), not the monthly plan wallet. A fresh tenant has none, so the
 * first train fails NOT_ENOUGH_CREDITS. In production these credits come from a
 * Razorpay credit-pack purchase; for local dev this writes a 'purchase' row
 * directly through the same ledger API a real payment would use.
 *
 *     node studio/grant-credits.js --tenant 1 --credits 500
 *     node studio/grant-credits.js --tenant 1            # default 500
 *
 * Idempotent-ish: each run uses a unique dev reference, so re-running adds more.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const Ledger = require(path.join(ROOT, 'src/services/studio/creditLedger'));

const argv = process.argv.slice(2);
const flag = (name, fb = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fb;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const TENANT = Number(flag('tenant', 1));
const CREDITS = Number(flag('credits', 500));
const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

(async () => {
  if (!TENANT) die('Which tenant? e.g. --tenant 1');
  if (!(CREDITS > 0)) die('Credits must be positive, e.g. --credits 500');

  const { rows: t } = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [TENANT]);
  if (!t.length) die(`No tenant #${TENANT}.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await Ledger.balance(client, TENANT);
    const ref = `dev-grant-${Date.now()}`;
    const inserted = await Ledger.purchase(client, TENANT, CREDITS, ref, 'local dev grant');
    if (!inserted) { await client.query('ROLLBACK'); die('Grant not inserted (duplicate reference?).'); }
    const after = await Ledger.balance(client, TENANT);
    await client.query('COMMIT');
    console.log(`\n  ${t[0].name} (tenant #${TENANT})`);
    console.log(`  balance ${before} -> ${after}  (+${CREDITS}, ref ${ref})`);
    console.log(`\n  Now:  node studio/train.js --avatar 1 --yes\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    die(`Grant failed, rolled back: ${e.message}`);
  } finally {
    client.release();
  }
  await pool.end();
})().catch((e) => die(e.message));
