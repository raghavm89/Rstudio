#!/usr/bin/env node
'use strict';

/**
 * Create the Pro and Max plans at Razorpay, and write their ids back.
 *
 *     node studio/link-razorpay-plans.js            # dry run — shows, changes nothing
 *     node studio/link-razorpay-plans.js --yes      # creates them
 *
 * `plans.razorpay_plan_id` is null until this runs, which is why the billing
 * page says a plan cannot be bought yet. It is not a bug to fix in code: a plan
 * has to exist at the gateway before anyone can subscribe to it, and only your
 * Razorpay account can create one.
 *
 * ── What this does and does not do ──────────────────────────────────────────
 * It creates PLAN DEFINITIONS — a name, an amount and a billing period. It does
 * not charge anyone, does not create a subscription, and does not move money.
 * A plan sitting unused at Razorpay costs nothing.
 *
 * ── Test keys first ─────────────────────────────────────────────────────────
 * Razorpay keys beginning `rzp_test_` operate on the test account, where you can
 * create, break and delete freely. `rzp_live_` plans are visible to real
 * customers and cannot be deleted once a subscription exists against them — only
 * deactivated. Check which you are pointed at; this script prints it and refuses
 * to run against live without `--live`.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const pool = require(path.join(ROOT, 'src/config/db'));
const razorpay = require(path.join(ROOT, 'src/services/razorpay'));

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const ALLOW_LIVE = args.includes('--live');

const rs = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

async function main() {
  const key = process.env.RAZORPAY_KEY_ID || '';
  if (!key) die('RAZORPAY_KEY_ID is not set. It should be in the backend .env.');

  const isLive = razorpay.isLiveKey(key);
  console.log(`\nRazorpay plans\n`);
  console.log(`  Account   ${key.slice(0, 12)}…  ${isLive ? '[31mLIVE[0m' : 'test'}`);

  if (isLive && !ALLOW_LIVE) {
    die('These are LIVE keys. A live plan is visible to real customers and cannot be\n'
      + '    deleted once anyone subscribes to it — only deactivated.\n\n'
      + '    To get test keys: Razorpay Dashboard, switch the mode selector to Test,\n'
      + '    then Account & Settings → API Keys → Generate Key. The secret is shown\n'
      + '    ONCE and cannot be retrieved afterwards, so paste it into .env before you\n'
      + '    close the dialog. Test keys need no website verification.\n\n'
      + '    Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to\n'
      + '    the test trio and re-run this.\n\n'
      + '    Re-run with --live only if creating REAL plans is what you want.');
  }

  // src/services/razorpay.js refuses live keys outside production — that is what
  // stops an ordinary web request taking real money by accident. Passing --live
  // IS that decision, made deliberately by a person at a terminal, so it answers
  // the same lock rather than colliding with it.
  if (isLive && ALLOW_LIVE) {
    process.env.RAZORPAY_ALLOW_LIVE = 'yes-really';
    console.log('  --live given: the production guard is lifted for this run.');
  }

  const { rows } = await pool.query(
    `SELECT id, slug, name, description, amount, currency, interval, razorpay_plan_id
       FROM plans
      WHERE is_active = TRUE AND slug IS NOT NULL AND amount > 0
      ORDER BY sort_order, id`
  );

  if (!rows.length) die('No paid plans in the database. Run the migrations first.');

  console.log('');
  for (const p of rows) {
    const state = p.razorpay_plan_id ? `linked → ${p.razorpay_plan_id}` : 'NOT LINKED';
    console.log(`  ${p.name.padEnd(6)} ${rs(p.amount).padStart(9)} / ${p.interval.padEnd(6)} ${state}`);
  }

  const todo = rows.filter((p) => !p.razorpay_plan_id);
  if (!todo.length) {
    console.log('\n  Everything is linked. Nothing to do.\n');
    return;
  }

  if (!CONFIRMED) {
    console.log(`\n  ${todo.length} plan(s) would be created at Razorpay. Nothing has been changed.`);
    console.log('  Re-run with --yes to create them.\n');
    return;
  }

  console.log('');
  for (const p of todo) {
    process.stdout.write(`  Creating ${p.name}… `);
    try {
      const created = await razorpay.plans.create({
        period: p.interval === 'month' ? 'monthly' : p.interval,
        interval: 1,
        item: {
          name: `Rstudio — ${p.name}`,
          description: p.description || undefined,
          // Paise, and GST-EXCLUSIVE to match the pricing page. Razorpay charges
          // exactly this; tax is added on the order, not baked into the plan.
          amount: Number(p.amount),
          currency: p.currency || 'INR',
        },
        notes: { slug: p.slug },
      });

      await pool.query('UPDATE plans SET razorpay_plan_id = $1 WHERE id = $2', [created.id, p.id]);
      console.log(`done → ${created.id}`);
    } catch (err) {
      // Keep going: one plan failing should not leave the other unlinked too.
      console.log(`FAILED — ${err?.error?.description || err.message}`);
    }
  }

  console.log('\n  Reload the billing page — the buttons should be live.\n');
  console.log('  Note: the amounts above exclude GST, which is added at checkout.');
  console.log('  If you change a price later, Razorpay plans are immutable — create a new');
  console.log('  plan and point plans.razorpay_plan_id at it rather than editing this one.\n');
}

main()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
