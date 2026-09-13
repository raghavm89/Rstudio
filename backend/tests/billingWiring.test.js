'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

process.env.SELLER_GSTIN = process.env.SELLER_GSTIN || '27AAPFU0939F1ZV';
process.env.SELLER_STATE = process.env.SELLER_STATE || 'Maharashtra';
const Invoices = require('../src/services/studio/invoices');

/**
 * Money, and the two ways it goes wrong.
 *
 * One is taking it and giving nothing — a payment with no credits and no
 * invoice. The other is giving something for nothing — crediting an account
 * because the browser said a payment succeeded. Both are here.
 */

// ── GST ──────────────────────────────────────────────────────────────────────

test('same-state supply is CGST plus SGST, other states are IGST', () => {
  const within = Invoices.taxFor(200000, 'Maharashtra', 'IN');
  assert.strictEqual(within.igst, 0, 'no IGST within the seller\'s own state');
  assert.strictEqual(within.cgst + within.sgst, 36000, '18% of ₹2,000');

  const across = Invoices.taxFor(200000, 'Karnataka', 'IN');
  assert.strictEqual(across.cgst + across.sgst, 0, 'no CGST/SGST across states');
  assert.strictEqual(across.igst, 36000);
});

test('the halves always add back to the whole', () => {
  // Rounding each half independently loses a paisa on odd amounts, and an
  // invoice whose parts do not sum is one a buyer's accountant queries.
  for (const paise of [50001, 33333, 1, 7, 99999]) {
    const t = Invoices.taxFor(paise, 'Maharashtra', 'IN');
    assert.strictEqual(t.cgst + t.sgst, Math.round(paise * 0.18), `broke at ${paise}p`);
  }
});

test('export of services is zero-rated', () => {
  // Charging a foreign customer Indian GST bills them for tax they can never
  // reclaim, and it is not ours to collect.
  const t = Invoices.taxFor(200000, 'California', 'US');
  assert.strictEqual(t.cgst + t.sgst + t.igst, 0);
  assert.strictEqual(t.place_of_supply, 'Export');
});

test('an unregistered seller issues no tax at all', () => {
  const saved = process.env.SELLER_GSTIN;
  delete process.env.SELLER_GSTIN;
  delete require.cache[require.resolve('../src/services/studio/invoices')];
  const fresh = require('../src/services/studio/invoices');
  const t = fresh.taxFor(200000, 'Maharashtra', 'IN');
  assert.strictEqual(t.cgst + t.sgst + t.igst, 0, 'a bill of supply carries no tax');
  process.env.SELLER_GSTIN = saved;
  delete require.cache[require.resolve('../src/services/studio/invoices')];
});

test('invoice numbers are stamped with the Indian financial year', () => {
  // April to March. January 2027 belongs to 2026-27, and getting this wrong puts
  // an invoice in the wrong return.
  assert.strictEqual(Invoices.financialYear(new Date('2026-01-15')), '2025-26');
  assert.strictEqual(Invoices.financialYear(new Date('2026-03-31')), '2025-26');
  assert.strictEqual(Invoices.financialYear(new Date('2026-04-01')), '2026-27');
});

// ── Trust ────────────────────────────────────────────────────────────────────

test('credits are never granted on the browser\'s word', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js')));

  // The signature is what turns a payment id into evidence.
  assert.match(src, /createHmac\('sha256'/, 'the signature must be verified');
  assert.match(src, /timingSafeEqual/,
    'a string compare leaks how much of a signature was right, one byte at a time');

  // Verification must come BEFORE anything is granted.
  const verify = src.slice(src.indexOf('async function verify'));
  const check  = verify.indexOf('signatureValid');
  const grant  = verify.indexOf('grantCredits');
  assert.ok(check > -1 && grant > -1 && check < grant,
    'the signature must be checked before credits are granted');

  // And who gets credited comes from the ORDER, not the request body.
  assert.match(verify, /order\.notes\.tenant_id/,
    'the order decides whose account is credited — a request body naming a tenant would let anyone credit anyone');
});

test('a null razorpay plan id never reaches the gateway', () => {
  // plans.razorpay_plan_id is nullable because a plan exists in the product
  // before it exists at Razorpay. Passing the null gives an opaque gateway
  // error; the honest answer is that the plan is not purchasable yet.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js')));
  const sub = src.slice(src.indexOf('async function subscribe'));
  const guard = sub.indexOf('razorpay_plan_id');
  const call  = sub.indexOf('subscriptions.create');
  assert.ok(guard > -1 && guard < call, 'subscribe must refuse an unlinked plan before calling Razorpay');
  assert.match(sub, /PLAN_NOT_LINKED/);
});

