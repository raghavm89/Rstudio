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

test('a credit is a second of video', () => {
  assert.strictEqual(RATES.video_seconds, 1,
    'the anchor is the whole point: "240 credits" and "240 seconds" must be the same sentence');
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


test('the landing page and the plans table quote the same prices', () => {
  // They did not. The landing page said "Free · 240s of video" and "₹1,499
  // Creator" while the plans table charged ₹12,000 for a plan called Pro — a
  // disagreement a customer finds before you do.
  const landing = read(path.join(FE, 'components', 'Landing.jsx'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');   // the comment explains the old numbers
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '041_repricing.sql'));

  const paise = (slug) => {
    const m = sql.match(new RegExp(`UPDATE plans SET amount = (\\d+) WHERE slug = '${slug}'`));
    assert.ok(m, `no price for ${slug} in the repricing migration`);
    return Number(m[1]) / 100;
  };

  for (const [slug, shown] of [['pro', '₹2,000'], ['max', '₹6,000']]) {
    const rupees = paise(slug);
    assert.strictEqual(rupees.toLocaleString('en-IN'), shown.replace('₹', ''),
      `${slug} is ${rupees} in the database`);
    assert.ok(landing.includes(shown), `the landing page does not quote ${shown} for ${slug}`);
  }
  // Credit allowances too — the page quoted 1,200 and 4,000 until 042.
  for (const shown of ['850 credits', '2,600 credits']) {
    assert.ok(landing.includes(shown), `the landing page does not quote ${shown}`);
  }

  // And the retired numbers must be gone from the visible copy.
  for (const stale of ['1,499', '240s', '12,000', '1,200 credits', '4,000 credits',
                       '1,000 credits', '3,200 credits', '880 credits', '2,800 credits']) {
    assert.ok(!landing.includes(stale), `the landing page still shows the retired "${stale}"`);
  }
});

test('the credit allowances are the ones the prices can carry', () => {
  // 041 set Pro at 1,200 and Max at 4,000, which at full utilisation on
  // generative video was -16% and -29% — plans that lost more the better they
  // sold. 042 cut the allowances to the prices rather than the other way round.
  // Always the newest repricing migration, so this does not quietly keep
  // checking an allowance that has since been superseded.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const latest = fs.readdirSync(dir)
    .filter((f) => /video_seconds/.test(read(path.join(dir, f))) && /studio_entitlements e SET/.test(read(path.join(dir, f))))
    .sort()
    .pop();
  assert.ok(latest, 'no repricing migration found');
  const sql = read(path.join(dir, latest));

  // The exchange rate is an ASSUMPTION and the one input nobody controls. It is
  // named here so a margin check can never silently pass at a rate the business
  // stopped using — 042's grants were fine at ₹88 and −14% at ₹100.
  const FX = 100, GEN = 0.022, STILL = 0.035;
  const grants = {};
  for (const m of sql.matchAll(/\('(pro|max)',\s*'(video_seconds|still_megapixels)',\s*(\d+)/g)) {
    (grants[m[1]] ||= {})[m[2]] = Number(m[3]);
  }

  for (const [slug, price, floor] of [['pro', 2000, 0.03], ['max', 6000, -0.02]]) {
    const g = grants[slug];
    assert.ok(g?.video_seconds && g?.still_megapixels, `no entitlements for ${slug}`);
    const cost = g.video_seconds * GEN * FX + g.still_megapixels * STILL * FX;
    const margin = (price - cost) / price;
    assert.ok(
      margin >= floor,
      `${slug} is ${(margin * 100).toFixed(1)}% at full generative use — below the ${(floor * 100)}% floor`
    );
  }

  // And credits = video + 2 × megapixels, which is what the rate card says.
  const credits = (g) => g.video_seconds + 2 * g.still_megapixels;
  assert.strictEqual(credits(grants.pro), 850);
  assert.strictEqual(credits(grants.max), 2600);
});

test('the free tier still budgets a re-roll', () => {
  // The pricing doc budgets a wasted generation on purpose. Whatever the
  // allowance becomes, the copy must describe a video length that leaves room
  // for one — otherwise the first person to re-roll loses a third of their
  // month and concludes the product is stingy rather than that they misprompted.
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const latest = fs.readdirSync(dir)
    .filter((f) => /plan_id IS NULL AND metric = 'video_seconds'/.test(read(path.join(dir, f))))
    .sort().pop();
  const sql = read(path.join(dir, latest));

  const secs = Number(sql.match(/limit_value = (\d+),[\s\S]{0,140}?video_seconds/)[1]);
  const m = sql.match(/(\d+) videos up to (\d+)s, plus one re-roll/);
  assert.ok(m, `${latest} must say how the free seconds are meant to be spent`);

  const [, count, length] = m.map(Number);
  const needed = (count + 1) * length;    // the videos, plus one wasted take
  assert.ok(
    needed <= secs,
    `${count} × ${length}s plus a re-roll needs ${needed}s but the tier grants ${secs}s`
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
