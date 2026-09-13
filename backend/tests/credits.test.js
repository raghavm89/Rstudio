'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { creditPosition, RATES } = require('../src/services/studio/credits');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * Credits are a rate card over the meters, not a second set of books.
 *
 * The pricing decision on record is to meter in generated video seconds, because
 * a second maps one-to-one onto the Seedance bill. Credits are what the customer
 * reads; the counters are still what the system keeps. If those two ever
 * disagree, the number on the page is the one that gets believed and the one
 * that is wrong.
 */

const month = (used, limit) => ({ used, limit, period: 'month', cost_cents: 0 });

test('the wallet anchors on a still; the per-unit rates are build-time', () => {
  // The settled anchor is 1 still = 1 credit (creditCost.js). RATES.credits is
  // the wallet's own unit, 1:1, which is what lets CreditLedger.creditsFor map
  // an over-wallet reservation straight onto purchased credits.
  assert.strictEqual(RATES.credits, 1, 'the wallet unit must convert 1:1');
  // The per-unit rates below are no longer the content rate card — they are the
  // BUILD-time ledger conversions (seed frames, calibration, training).
  assert.strictEqual(RATES.video_seconds, 1);
  assert.strictEqual(RATES.still_megapixels, 2);
});

test('credits are derived from the meters, not stored beside them', () => {
  const pos = creditPosition({
    video_seconds:    month(120, 240),
    still_megapixels: month(10, 60),
  });
  assert.strictEqual(pos.used, 120 * 1 + 10 * 2);
  assert.strictEqual(pos.included, 240 * 1 + 60 * 2);
  assert.strictEqual(pos.remaining, pos.included - pos.used);
});

test('lifetime caps are not credits', () => {
  // Avatars and claimed faces are limits on what you may HAVE. Folding them into
  // a spend figure would make a credit mean two different things at once.
  const pos = creditPosition({
    video_seconds: month(10, 240),
    avatars:       { used: 1, limit: 1, period: 'lifetime', cost_cents: 0 },
    faces_claimed: { used: 0, limit: 0, period: 'lifetime', cost_cents: 0 },
  });
  assert.strictEqual(pos.used, 10);
  assert.deepStrictEqual(pos.breakdown.map((b) => b.metric), ['video_seconds']);
});

test('remaining never goes negative', () => {
  // Overspend is real — a job is metered when claimed, and a cap can be crossed
  // mid-flight. "-40 credits left" is arithmetic leaking onto a page.
  const pos = creditPosition({ video_seconds: month(280, 240) });
  assert.strictEqual(pos.used, 280);
  assert.strictEqual(pos.remaining, 0);
  // The row that caused it still tells the truth.
  assert.strictEqual(pos.breakdown[0].credits, 280);
  assert.strictEqual(pos.breakdown[0].credits_limit, 240);
});

test('an empty or unknown summary produces zeroes, not NaN', () => {
  for (const input of [undefined, {}, { nonsense: month(5, 5) }]) {
    const pos = creditPosition(input);
    assert.strictEqual(pos.used, 0);
    assert.strictEqual(pos.included, 0);
    assert.ok(Number.isFinite(pos.remaining));
  }
});

test('the breakdown keeps the real units beside the credits', () => {
  // A credit figure alone cannot be checked against anything. Seconds and
  // megapixels are what the customer actually asked for.
  const [video] = creditPosition({ video_seconds: month(30, 240) }).breakdown;
  assert.strictEqual(video.units_used, 30);
  assert.strictEqual(video.unit, 's');
  assert.strictEqual(video.rate, 1);
});

test('the usage endpoint sends credits with the meters', () => {
  const src = read(path.join(ROOT, 'src', 'controllers', 'studioJobController.js'));
  assert.match(src, /creditPosition\(summary\)/,
    'credits must come from the same summary, not a second query the client reconciles');
});

test('the usage page shows what actually constrains you', () => {
  const src = read(path.join(FE, 'app', 'usage', 'page.jsx'));
  // Allowances are enforced PER METER. A pooled total alone would let someone
  // read "200 credits left" and then be refused a video because the video meter
  // specifically is spent.
  assert.match(src, /breakdown\.map/, 'the per-meter breakdown must be rendered');
  assert.match(src, /refused even if/, 'a spent meter should say so plainly');
  assert.ok(!/₹/.test(src), 'usage should be in credits, not rupees');
});