test('payment, credits and invoice are one transaction', () => {
  // A payment row without credits is money taken for nothing; credits without an
  // invoice is a customer who cannot claim the tax.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js')));
  const fn = src.slice(src.indexOf('async function grantCredits'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const step of ['INSERT INTO payments', 'CreditLedger.purchase', 'Invoices.issueForPayment']) {
    assert.ok(body.includes(step), `grantCredits is missing ${step}`);
  }
  assert.match(src, /await client\.query\('BEGIN'\)/);
});

test('a webhook delivered twice credits once', () => {
  // Razorpay explicitly retries. The guarantee is in the schema, not in a
  // hopeful if-statement.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '045_ledger_invoices.sql'));
  assert.match(sql, /uq_credit_ledger_purchase[\s\S]*?ON credit_ledger\(reference\)/,
    'purchases must be unique per payment reference');
  assert.match(sql, /uq_studio_invoices_payment[\s\S]*?ON studio_invoices\(payment_id\)/,
    'one invoice per payment');
});

// ── The ledger ───────────────────────────────────────────────────────────────

test('the ledger is append-only and signed', () => {
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '045_ledger_invoices.sql'));
  // Balance is a SUM with no CASE in it — one fewer place to get a sign wrong.
  assert.match(sql, /credit_ledger_sign CHECK/);
  assert.match(sql, /kind = 'spend' AND credits < 0/);
});

test('spending locks before it reads', () => {
  // Two jobs admitted at once would otherwise both read the same balance, both
  // find it sufficient, and both spend it. With credits a double-spend is
  // indistinguishable from a gift.
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'creditLedger.js')));
  const spend = src.slice(src.indexOf('async function spend'));
  const lock  = spend.indexOf('FOR UPDATE');
  const readB = spend.indexOf('await balance(');
  assert.ok(lock > -1 && lock < readB, 'spend must take the lock before reading the balance');
});

test('only the overage is charged to bought credits', () => {
  // A job that straddles the allowance is half plan and half purchase. Charging
  // the whole job would double-bill the part the plan already covered.
  const src = strip(read(path.join(ROOT, 'src', 'models', 'studioUsage.js')));
  assert.match(src, /Math\.min\(Number\(amount\), used - effectiveLimit\)/,
    'the credit charge must be the overage, not the whole reservation');
});

test('an unused reservation comes back', () => {
  // Otherwise every over-estimate quietly becomes revenue, drifting in the
  // direction that always favours us.
  const usage = strip(read(path.join(ROOT, 'src', 'models', 'studioUsage.js')));
  assert.match(usage, /CreditLedger\.refund/, 'settle must refund unused credits');

  // And the job has to remember what it spent, or there is nothing to refund.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioJobController.js')));
  assert.match(ctl, /_from_credits/, 'the job payload must carry what it spent');

  // The orchestrator reserves for a whole shoot but settles per job, so its
  // credits have to be split across them or the shoot keeps the difference.
  const orch = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'orchestrator.js')));
  assert.match(orch, /shareOfCredits/, 'shoot-level credits must be attributed to the jobs that settle them');
});

test('lifetime caps cannot be bought around', () => {
  // Avatars and claimed faces are limits on what you may HAVE. They have no
  // credit rate, so `creditsFor` returns 0 and the purchase path is never
  // reached — a cap stays a cap.
  const { RATES } = require('../src/services/studio/credits');
  for (const metric of ['avatars', 'faces_claimed', 'publishes']) {
    assert.ok(!RATES[metric], `${metric} must not be purchasable with credits`);
  }
});

// ── The page ─────────────────────────────────────────────────────────────────

test('every price the customer sees shows the tax', () => {
  // Prices are GST-exclusive. A page saying ₹2,000 and a checkout asking ₹2,360
  // is a page abandoned at the last step.
  const src = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(src, /GST/, 'the billing page must mention GST');
  assert.match(src, /charged/, 'it should state the amount actually charged');
});

test('the balance refreshes from the server, not from the handler', () => {
  const src = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  const buy = src.slice(src.indexOf('async function buy('));
  assert.match(buy.slice(0, 600), /await buyCredits/);
  assert.match(buy.slice(0, 600), /credits\.reload\(\)/,
    'the balance must be re-read after a purchase rather than assumed');
});

