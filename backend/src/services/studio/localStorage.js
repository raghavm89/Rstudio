'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Local-disk storage — the same interface as the S3 `Storage` class, no bucket.
 *
 * Studio's storage contract is small: hand a worker somewhere to PUT one file,
 * and give everyone else a URL to read it back. S3 does that with a presigned
 * URL; this does it with an HMAC-signed token and two routes on our own API.
 * `uploadTarget()` returns the same shape either way, so the worker, the
 * uploader and the publisher are all unchanged — only the host in the URL moves.
 *
 * Use it for local development and single-machine deploys. It keeps the same
 * three properties the S3 path has, because they are the ones that matter:
 *
 *   • The upload URL is scoped to ONE key, ONE method, and a few minutes.
 *   • The worker never holds a storage credential.
 *   • Keys are `t{tenant}/…`, so every object is attributable from its path.
 *
 * What it does NOT give you is a public address reachable from the internet.
 * That matters in exactly one place: Instagram's Content Publishing API
 * **fetches** media from a URL rather than accepting an upload, so publishing
 * needs either a real bucket or a tunnel. Everything upstream of publishing —
 * generating, QC, assembly, review — works fine on disk.
 */

const ALGORITHM = 'sha256';

/** Anything not on this list is not served, even if it lands in the directory. */
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.safetensors': 'application/octet-stream',
};

class LocalStorageError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'LocalStorageError';
    this.status = status;
  }
}

/**
 * A key is a relative path we generated. It is never taken from a client, but
 * it does arrive back from one inside a signed token, so it is validated on the
 * way in as well as on the way out — a signature proves the token was minted
 * here, not that the process that minted it was free of bugs.
 */
function assertSafeKey(key) {
  if (!key || typeof key !== 'string') throw new LocalStorageError('key is required');
  if (key.startsWith('/') || key.includes('..') || key.includes('\0')) {
    throw new LocalStorageError('Unsafe storage key');
  }
  if (!/^[A-Za-z0-9/._-]+$/.test(key)) throw new LocalStorageError('Unsafe storage key');
}

class LocalStorage {
  constructor({
    root      = process.env.STUDIO_STORAGE_DIR || path.join(process.cwd(), 'studio-storage'),
    baseUrl   = process.env.STUDIO_PUBLIC_BASE || 'http://127.0.0.1:3000',
    secret    = process.env.STUDIO_STORAGE_SECRET || process.env.STUDIO_WORKER_TOKEN || '',
    mountPath = '/api/studio/files',
  } = {}) {
    this.root = path.resolve(root);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.secret = secret;
    this.mountPath = mountPath;
    this.driver = 'local';
  }

  get configured() {
    // A secret is not optional. Without one every upload URL would be forgeable,
    // which on a machine that also serves those files publicly is a write
    // primitive, not an inconvenience.
    return Boolean(this.root && this.secret);
  }

  assertConfigured() {
    if (!this.configured) {
      throw new Error(
        'Local storage needs STUDIO_STORAGE_SECRET (or STUDIO_WORKER_TOKEN) set — ' +
        'an unsigned upload URL is forgeable.'
      );
    }
  }

  keyFor({ tenantId, avatarSlug = 'unknown', projectId = 'misc', kind = 'asset', filename }) {
    const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return `t${tenantId}/${avatarSlug}/${projectId}/${kind}/${Date.now()}-${safe}`;
  }

  /**
   * Sign an upload grant.
   *
   * The content type is signed alongside the key and expiry, so a token issued
   * for a PNG cannot be redeemed with an HTML body — the same property the S3
   * path gets from signing the Content-Type header.
   */
  sign(key, contentType, expiresAt) {
    return crypto
      .createHmac(ALGORITHM, this.secret)
      .update(`${key}\n${contentType}\n${expiresAt}`)
      .digest('hex');
  }

  verify(key, contentType, expiresAt, signature) {
    const expected = this.sign(key, contentType, expiresAt);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(signature || ''), 'hex');
    // Length check first: timingSafeEqual throws on a mismatch rather than
    // returning false, and the length is not a secret.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  uploadTarget({ tenantId, avatarSlug, projectId, kind, filename, contentType, expiresIn = 900 }) {
    this.assertConfigured();
    const key = this.keyFor({ tenantId, avatarSlug, projectId, kind, filename });
    assertSafeKey(key);

    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const signature = this.sign(key, contentType, expiresAt);
    const qs = new URLSearchParams({ key, ct: contentType, exp: String(expiresAt), sig: signature });

    return {
      key,
      method: 'PUT',
      url: `${this.baseUrl}${this.mountPath}/upload?${qs}`,
      headers: contentType ? { 'Content-Type': contentType } : {},
      expires_in: expiresIn,
      public_url: this.publicUrl(key),
    };
  }

  /** Where a stored object is read from. Not internet-reachable — see the note above. */
  publicUrl(key) {
    return `${this.baseUrl}${this.mountPath}/${key}`;
  }

  readUrl(key) {
    return this.publicUrl(key);
  }

  /** Resolve a key to a path, refusing anything that escapes the root. */
  pathFor(key) {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    // Belt and braces. assertSafeKey already rejects `..`, but a symlinked root
    // or an odd normalisation is exactly the case where one check is not enough.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new LocalStorageError('Storage key escapes the storage root');
    }
    return full;
  }

  /** Redeem an upload token. Throws with a status; the route just reports it. */
  put(key, { contentType, expiresAt, signature, body }) {
    this.assertConfigured();

    if (!this.verify(key, contentType, expiresAt, signature)) {
      throw new LocalStorageError('Bad upload signature', { status: 403 });
    }
    if (Number(expiresAt) < Math.floor(Date.now() / 1000)) {
      throw new LocalStorageError('Upload URL has expired', { status: 403 });
    }

    const full = this.pathFor(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return { key, bytes: body.length, public_url: this.publicUrl(key) };
  }

  contentTypeFor(key) {
    return CONTENT_TYPES[path.extname(key).toLowerCase()] || null;
  }

  /**
   * Read one object back.
   *
   * An extension not on the list is refused rather than served as
   * `application/octet-stream`. These files are served from our own origin, and
   * a directory of attacker-influenced filenames served with a guessed type is
   * how a storage folder becomes an XSS surface.
   */
  get(key) {
    const full = this.pathFor(key);
    const contentType = this.contentTypeFor(key);
    if (!contentType) throw new LocalStorageError('Unsupported file type', { status: 415 });
    if (!fs.existsSync(full)) throw new LocalStorageError('Not found', { status: 404 });
    return { path: full, contentType, bytes: fs.statSync(full).size };
  }
}

module.exports = { LocalStorage, LocalStorageError, assertSafeKey, CONTENT_TYPES };
