'use strict';

/**
 * Upload one artifact to object storage.
 *
 * The worker asks the API for a presigned PUT, then uploads straight to storage.
 * The bytes never pass through Express — a 100 MB reel proxied through Node ties
 * up a process for the whole transfer, and at any real concurrency the API
 * becomes a file pipe with an application attached.
 *
 * The worker never holds a storage credential. It also never chooses a storage
 * key: it sends a filename and a content type, and the API derives the key from
 * the JOB's tenant, avatar and project. A worker that could nominate its own key
 * could write into another tenant's prefix, and the whole point of the
 * `t{tenant}/…` layout is that the path itself is the attribution.
 */

class UploadError extends Error {
  constructor(message, { permanent = false, cause = null } = {}) {
    super(message);
    this.name = 'UploadError';
    this.permanent = permanent;
    this.cause = cause;
  }
}

/**
 * @param {object}   deps
 * @param {Function} deps.requestTarget  (jobId, {filename, contentType, kind}) → presigned target
 * @param {Function} deps.fetchImpl
 */
function createUploader({ requestTarget, fetchImpl = globalThis.fetch }) {
  /**
   * Upload one artifact and return what belongs on the job result.
   *
   * `artifact.fetch()` is lazy so a provider that returns URLs (fal) and one that
   * returns local files (ComfyUI) present identically here, and nothing is held
   * in memory before we know we have somewhere to put it.
   */
  async function upload(jobId, artifact, { kind = 'asset' } = {}) {
    const buffer = await artifact.fetch();
    if (!buffer || !buffer.length) {
      throw new UploadError(`${artifact.filename} downloaded as zero bytes`, { permanent: true });
    }

    const target = await requestTarget(jobId, {
      filename: artifact.filename,
      contentType: artifact.contentType,
      kind,
    });

    let res;
    try {
      res = await fetchImpl(target.url, {
        method: 'PUT',
        headers: { ...(target.headers || {}), 'Content-Length': String(buffer.length) },
        body: buffer,
      });
    } catch (err) {
      throw new UploadError(`Upload of ${artifact.filename} failed: ${err.message}`, { cause: err });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 403 here is usually an expired signature — the render outran the
      // fifteen-minute window. Worth retrying from the top with a fresh URL,
      // so it is transient. A 400 is a malformed request that will not improve.
      throw new UploadError(
        `Upload of ${artifact.filename} → ${res.status}: ${body.slice(0, 300)}`,
        { permanent: res.status === 400 }
      );
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

  /**
   * Uploads run in sequence, not in parallel.
   *
   * Four 2 MP PNGs is not worth the concurrency, and a home upstream link is the
   * bottleneck anyway — parallel uploads there make every one of them slower and
   * the failure harder to attribute.
   */
  async function uploadAll(jobId, artifacts, opts = {}) {
    const out = [];
    for (const artifact of artifacts) {
      out.push(await upload(jobId, artifact, opts));
    }
    return out;
  }

  return { upload, uploadAll };
}

module.exports = { createUploader, UploadError };