test('the studio tables do not collide with tables it did not create', () => {
  // 045 first used the bare name `invoices`. The database already had one — not
  // from any migration here — so CREATE TABLE IF NOT EXISTS skipped silently and
  // the next statement failed against a table with no payment_id. The schema has
  // drifted from the ledger before, in exactly this way, with users.password.
  //
  // Everything this product adds is namespaced. This checks the new tables
  // followed that, so the next one does not have to learn it the same way.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '045_ledger_invoices.sql'));
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(created.length >= 2, 'expected the ledger and invoice tables');

  const generic = created.filter((t) => !/^(studio_|credit_)/.test(t));
  assert.deepStrictEqual(generic, [],
    `these table names are not namespaced and may collide: ${generic.join(', ')}`);

  // And no code may reach for the un-namespaced name.
  for (const rel of ['services/studio/invoices.js', 'controllers/studioBillingController.js']) {
    const src = read(path.join(ROOT, 'src', rel));
    assert.ok(!/\b(FROM|INTO|UPDATE)\s+invoices\b/.test(src),
      `${rel} still queries the bare invoices table`);
  }
});

test('an invoice names its payment, without a join', () => {
  // `payment_id` is our own row id AND ON DELETE SET NULL — so it can become
  // null, and even while set it means nothing outside this database. The person
  // reconciling holds a Razorpay dashboard or a bank statement, and both speak
  // pay_.... So the gateway reference is copied onto the invoice at issue.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '046_invoice_payment_ref.sql'));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS payment_ref/);

  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'invoices.js')));
  assert.match(svc, /payment\.razorpay_payment_id/,
    'the gateway id must be snapshotted onto the invoice');
  assert.match(svc, /payment_ref:\s*row\.payment_ref/,
    'and returned to the page that displays it');

  // It must not be reconstructed by joining payments — that is the thing the
  // snapshot exists to avoid.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js')));
  assert.ok(!/JOIN payments/i.test(ctl), 'invoices must not join payments to find their reference');

  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(page, /payment_ref/, 'the invoice must show its payment reference');
});

test('a second webhook does not lose a method the first one knew', () => {
  // The client-side verify fetches the method; a webhook may arrive without it,
  // or the other way round. Whichever lands second must not overwrite a known
  // value with null.
  const ctl = read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js'));
  assert.match(ctl, /COALESCE\(payments\.method, EXCLUDED\.method\)/,
    'the upsert must keep a method it already has');
});

test('a plan that cannot be bought does not offer a buy button', () => {
  // The 503 guard is right, but it fires after a click. A card that knows the
  // plan has no Razorpay counterpart should say so instead of offering a button
  // whose only possible outcome is an error banner.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioPlansController.js')));
  assert.match(ctl, /purchasable:/, '/plans must report whether each plan can be bought');
  assert.match(ctl, /Boolean\(p\.razorpay_plan_id\)/, 'purchasability comes from the linked plan id');

  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(page, /p\.purchasable === false/, 'the card must branch on it');
});