test('the landing page and the plans table quote the same wallets and prices', () => {
  // They once disagreed — "Free · 240s" and "₹1,499 Creator" on the page while
  // the app charged ₹12,000 for a plan called Pro. The landing is still
  // hardcoded (a session-less server component), so this guards it against the
  // plans it mirrors. Wallets are cross-checked against migration 056, their
  // source; prices against the migrations that set them.
  const landing = read(path.join(FE, 'components', 'Landing.jsx'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');   // the comment explains the old numbers
  const dir = path.join(ROOT, 'src', 'db', 'migrations');

  // The wallets, read from the migration that grants them — not retyped here.
  const sql056 = read(path.join(dir, '056_credit_wallet.sql'));
  const wallets = {};
  for (const m of sql056.matchAll(/\('(catalogue|pro|max|ultra)',\s*(\d+)/g)) wallets[m[1]] = Number(m[2]);
  wallets.free = Number(sql056.match(/\(NULL, 'credits', (\d+), 'month'/)[1]);
  assert.deepStrictEqual(
    wallets, { catalogue: 150, pro: 220, max: 750, ultra: 1850, free: 40 },
    'migration 056 is the source of the wallets the page must quote'
  );

  // Each wallet appears on the page, in en-IN formatting.
  for (const n of Object.values(wallets)) {
    const shown = `${n.toLocaleString('en-IN')} credits`;
    assert.ok(landing.includes(shown), `the landing page does not quote ${shown}`);
  }

  // The five prices, cross-checked against the migrations that set them.
  const p041 = read(path.join(dir, '041_repricing.sql'));
  const p055 = read(path.join(dir, '055_frozen_offering_pricing.sql'));
  assert.ok(p041.includes("amount = 200000 WHERE slug = 'pro'"), 'Pro is ₹2,000 in 041');
  assert.ok(p055.includes("amount = 700000 WHERE slug = 'max'"), 'Max is ₹7,000 in 055');
  assert.ok(p055.includes('99900'),   'Catalogue is ₹999 in 055');
  assert.ok(p055.includes('1500000'), 'Ultra is ₹15,000 in 055');
  for (const shown of ['Free', '₹999', '₹2,000', '₹7,000', '₹15,000']) {
    assert.ok(landing.includes(shown), `the landing page does not quote ${shown}`);
  }

  // The plain-English guide the wallet needs: what a credit buys, and the top-up.
  assert.match(landing, /one credit is one photo/i, 'the page must say what a credit buys');
  assert.ok(landing.includes('77 credits'), 'the top-up is ₹500 for 77 credits now');

  // Retired copy must be gone. FULL phrases, so "1,850 credits" (Ultra) does not
  // trip a bare "850 credits" check — it contains it as a substring.
  for (const stale of ['Pro · 850 credits', 'Max · 2,600 credits', '₹6,000',
                       'one second of generated video', 'for 210 credits']) {
    assert.ok(!landing.includes(stale), `the landing page still shows the retired "${stale}"`);
  }
});

test('the credit wallets are the ones the prices can carry', () => {
  // The old per-unit allowances were tuned so full generative use cleared a
  // margin floor. The per-piece wallet keeps the same discipline against a
  // simpler basis: a credit is priced at ≈ ₹4.50 of supplier cost (the still it
  // is anchored on), so a plan's worst-case spend is its wallet × that. Raise a
  // wallet without the price and this fails, instead of shipping a plan that
  // loses more the better it sells.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const sql056 = read(path.join(dir, '056_credit_wallet.sql'));
  const wallet = {};
  for (const m of sql056.matchAll(/\('(catalogue|pro|max|ultra)',\s*(\d+)/g)) wallet[m[1]] = Number(m[2]);
  wallet.free = Number(sql056.match(/\(NULL, 'credits', (\d+), 'month'/)[1]);

  // The settled wallets — asserted so the copy, the migration and the model
  // cannot silently diverge.
  assert.deepStrictEqual(wallet, { catalogue: 150, pro: 220, max: 750, ultra: 1850, free: 40 });

  // COST_PER_CREDIT is the ASSUMPTION nobody controls — named so a margin check
  // cannot quietly pass at a cost the rate card stopped using.
  const COST_PER_CREDIT = 4.5;
  const price = { catalogue: 999, pro: 2000, max: 7000, ultra: 15000 };
  for (const slug of Object.keys(price)) {
    const cost   = wallet[slug] * COST_PER_CREDIT;
    const margin = (price[slug] - cost) / price[slug];
    assert.ok(
      margin >= 0.30,
      `${slug} is ${(margin * 100).toFixed(1)}% at full spend — below the 30% floor`
    );
  }
});

test('the free wallet is exactly its advertised bundle at the rate card', () => {
  // The old free tier budgeted a wasted generation into a SECONDS allowance.
  // The per-piece wallet replaced that (migration 056): the free 40 credits IS
  // five budget videos and ten stills at the rate card — 5×6 + 10×1 — which is
  // why the card can say "~5 videos + 10 stills" and mean it. If the wallet or a
  // rate moves, this is where that copy stops being true.
  const { creditCostFor } = require('../src/services/studio/creditCost');
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const latest = fs.readdirSync(dir)
    .filter((f) => /\(NULL, 'credits', \d+, 'month'/.test(read(path.join(dir, f))))
    .sort().pop();
  assert.ok(latest, 'no migration seeds a free credit wallet');
  const sql = read(path.join(dir, latest));

  // Match the FREE row specifically — the wallet and the bundle note on one
  // line — so the catalogue row's note two lines up cannot stand in for it.
  const free = sql.match(/\(NULL, 'credits', (\d+), 'month', '~(\d+) videos \+ (\d+) stills'/);
  assert.ok(free, `${latest} must seed a free credit wallet with a bundle note`);
  const wallet = Number(free[1]);
  const videos = Number(free[2]);
  const stills = Number(free[3]);

  const bundle = videos * creditCostFor({ stage: 'lipsync', lipsyncTier: 'budget' })
               + stills * creditCostFor({ stage: 'still' });
  assert.strictEqual(
    bundle, wallet,
    `the free copy promises ${videos} videos + ${stills} stills = ${bundle} credits, but the wallet grants ${wallet}`
  );
});

test('the top-up sells credits above what they cost', () => {
  // Top-ups are bought by the heaviest users — the ones most likely to spend
  // them on the most expensive modality. Priced below marginal cost, the pack
  // loses money every time it works.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const latest = fs.readdirSync(dir)
    .filter((f) => /credit_packs SET credits|INSERT INTO credit_packs/.test(read(path.join(dir, f))))
    .sort().pop();
  const sql = read(path.join(dir, latest));

  const credits = Number(sql.match(/credits = (\d+) WHERE slug = 'topup-500'/)?.[1]
    ?? sql.match(/VALUES \('topup-500',[^,]+,\s*(\d+)/)?.[1]);
  assert.ok(credits, 'could not read the top-up size');

  const perCredit = 500 / credits;
  const cost = 0.022 * 100;                 // generative video, ₹100/$
  assert.ok(
    perCredit > cost,
    `the top-up sells at ₹${perCredit.toFixed(2)} against a ₹${cost.toFixed(2)} cost — every pack loses money`
  );
});


test('plans come from the database, not a hardcoded list in the UI', () => {
  const src = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(src, /useResource\('\/plans'\)/, 'the page must read plans from the API');
  assert.ok(!/12,?000|25,?000/.test(src),
    'prices must not be typed into the page — they live in the plans table');
});

test('buying goes through the server-verified path', () => {
  // This file used to assert that nothing on this page could take money, back
  // when checkout was unwired. It can now. The property worth keeping is not
  // "no buttons" but "no shortcuts": a purchase reaches the ledger only after
  // the server has checked the signature.
  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(page, /buyCredits|subscribeToPlan/, 'the page should use the checkout helpers');
  assert.ok(!/credit_ledger|balance\s*=\s*balance\s*\+/.test(page),
    'the page must not adjust a balance itself');

  const checkout = read(path.join(FE, 'lib', 'checkout.js'));
  assert.match(checkout, /post\('\/billing\/verify'/,
    'the handler must ask the server to verify before resolving');
  // Resolving on the Razorpay handler alone would be trusting the one
  // participant with a motive.
  const buy = checkout.slice(checkout.indexOf('export async function buyCredits'));
  const handler = buy.slice(buy.indexOf('handler:'), buy.indexOf('modal:'));
  assert.ok(!/resolve\(rsp\)/.test(handler), 'must not resolve with the browser\'s own response');
});

test('the credit pack price still clears its cost after tax', () => {
  // GST is added on top, so it does not touch the margin — but if the pack is
  // ever repriced inclusive, this is where it shows up.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const latest = fs.readdirSync(dir)
    .filter((f) => /credit_packs SET credits|INSERT INTO credit_packs/.test(read(path.join(dir, f))))
    .sort().pop();
  const sql = read(path.join(dir, latest));
  const credits = Number(sql.match(/credits = (\d+) WHERE slug = 'topup-500'/)?.[1]
    ?? sql.match(/VALUES \('topup-500',[^,]+,\s*(\d+)/)?.[1]);
  assert.ok(500 / credits > 0.022 * 100, 'the pack sells below what its credits cost');
});
