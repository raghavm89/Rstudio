'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LocalStorage, assertSafeKey } = require('../../src/services/studio/localStorage');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-'));

const storage = (over = {}) => new LocalStorage({
  root: ROOT,
  baseUrl: 'http://127.0.0.1:5000',
  secret: 'test-secret-abc',
  ...over,
});

const target = (over = {}) => storage().uploadTarget({
  tenantId: 7, avatarSlug: 'aanya-kapoor', projectId: 12, kind: 'still',
  filename: 'shot1-1.png', contentType: 'image/png', ...over,
});

const parse = (url) => Object.fromEntries(new URL(url).searchParams);

// ── The same contract as the S3 driver ────────────────────────────────────────

test('uploadTarget returns the shape the uploader already expects', () => {
  const t = target();
  // The worker, uploader and publisher are unchanged between drivers — only the
  // host in the URL moves.
  assert.deepStrictEqual(Object.keys(t).sort(),
    ['expires_in', 'headers', 'key', 'method', 'public_url', 'url'].sort());
  assert.strictEqual(t.method, 'PUT');
  assert.strictEqual(t.headers['Content-Type'], 'image/png');
});

test('keys are tenant-first, so an object is attributable from its path alone', () => {
  assert.match(target().key, /^t7\/aanya-kapoor\/12\/still\/\d+-shot1-1\.png$/);
});

// ── The signature is the credential ───────────────────────────────────────────

test('an upload is refused without a valid signature', () => {
  const s = storage();
  const t = target();
  const q = parse(t.url);
  assert.throws(
    () => s.put(q.key, { contentType: q.ct, expiresAt: q.exp, signature: 'deadbeef', body: Buffer.from('x') }),
    (e) => e.status === 403
  );
});

test('🔒 a token issued for a PNG cannot be redeemed with HTML', () => {
  // These files are served from our own origin so Instagram can fetch them. If
  // the content type were not signed, a leaked worker token would be a stored-XSS
  // primitive under a signature we minted.
  const s = storage();
  const q = parse(target().url);
  assert.throws(
    () => s.put(q.key, { contentType: 'text/html', expiresAt: q.exp, signature: q.sig, body: Buffer.from('<script>') }),
    (e) => e.status === 403
  );
});

test('an expired grant is refused even with a good signature', () => {
  const s = storage();
  const past = Math.floor(Date.now() / 1000) - 10;
  const key = 't7/a/1/still/old.png';
  const sig = s.sign(key, 'image/png', past);
  assert.throws(
    () => s.put(key, { contentType: 'image/png', expiresAt: past, signature: sig, body: Buffer.from('x') }),
    (e) => e.status === 403 && /expired/i.test(e.message)
  );
});

test('a signature for one key does not work on another', () => {
  const s = storage();
  const q = parse(target().url);
  assert.throws(
    () => s.put('t9/other/1/still/theirs.png', {
      contentType: q.ct, expiresAt: q.exp, signature: q.sig, body: Buffer.from('x'),
    }),
    (e) => e.status === 403
  );
});

test('verify does not throw on a malformed signature', () => {
  // timingSafeEqual throws on a length mismatch rather than returning false, so
  // a junk signature must be length-checked first or it 500s instead of 403s.
  const s = storage();
  for (const junk of ['', 'zz', 'not-hex', 'a'.repeat(200)]) {
    assert.strictEqual(s.verify('k', 'image/png', 1, junk), false);
  }
});

// ── Path safety ───────────────────────────────────────────────────────────────

test('🔒 a key cannot escape the storage root', () => {
  for (const bad of ['../etc/passwd', 't1/../../etc/passwd', '/etc/passwd', 't1/a\0b', 't1/$(whoami)']) {
    assert.throws(() => assertSafeKey(bad), /Unsafe storage key/, `accepted "${bad}"`);
  }
  const s = storage();
  assert.throws(() => s.pathFor('../outside.png'));
});

test('a legitimate key resolves inside the root', () => {
  const s = storage();
  const full = s.pathFor('t7/aanya-kapoor/12/still/1234-shot1.png');
  assert.ok(full.startsWith(path.resolve(ROOT) + path.sep));
});