/** The body of every `catch (x) { ... }` in a source file, brace-matched. */
function catchBlocks(src) {
  const out = [];
  const re = /catch\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

test('an error that says what to do keeps the part that says it', () => {
  // A refusal carries a terse `error` — which becomes ApiError.message — and a
  // `message` that says what to do about it. Showing only the first is how
  // "This plan cannot be bought yet" reaches someone with no hint that the fix
  // is two fields in a Razorpay dashboard.
  //
  // The join lives in one helper because it was written by hand three times and
  // the third, the address form's save handler, dropped the explanation. So the
  // rule is not "mentions body.message" — that only ever matched the copies
  // someone remembered to write — but "an error we CAUGHT is shown through the
  // helper". A sentence this page composes itself is already the explanation
  // and is deliberately not covered.
  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));

  const blocks = catchBlocks(page);
  assert.ok(blocks.length >= 3, `expected the page's catch blocks, found ${blocks.length}`);

  let checked = 0;
  for (const block of blocks) {
    for (const [, expr] of block.matchAll(/setErr\(([^;]*?)\);/g)) {
      if (expr.trim() === 'null') continue;         // clearing is not showing
      checked++;
      assert.ok(/errorText\(/.test(expr.trim()),
        `a caught error is shown without going through errorText: setErr(${expr.trim()})`);
    }
  }
  assert.ok(checked >= 3, `expected all three error paths, checked ${checked}`);

  // And the helper has to actually do the joining, or the above is a naming
  // convention rather than a guarantee.
  const api = read(path.join(FE, 'lib', 'api.js'));
  const fn  = api.slice(api.indexOf('export function errorText'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /err\?\.body\?\.message/, 'errorText must read the explanatory half');
  assert.match(body, /err\?\.message/,          'and the terse half');
  assert.match(body, /\$\{terse\} — \$\{said\}/, 'and show both when they differ');
});

// ── The billing address ──────────────────────────────────────────────────────

test('a missing state would charge the wrong tax, which is why it is required', () => {
  // This is the reason the gate exists, so it is asserted rather than asserted
  // about. SELLER_STATE is Maharashtra; a Maharashtra buyer owes CGST+SGST.
  // With no state recorded, taxFor cannot tell and falls to the inter-state
  // branch — the buyer is charged IGST, the amount is filed under the wrong
  // head, and the invoice can only be cancelled and reissued, not corrected.
  const known   = Invoices.taxFor(200000, 'Maharashtra', 'IN');
  const unknown = Invoices.taxFor(200000, null, 'IN');

  assert.ok(known.cgst + known.sgst > 0 && known.igst === 0);
  assert.strictEqual(unknown.igst, 36000, 'an absent state silently becomes IGST');
  assert.strictEqual(unknown.place_of_supply, 'Unspecified');
});

test('an invoice cannot be issued without name, address, city and state', () => {
  const B = require('../src/services/studio/billingProfile');

  assert.deepStrictEqual(B.missingFrom({
    billing_name: 'Rach Dev LLP', billing_line1: '1 Hill Road', billing_city: 'Mumbai',
    billing_state: 'Maharashtra', billing_pin: '400050', billing_country: 'IN',
  }), [], 'a complete Indian profile is complete');

  const missing = B.missingFrom({
    billing_name: 'Rach Dev LLP', billing_line1: '1 Hill Road', billing_city: 'Mumbai',
    billing_country: 'IN',
  }).map((m) => m.field);
  assert.deepStrictEqual(missing, ['billing_state', 'billing_pin']);

  // Whitespace is not an address.
  assert.ok(B.missingFrom({
    billing_name: '   ', billing_line1: '1 Hill Road', billing_city: 'Mumbai',
    billing_state: 'Maharashtra', billing_pin: '400050', billing_country: 'IN',
  }).some((m) => m.field === 'billing_name'));

  // Outside India the supply is an export, zero-rated: a province we cannot
  // validate adds nothing to the invoice, so it is not demanded.
  assert.deepStrictEqual(B.missingFrom({
    billing_name: 'Acme Inc', billing_line1: '1 Market St', billing_city: 'San Francisco',
    billing_country: 'US',
  }), [], 'state and PIN are asked for in India only');
});

test('neither payment route can start without one', () => {
  // Before the gateway, not after. A Razorpay window that opens and then fails
  // on the way back has already asked someone for a UPI PIN.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioBillingController.js')));

  for (const [fn, gatewayCall] of [['subscribe', 'subscriptions.create'], ['topup', 'orders.create']]) {
    const body  = src.slice(src.indexOf(`async function ${fn}(`));
    const gate  = body.indexOf('blockedForBilling');
    const call  = body.indexOf(gatewayCall);
    assert.ok(gate > -1, `${fn} does not check the billing address at all`);
    assert.ok(gate < call, `${fn} calls ${gatewayCall} before checking the address`);
  }

  // And the refusal is recognisable by code, because the sentence will be reworded.
  const B = require('../src/services/studio/billingProfile');
  const r = B.refusal(B.missingFrom({}));
  assert.strictEqual(r.body.code, 'BILLING_ADDRESS_REQUIRED');
  assert.strictEqual(r.status, 409, 'the request is well formed; the account is not ready');
  assert.match(r.body.message, /Billing address/, 'the message must say where to fix it');
});

test('the page and the server read one list, not two', () => {
  // A second copy of "what an invoice needs" in the browser is a copy that
  // drifts, and the browser's is the one nobody updates.
  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  assert.match(page, /billing_complete/, 'the page must use the server\'s verdict');
  assert.doesNotMatch(page, /billing_line1'\s*,\s*'billing_city/,
    'the required-field list must not be restated in the browser');

  // The verdict has to actually be sent.
  const profile = strip(read(path.join(ROOT, 'src', 'controllers', 'studioProfileController.js')));
  assert.match(profile, /billing_complete/, '/profile must report completeness');
  assert.match(profile, /BillingProfile\.missingFrom/, 'and which fields are missing');
});

test('the page stops before checkout opens, and says which fields', () => {
  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));

  for (const [fn, opener] of [['async function choose(', 'subscribeToPlan'], ['async function buy(', 'buyCredits']]) {
    const body   = page.slice(page.indexOf(fn));
    const guard  = body.indexOf('gate.complete');
    const open   = body.indexOf(opener);
    assert.ok(guard > -1 && guard < open, `${fn.trim()} opens checkout before checking the address`);
  }

  // Told while reading the prices, not on the click.
  assert.match(page, /function AddressNotice/, 'the page should say so before anything is clicked');
  // And the field is somewhere to go, not just something named.
  assert.match(page, /id="billing-address"/);
  assert.match(page, /id="billing_state"/, 'the missing field must be focusable by name');
});

