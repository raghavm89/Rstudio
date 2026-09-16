#!/usr/bin/env node
'use strict';

/**
 * Verify object storage end to end — before you point real shoots at it.
 *
 *   node studio/verify-storage.js
 *
 * preflight.js round-trips an object only for the `local` driver; for `s3` it
 * checks that the S3_* vars are present and stops there. That leaves the part
 * that actually breaks in production untested: whether the credentials can
 * WRITE to the bucket, and — the one that bites latest and hardest — whether
 * what you write is PUBLICLY fetchable, because Instagram's Content Publishing
 * API and fal both fetch media by URL and neither will send a signature.
 *
 * This script closes that gap. It uploads a tiny object through a presigned PUT
 * (the exact path a render worker uses), then proves three things about it:
 *   1. the public URL fetches WITHOUT a signature   (Instagram / fal can read it)
 *   2. a presigned GET fetches it                    (private assets read back)
 *   3. it cleans the object up afterwards            (best effort)
 *
 * Run it from the machine and shell that runs your shoots, with the live .env,
 * so it sees exactly the network and credentials the pipeline will.
 */

require('dotenv').config();
const path = require('path');

const { createStorage, storageDriver, isPubliclyFetchable } =
  require(path.join(__dirname, '..', 'src', 'services', 'studio', 'storageFactory'));

const ok   = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
let bad = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); bad += 1; };

async function main() {
  console.log('\nStorage verification\n');

  const driver = storageDriver();
  console.log(`Driver: ${driver}`);
  if (driver !== 's3') {
    console.log(
      `\nThis script verifies the S3 driver, but STUDIO_STORAGE is "${driver}".\n` +
      'Set STUDIO_STORAGE=s3 and the S3_* block in .env, then re-run.\n' +
      '(The local driver is already round-tripped by studio/preflight.js.)\n');
    process.exit(driver === 'local' ? 0 : 1);
  }

  const storage = createStorage();
  try { storage.assertConfigured(); ok('S3_ENDPOINT / S3_BUCKET / keys all present'); }
  catch (err) { fail(err.message); return finish(); }

  if (!isPubliclyFetchable()) {
    fail('S3_PUBLIC_BASE is not set — publishing checks isPubliclyFetchable() and ' +
         'will refuse. Set it to the bucket\'s public read URL.');
  } else {
    ok(`S3_PUBLIC_BASE = ${process.env.S3_PUBLIC_BASE}`);
  }

  // A render worker never calls storage.put(); it asks for an upload target and
  // PUTs to the presigned URL. Do exactly that, so a failure here is a failure
  // the pipeline would hit — not an artefact of the test.
  const body = Buffer.from(`zoq storage check ${new Date().toISOString()}`);
  const target = storage.uploadTarget({
    tenantId: 0, avatarSlug: '_verify', projectId: 'check',
    kind: 'asset', filename: 'ping.txt', contentType: 'text/plain',
  });
  info(`key: ${target.key}`);

  // 1 — upload through the presigned PUT
  {
    const res = await fetch(target.url, {
      method: 'PUT', headers: target.headers, body,
    }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
    if (!res.ok) {
      fail(`presigned PUT failed (HTTP ${res.status}${res._err ? ' — ' + res._err : ''}). ` +
           'Usually wrong keys, wrong bucket, or the endpoint/region not matching the bucket.');
      return finish();
    }
    ok('presigned PUT uploaded the object');
  }

  // 2 — the public URL must fetch WITHOUT a signature (this is the real test)
  {
    const res = await fetch(target.public_url)
      .catch((e) => ({ ok: false, status: 0, _err: e.message }));
    if (!res.ok) {
      fail(`public URL is NOT fetchable (HTTP ${res.status}${res._err ? ' — ' + res._err : ''}).\n` +
           `        ${target.public_url}\n` +
           '        The bucket needs public read (a bucket policy / "Public" toggle), and\n' +
           '        S3_PUBLIC_BASE must point at that public host. Instagram and fal fetch\n' +
           '        media here with no signature, so a shoot would publish-fail at the end.');
    } else {
      const got = (await res.text().catch(() => '')).trim();
      if (got === body.toString()) ok('public URL fetched the object (no signature) — Instagram/fal can read it');
      else fail(`public URL returned unexpected content: "${got.slice(0, 40)}"`);
    }
  }

  // 3 — presigned GET (private assets: seed images, consent video, the LoRA)
  {
    const res = await fetch(storage.readUrl(target.key, { expiresIn: 120 }))
      .catch((e) => ({ ok: false, status: 0, _err: e.message }));
    if (!res.ok) fail(`presigned GET failed (HTTP ${res.status}${res._err ? ' — ' + res._err : ''})`);
    else ok('presigned GET read the object back — private assets work');
  }

  // 4 — tidy up (best effort; a leftover crumb is not a failure)
  {
    const res = await fetch(storage.presign('DELETE', target.key, { expiresIn: 120 }), { method: 'DELETE' })
      .catch(() => ({ ok: false, status: 0 }));
    if (res.ok || res.status === 204) ok('cleaned up the test object');
    else info(`could not delete the test object (harmless): ${target.key}`);
  }

  finish();
}

function finish() {
  if (bad) {
    console.log(`\n${bad} check(s) FAILED — storage is not ready for shoots.\n`);
    process.exit(1);
  }
  console.log('\nAll storage checks passed. You can drop the tunnel and point shoots at S3.\n');
  process.exit(0);
}

main().catch((err) => { console.error('\nverify-storage crashed:', err); process.exit(1); });
