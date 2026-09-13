'use strict';

const crypto = require('crypto');

/**
 * S3-compatible object storage — presigned URLs, no SDK.
 *
 * Two decisions worth stating.
 *
 * **The API never carries the bytes.** It mints a presigned PUT and the worker
 * uploads straight to storage. Proxying a 100 MB reel through Express would tie
 * up a Node process for the whole transfer, and at any real concurrency the API
 * becomes a file pipe with an application attached. Presigning also means the
 * Mac worker never holds a storage credential — the URL it gets is scoped to one
 * key, one method and a few minutes.
 *
 * **SigV4 by hand rather than a dependency.** The backend currently has no AWS
 * SDK and the signing algorithm is about sixty lines. Adding ~20 MB of
 * transitive dependencies to sign a URL is a poor trade, and it works unchanged
 * against Cloudflare R2, Backblaze B2 and MinIO — which matters when the plan is
 * to stay on Indian or cheap storage rather than AWS.
 *
 * Note for Instagram: Meta's servers FETCH the media from a public URL, so the
 * published object must be publicly readable at a stable https address. That is
 * why `publicUrl` exists separately from the presigned reader.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves ! ' ( ) * alone, and AWS
 * requires them escaped — a filename with an apostrophe would otherwise produce
 * a signature mismatch that is thoroughly unfun to debug.
 */
function uriEncode(str, encodeSlash = true) {
  return String(str).split('').map((ch) => {
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
    if (ch === '/') return encodeSlash ? '%2F' : '/';
    return Array.from(Buffer.from(ch, 'utf8'))
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('');
  }).join('');
}

function amzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long: iso, short: iso.slice(0, 8) };
}

function signingKey(secretKey, dateStamp, region, service) {
  const kDate    = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

class Storage {
  constructor({
    endpoint     = process.env.S3_ENDPOINT,
    region       = process.env.S3_REGION || 'auto',
    bucket       = process.env.S3_BUCKET,
    accessKeyId  = process.env.S3_ACCESS_KEY_ID,
    secretKey    = process.env.S3_SECRET_ACCESS_KEY,
    publicBase   = process.env.S3_PUBLIC_BASE,
    forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  } = {}) {
    this.endpoint = (endpoint || '').replace(/\/+$/, '');
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretKey = secretKey;
    this.publicBase = (publicBase || '').replace(/\/+$/, '');
    this.forcePathStyle = forcePathStyle;
  }

  get configured() {
    return Boolean(this.endpoint && this.bucket && this.accessKeyId && this.secretKey);
  }

  assertConfigured() {
    if (!this.configured) {
      // Fail loudly at the seam. Silently writing to a local directory in
      // production because an env var was missing is the kind of thing nobody
      // notices until Meta cannot fetch the media.
      throw new Error('Object storage is not configured — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    }
  }

  _host() {
    const url = new URL(this.endpoint);
    return this.forcePathStyle ? url.host : `${this.bucket}.${url.host}`;
  }

  /**
   * Encode each path segment EXACTLY ONCE, keeping `/` as a separator.
   *
   * Encoding the whole key and then encoding the segments double-escapes: an
   * apostrophe becomes %27 and then %2527, which both corrupts the object path
   * and breaks the signature. Caught by the escaping test below, and it would
   * only have shown up on the first filename containing punctuation.
   */
  _canonicalUri(key) {
    const encoded = String(key).split('/').map((segment) => uriEncode(segment)).join('/');
    return this.forcePathStyle ? `/${uriEncode(this.bucket)}/${encoded}` : `/${encoded}`;
  }

  /**
   * A presigned URL valid for `expiresIn` seconds.
   *
   * @param {'PUT'|'GET'|'DELETE'} method
   */
  presign(method, key, { expiresIn = 900, now = new Date(), contentType = null } = {}) {
    this.assertConfigured();
    if (!key || key.startsWith('/')) throw new Error('key must be a non-empty relative path');
    if (expiresIn < 1 || expiresIn > 604800) throw new RangeError('expiresIn must be 1..604800 seconds');

    const { long, short } = amzDate(now);
    const scope = `${short}/${this.region}/s3/aws4_request`;
    const host  = this._host();

    // Content-Type is signed when given, so a worker cannot upload a script
    // under a URL that was issued for an image.
    const signedHeaders = contentType ? 'content-type;host' : 'host';
    const canonicalHeaders = contentType
      ? `content-type:${contentType}\nhost:${host}\n`
      : `host:${host}\n`;

    const query = {
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join('&');

    const canonicalRequest = [
      method,
      this._canonicalUri(key),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [ALGORITHM, long, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = crypto
      .createHmac('sha256', signingKey(this.secretKey, short, this.region, 's3'))
      .update(stringToSign)
      .digest('hex');

    const url = new URL(this.endpoint);
    return `${url.protocol}//${host}${this._canonicalUri(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /**
   * Hand a worker somewhere to upload one asset.
   *
   * Short-lived on purpose: a render takes minutes, so fifteen is generous, and
   * a URL that leaks is useless within the hour.
   */
  uploadTarget({ tenantId, avatarSlug, projectId, kind, filename, contentType, expiresIn = 900 }) {
    const key = this.keyFor({ tenantId, avatarSlug, projectId, kind, filename });
    return {
      key,
      method: 'PUT',
      url: this.presign('PUT', key, { expiresIn, contentType }),
      headers: contentType ? { 'Content-Type': contentType } : {},
      expires_in: expiresIn,
      public_url: this.publicUrl(key),
    };
  }

  /**
   * Key layout: tenant first.
   *
   * Every object is attributable to a tenant from its path alone, which is what
   * makes a per-tenant lifecycle rule, a bulk delete on account closure, or an
   * audit answerable without touching the database.
   */
  keyFor({ tenantId, avatarSlug = 'unknown', projectId = 'misc', kind = 'asset', filename }) {
    const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return `t${tenantId}/${avatarSlug}/${projectId}/${kind}/${Date.now()}-${safe}`;
  }

  /**
   * The stable public address.
   *
   * Instagram's Content Publishing API fetches media from a URL rather than
   * accepting an upload, so anything destined for publication must be readable
   * here without a signature.
   */
  publicUrl(key) {
    if (this.publicBase) return `${this.publicBase}/${key}`;
    const url = new URL(this.endpoint);
    return `${url.protocol}//${this._host()}${this._canonicalUri(key)}`;
  }

  /** For private assets — seed images, consent videos — that must not be public. */
  readUrl(key, { expiresIn = 3600 } = {}) {
    return this.presign('GET', key, { expiresIn });
  }
}

module.exports = { Storage, uriEncode, sha256hex };