test('a link-shaped button is actually shaped like a link', () => {
  // The sign-out button shipped with a class that was not a button class and
  // wore the browser's default chrome. Same mistake, one file away.
  const css = read(path.join(FE, 'app', 'globals.css'));
  const page = read(path.join(FE, 'app', 'billing', 'page.jsx'));
  if (/<button[^>]*className="lnk"/.test(page)) {
    assert.match(css, /button\.lnk\s*\{[^}]*border:\s*0/, 'button.lnk needs the chrome reset');
    assert.match(css, /button\.lnk\s*\{[^}]*font:\s*inherit/, 'and the inherited font');
  }
});

// ── Live keys ────────────────────────────────────────────────────────────────

test('a live key cannot be used outside production', () => {
  // There is no sandbox flag on a Razorpay call. The KEY decides everything: an
  // order made with rzp_live_ takes real money from whoever is at the browser,
  // and nothing about a localhost request looks different at the gateway. The
  // only place to catch it is before the first call.
  const load = () => {
    delete require.cache[require.resolve('../src/services/razorpay')];
    return require('../src/services/razorpay');
  };
  const saved = { ...process.env };
  const restore = () => {
    process.env.RAZORPAY_KEY_ID = saved.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = saved.RAZORPAY_KEY_SECRET;
    process.env.NODE_ENV = saved.NODE_ENV;
    delete process.env.RAZORPAY_ALLOW_LIVE;
    delete require.cache[require.resolve('../src/services/razorpay')];
  };

  try {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_XXXXXXXXXXXX';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    process.env.NODE_ENV = 'development';

    let thrown = null;
    try { load().orders; } catch (e) { thrown = e; }
    assert.ok(thrown, 'a live key in development must not produce a client');
    assert.strictEqual(thrown.code, 'RAZORPAY_LIVE_KEYS_IN_DEV');
    assert.strictEqual(thrown.status, 503);
    assert.match(thrown.publicMessage, /rzp_test_/, 'the refusal must say what to do instead');

    // Asking whether the keys are live must never itself build a client — that
    // is the question you ask when you are not yet sure it is safe to.
    assert.strictEqual(load().isLiveKey('rzp_live_x'), true);
    assert.strictEqual(load().isLiveKey('rzp_test_x'), false);

    // Test keys are fine anywhere.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_XXXXXXXXXXXX';
    assert.doesNotThrow(() => load().orders, 'test keys must work in development');
  } finally { restore(); }
});

test('there is exactly one place a Razorpay client is built', () => {
  // A guard on one constructor is worth nothing if another file builds its own.
  // agentController did: `new Razorpay({ key_id: process.env... })` inline,
  // reading the same two variables and skipping the check — so that one path
  // could have taken real money from a laptop while every other path refused.
  const fs = require('node:fs');
  const dir = path.join(ROOT, 'src');

  const offenders = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === path.join(ROOT, 'src', 'services', 'razorpay.js')) continue;
      if (/new\s+Razorpay\s*\(/.test(strip(fs.readFileSync(full, 'utf8')))) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  })(dir);

  assert.deepStrictEqual(offenders, [],
    `these build their own Razorpay client and bypass the live-key guard: ${offenders.join(', ')}`);
});

test('a refusal that knows the fix can get the fix to the screen', () => {
  // The billing page shows `error` plus `body.message`. An error thrown from a
  // service reaches the browser through the express handler, and if that handler
  // drops publicMessage the page can only show the terse half — which is the
  // exact failure this suite already has a test about, one layer down.
  const src = strip(read(path.join(ROOT, 'src', 'app.js')));
  const handler = src.slice(src.indexOf('app.use((err, req, res, next)'));
  assert.match(handler, /err\.publicMessage/, 'the handler must pass the explanatory half through');
  assert.match(handler, /err\.code/, 'and the code the page branches on');
  // But never on a 500: an unhandled exception's message is ours and may name
  // internals.
  assert.match(handler, /status !== 500/, 'publicMessage must not leak from a 500');
});

test('the plan-linking script will not touch live keys by accident', () => {
  // A live plan is visible to real customers and cannot be deleted once anyone
  // subscribes to it — only deactivated.
  const src = read(path.join(ROOT, 'studio', 'link-razorpay-plans.js'));
  assert.match(src, /rzp_live_/, 'the script must recognise live keys');
  assert.match(src, /ALLOW_LIVE/, 'and require an explicit flag for them');
  assert.match(src, /--yes/, 'and default to a dry run');
});
