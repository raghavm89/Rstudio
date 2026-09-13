#!/usr/bin/env node
'use strict';

/**
 * Top a workspace up to a fixed credit balance, for development and testing.
 *
 *     node scripts/dev-credits.js                    # admin accounts → 1000
 *     node scripts/dev-credits.js --to 2500
 *     node scripts/dev-credits.js --tenant 9
 *     node scripts/dev-credits.js --dry
 *
 * ── Tops UP, does not add ───────────────────────────────────────────────────
 * The obvious version grants 1000 credits each run, so the fourth run leaves
 * 4000 and the balance stops meaning anything. This one grants the DIFFERENCE
 * between the current balance and the target, which makes the script
 * idempotent: run it as often as you like and the answer is always 1000. Run it
 * after burning 300 on test renders and it puts back exactly 300.
 *
 * ── Through the ledger, and audited ─────────────────────────────────────────
 * It calls the same CreditLedger the checkout does rather than inserting a row
 * itself. The ledger owns the sign convention and the uniqueness rules, and a
 * second writer is how a balance quietly stops adding up. Each top-up also
 * writes an `admin.credits.grant` row to studio_audit_log with a note saying it
 * came from here — so a balance that looks wrong later can be explained rather
 * than guessed at.
 *
 * ── It refuses to run against production ────────────────────────────────────
 * Free credits are real cost: every one of them is a second of fal video we pay
 * for. A script that hands them out is a development tool, and NODE_ENV=production
 * is where it should not be.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const pool = require(path.join(ROOT, 'src/config/db'));
const CreditLedger = require(path.join(ROOT, 'src/services/studio/creditLedger'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const DRY = args.includes('--dry');
const TARGET = Number(flag('to', 1000));
const ONLY_TENANT = flag('tenant', null);

const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
const num = (n) => Number(n).toLocaleString('en-IN');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    die('NODE_ENV is production. Credits are real generation cost — this is a development tool.');
  }
  if (!Number.isFinite(TARGET) || TARGET < 0 || TARGET > 100000) {
    die(`--to ${flag('to')} is not a sensible target balance.`);
  }

  // Which workspaces. By default the ones belonging to a platform admin, which
  // is the account doing the testing; `--tenant` for anything else.
  const { rows: targets } = ONLY_TENANT
    ? await pool.query(
        `SELECT t.id, t.name, (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS email
           FROM tenants t WHERE t.id = $1`, [Number(ONLY_TENANT)])
    : await pool.query(
        `SELECT DISTINCT t.id, t.name,
                (SELECT u2.email FROM users u2 WHERE u2.tenant_id = t.id ORDER BY u2.id LIMIT 1) AS email
           FROM tenants t
           JOIN users u ON u.tenant_id = t.id
          WHERE u.role = 'admin'
          ORDER BY t.id`);

  if (!targets.length) {
    die(ONLY_TENANT
      ? `No tenant with id ${ONLY_TENANT}.`
      : 'No workspace belongs to a user with role=admin.\n'
        + '    Create one with `node scripts/create-admin.js`, or name a workspace with --tenant N.');
  }

  console.log(`\nDev credits — topping up to ${num(TARGET)}\n`);

  for (const t of targets) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Locked before reading, for the same reason spending is: two runs at
      // once would both read the old balance and both top up from it.
      await client.query('SELECT id FROM credit_ledger WHERE tenant_id = $1 FOR UPDATE', [t.id]);
      const before = await CreditLedger.balance(client, t.id);
      const gap = TARGET - before;

      if (gap <= 0) {
        await client.query('ROLLBACK');
        console.log(`  ${String(t.id).padStart(3)}  ${(t.name || '').padEnd(24)} ${num(before).padStart(7)}  already at or above target`);
        continue;
      }
      if (DRY) {
        await client.query('ROLLBACK');
        console.log(`  ${String(t.id).padStart(3)}  ${(t.name || '').padEnd(24)} ${num(before).padStart(7)}  would add ${num(gap)}`);
        continue;
      }

      const reference = `dev-topup:${t.id}:${Date.now()}`;
      await CreditLedger.purchase(client, t.id, gap, reference, `Dev top-up to ${TARGET} (scripts/dev-credits.js)`);
      const after = await CreditLedger.balance(client, t.id);

      // The same action name the back office writes, so the audit screen shows
      // script grants and hand grants in one list rather than hiding one.
      await client.query(
        `INSERT INTO studio_audit_log (tenant_id, action, entity, meta)
         VALUES ($1, 'admin.credits.grant', 'credit_ledger', $2::jsonb)`,
        [t.id, JSON.stringify({
          credits: gap, note: `dev top-up to ${TARGET}`,
          balance_before: before, balance_after: after, source: 'scripts/dev-credits.js',
        })]
      );

      await client.query('COMMIT');
      console.log(`  ${String(t.id).padStart(3)}  ${(t.name || '').padEnd(24)} ${num(before).padStart(7)} → ${num(after)}  (+${num(gap)})`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.log(`  ${String(t.id).padStart(3)}  ${(t.name || '').padEnd(24)} FAILED — ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(DRY ? '\n  Dry run — nothing changed. Drop --dry to apply.\n' : '');
  console.log('  These are bought credits: they are spent only after the plan\'s monthly');
  console.log('  allowance runs out, and they do not expire. To see them, open Billing.\n');
}

main()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