// ── Round trip ────────────────────────────────────────────────────────────────

test('a signed upload round-trips to disk and reads back', () => {
  const s = storage();
  const t = target();
  const q = parse(t.url);
  const body = Buffer.from('fake png bytes');

  const out = s.put(q.key, { contentType: q.ct, expiresAt: q.exp, signature: q.sig, body });
  assert.strictEqual(out.bytes, body.length);
  assert.strictEqual(out.public_url, t.public_url);

  const got = s.get(q.key);
  assert.strictEqual(got.contentType, 'image/png');
  assert.strictEqual(fs.readFileSync(got.path).toString(), 'fake png bytes');
});

test('🔒 an unknown extension is refused rather than guessed', () => {
  // A directory of attacker-influenced filenames served with a guessed type is
  // how a storage folder becomes an XSS surface on our own origin.
  const s = storage();
  const key = 't7/a/1/still/payload.html';
  fs.mkdirSync(path.dirname(s.pathFor(key)), { recursive: true });
  fs.writeFileSync(s.pathFor(key), '<script>alert(1)</script>');
  assert.throws(() => s.get(key), (e) => e.status === 415);
});

test('a missing object is a 404, not a crash', () => {
  assert.throws(() => storage().get('t7/a/1/still/nope.png'), (e) => e.status === 404);
});

test('the LoRA and video types round-trip too', () => {
  const s = storage();
  for (const [name, type] of [['m.safetensors', 'application/octet-stream'],
                              ['c.mp4', 'video/mp4'],
                              ['s.zip', 'application/zip']]) {
    const t = target({ filename: name, contentType: type, kind: 'lora' });
    const q = parse(t.url);
    s.put(q.key, { contentType: q.ct, expiresAt: q.exp, signature: q.sig, body: Buffer.from('x') });
    assert.strictEqual(s.get(q.key).contentType, type);
  }
});

// ── Configuration ─────────────────────────────────────────────────────────────

test('an unsigned setup refuses to mint URLs at all', () => {
  // Without a secret every upload URL is forgeable, which on a host that also
  // serves those files is a write primitive rather than an inconvenience.
  const s = new LocalStorage({ root: ROOT, secret: '' });
  assert.strictEqual(s.configured, false);
  assert.throws(() => s.uploadTarget({ tenantId: 1, filename: 'a.png', contentType: 'image/png' }),
    /forgeable/);
});

// ── Which driver, and can the world reach it ──────────────────────────────────

test('reachability is decided by configuration, not guessed from a URL', () => {
  const { isPubliclyFetchable, storageDriver } = require('../../src/services/studio/storageFactory');
  const saved = { ...process.env };
  try {
    process.env.STUDIO_STORAGE = 'local';

    // Instagram FETCHES media from a URL and fal fetches the training zip.
    // A laptop can do neither, and the server is the only party that knows.
    process.env.STUDIO_PUBLIC_BASE = 'http://127.0.0.1:5000';
    assert.strictEqual(isPubliclyFetchable(), false);
    process.env.STUDIO_PUBLIC_BASE = 'http://localhost:5000';
    assert.strictEqual(isPubliclyFetchable(), false);
    process.env.STUDIO_PUBLIC_BASE = 'https://studio.rstudio.app';
    assert.strictEqual(isPubliclyFetchable(), true);

    assert.strictEqual(storageDriver(), 'local');
  } finally {
    process.env.STUDIO_STORAGE = saved.STUDIO_STORAGE;
    process.env.STUDIO_PUBLIC_BASE = saved.STUDIO_PUBLIC_BASE;
  }
});

test('an unknown driver is refused rather than silently defaulting to disk', () => {
  const { createStorage } = require('../../src/services/studio/storageFactory');
  const saved = process.env.STUDIO_STORAGE;
  try {
    process.env.STUDIO_STORAGE = 'gcs';
    // Quietly writing to disk because a name was misspelled is how a month of
    // posts end up on a laptop that Instagram cannot reach.
    assert.throws(() => createStorage(), /Unknown STUDIO_STORAGE/);
  } finally {
    process.env.STUDIO_STORAGE = saved;
  }
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
