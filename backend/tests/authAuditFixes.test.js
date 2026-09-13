'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * Guards for the auth-audit fixes that can regress silently.
 *
 * Each of these was found by reading, not by anything failing — which is the
 * argument for the tests. A dead code branch, a message nobody reads, a
 * scheme-less URL and a login gate that refuses the wrong people all keep
 * working well enough to ship.
 */

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const authCtl   = () => strip(read(path.join(ROOT, 'src', 'controllers', 'authController.js')));
const authScrn  = () => strip(read(path.join(FE, 'components', 'AuthScreen.jsx')));

test('login only demands phone verification when there is a phone', () => {
  // It used to refuse every account with phone_verified = false, including the
  // ones with no number at all — every pre-requirement account and every OAuth
  // account. They were told to contact support, forever, about a code that
  // could not be sent to a number that did not exist.
  const src = authCtl();
  assert.match(
    src, /user\.phone_number && !user\.phone_verified/,
    'the phone gate must require a phone number to be present'
  );
  assert.ok(
    !/Account not yet verified\. Please contact support/.test(src),
    'the dead-end "contact support" message should be gone'
  );
});

test('the phone-unverified refusal is answerable', () => {
  const ctl = authCtl();
  // The server has to say enough for a screen to act: which failure this is,
  // and who it is about.
  assert.match(ctl, /PHONE_UNVERIFIED/, 'the refusal needs a machine-readable code');
  assert.match(ctl, /user_id\s*:/,      'the refusal needs the user id');

  // And the screen has to have a branch for it, or the SMS goes nowhere.
  const scr = authScrn();
  assert.match(scr, /PHONE_UNVERIFIED/, 'the sign-in screen must handle that refusal');
  assert.match(scr, /completePhoneLogin/, 'and finish the sign-in with the code');

  // The client method it needs must exist and must produce a session, since
  // this completes a sign-in rather than starting one.
  const lib = read(path.join(FE, 'lib', 'auth.js'));
  assert.match(lib, /call\('verify-phone'/, 'no client method calls /api/auth/verify-phone');
  assert.match(lib, /call\('resend-otp'/,   'no client method resends the login code');
});

test('the sign-in screen has no branch the server never takes', () => {
  // `pending_id` was branched on and login has never returned it. Harmless, and
  // it tells the next reader login has a resume path that does not exist.
  const scr = authScrn();
  const loginFn = scr.slice(scr.indexOf('async function submitSignIn'));
  const body = loginFn.slice(0, loginFn.indexOf('\n  }'));
  assert.ok(
    !/pending_id/.test(body),
    'submitSignIn branches on pending_id, which login never returns'
  );
});

test('CodeStep does not choose its own resend endpoint', () => {
  // Three flows share it now. A switch inside would grow a case per flow, in the
  // file least likely to be re-read.
  const scr = authScrn();
  assert.match(scr, /onResend/, 'the caller should supply the resend');
  const step = scr.slice(scr.indexOf('function CodeStep'));
  assert.ok(
    !/auth\.resendPhone|auth\.resend\(/.test(step),
    'CodeStep should not name resend endpoints itself'
  );
});

test('two sign-ups cannot hold one phone number', () => {
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const found = fs.readdirSync(dir).some((f) =>
    /UNIQUE \(phone_number\)/i.test(read(path.join(dir, f)))
  );
  assert.ok(found, 'no migration adds a unique phone constraint to pending_registrations');

  // And the constraint must be handled, or it is a 500 where a sentence belongs.
  const ctl = authCtl();
  assert.match(ctl, /PENDING_PHONE_TAKEN/, 'register must answer the collision, not throw');
  assert.match(ctl, /23505/, 'and must catch the race the pre-check cannot close');
});

test('nothing passes a raw APP_URL to a redirect or an email', () => {
  // Scheme-less "rstudio.app" is a RELATIVE path to res.redirect, and unlinkable
  // to most mail clients.
  const offenders = [];
  for (const rel of ['services/brevo.js', 'routes/oauth.js']) {
    const src = strip(read(path.join(ROOT, 'src', rel)));
    for (const m of src.matchAll(/const\s+APP_URL[^\n]*=\s*([^\n]+)/g)) {
      if (!/siteUrl\(/.test(m[1])) offenders.push(`${rel}: ${m[1].trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `raw APP_URL still used:\n    ${offenders.join('\n    ')}`);
});

test('there is one siteUrl helper, not two', () => {
  const oauth = read(path.join(ROOT, 'src', 'routes', 'oauth.js'));
  assert.ok(
    !/function siteUrl\s*\(/.test(oauth),
    'oauth.js should import the shared helper rather than define its own'
  );
  assert.match(oauth, /require\('\.\.\/utils\/siteUrl'\)/);
});
