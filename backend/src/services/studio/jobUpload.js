'use strict';

const pool = require('../../config/db');
const { createStorage } = require('./storageFactory');
const { JobResultError } = require('./jobResult');
const { KIND_BY_STAGE, kindForStage } = require('./stageKinds');

/**
 * Where one job's output is allowed to be written.
 *
 * A worker supplies a filename and a content type. It does NOT supply a key —
 * the key is derived from the JOB's tenant, avatar and project. A worker that
 * could nominate its own key could write into another tenant's prefix, and the
 * whole point of the `t{tenant}/…` layout is that the path itself is the
 * attribution.
 *
 * That reasoning does not stop applying when the render happens in this
 * process, so the in-process runner derives its key through exactly this
 * function rather than composing one of its own.
 */

/** Anything not on this list is not accepted, whoever is offering it. */
const UPLOADABLE = new Set([
  'image/png', 'image/jpeg', 'image/webp',
  'video/mp4', 'video/quicktime',
  'audio/mpeg', 'audio/wav',
  'application/octet-stream',   // trained LoRA .safetensors
]);

const KINDS = new Set(['still', 'clip', 'reel', 'voice', 'lora', 'asset']);


/**
 * @param {object} job  a claimed render_jobs row
 * @returns {Promise<object>} { key, method, url, headers, public_url, expires_at }
 */
async function targetFor(job, { filename, contentType = 'application/octet-stream', kind = 'asset' } = {}) {
  if (!filename || typeof filename !== 'string') {
    throw new JobResultError('filename is required', { status: 400 });
  }
  if (!UPLOADABLE.has(contentType)) {
    throw new JobResultError(`contentType must be one of ${[...UPLOADABLE].join(', ')}`, { status: 400 });
  }
  if (!KINDS.has(kind)) {
    throw new JobResultError(`kind must be one of ${[...KINDS].join(', ')}`, { status: 400 });
  }

  const { rows } = await pool.query(
    `SELECT a.slug FROM avatars a
      WHERE a.id = $1 AND a.tenant_id = $2`,
    [job.payload?.avatar_id || null, job.tenant_id]
  );

  const storage = createStorage();
  if (!storage.configured) {
    // Fail loudly rather than letting a render fall back to writing files
    // somewhere nobody will ever fetch from.
    throw new JobResultError('Object storage is not configured', {
      code: 'STORAGE_UNCONFIGURED', status: 503,
    });
  }

  return storage.uploadTarget({
    tenantId: job.tenant_id,
    avatarSlug: rows[0]?.slug || 'unknown',
    projectId: job.project_id || 'misc',
    kind,
    filename,
    contentType,
  });
}

/**
 * Store one artifact for a job running in THIS process.
 *
 * The remote path asks for a target and then PUTs to it, which is right when
 * the uploader is on a laptop: the bytes go straight to the bucket and the
 * worker never holds a storage credential. In here we already hold it, so a
 * loopback PUT through our own Express process would be a round trip whose only
 * achievement is turning the API into a file pipe — the exact thing the
 * presigned design exists to avoid.
 *
 * So local disk is written directly (through the same signature check the HTTP
 * endpoint performs, so there is one gate rather than two), and S3 still goes
 * over the presigned PUT, straight to the bucket.
 *
 * Returns the same shape as worker/uploader.js, because both end up in the same
 * `result.assets` array and one of them being different is how a storage key
 * ends up null in the candidate pool.
 */
async function store(job, artifact, { kind = 'asset', fetchImpl = globalThis.fetch } = {}) {
  const buffer = await artifact.fetch();
  if (!buffer || !buffer.length) {
    const err = new JobResultError(`${artifact.filename} downloaded as zero bytes`, { status: 502 });
    err.permanent = true;
    throw err;
  }

  const target = await targetFor(job, {
    filename: artifact.filename,
    contentType: artifact.contentType,
    kind,
  });

  const storage = createStorage();
  if (typeof storage.put === 'function') {
    // The token lives in the URL's query, which is where the HTTP route reads
    // it from too. Redeeming it rather than writing behind it means the key,
    // the content type and the expiry are checked by the same `verify()` on
    // both paths — an in-process render cannot write somewhere an uploaded one
    // could not.
    const q = new URLSearchParams(target.url.slice(target.url.indexOf('?') + 1));
    storage.put(target.key, {
      contentType: q.get('ct'),
      expiresAt: q.get('exp'),
      signature: q.get('sig'),
      body: buffer,
    });
  } else {
    const res = await fetchImpl(target.url, {
      method: 'PUT',
      headers: { ...(target.headers || {}), 'Content-Length': String(buffer.length) },
      body: buffer,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new JobResultError(
        `Upload of ${artifact.filename} → ${res.status}: ${body.slice(0, 300)}`, { status: 502 });
      // 400 is a malformed request that will not improve. A 403 is usually an
      // expired signature — worth retrying from the top with a fresh URL.
      err.permanent = res.status === 400;
      throw err;
    }
  }

  return {
    filename: artifact.filename,
    key: target.key,
    url: target.public_url,
    bytes: buffer.length,
    content_type: artifact.contentType,
    ...(artifact.width ? { width: artifact.width, height: artifact.height } : {}),
  };
}

module.exports = { targetFor, store, UPLOADABLE, KINDS, KIND_BY_STAGE, kindForStage };
