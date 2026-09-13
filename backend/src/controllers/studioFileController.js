'use strict';

const fs = require('fs');
const { createStorage, storageDriver } = require('../services/studio/storageFactory');

/**
 * The two routes that make local-disk storage behave like a bucket.
 *
 * Both are UNAUTHENTICATED in the session sense, and that is correct rather than
 * an oversight:
 *
 *   • `upload` is authorised by the HMAC in its own query string — the same
 *     model as an S3 presigned PUT. The worker holds no credential; it holds a
 *     grant for one key, one content type, and fifteen minutes.
 *   • `serve` is public because published media has to be. Instagram fetches
 *     media from a URL rather than accepting an upload, so anything destined for
 *     a post must be readable without a signature.
 *
 * They are registered before `authenticate` in routes/studio.js for that reason,
 * and neither one touches the database or a tenant record.
 */

// PUT /api/studio/files/upload?key=…&ct=…&exp=…&sig=…
exports.upload = async (req, res) => {
  if (storageDriver() !== 'local') {
    return res.status(404).json({ error: 'Not found' });
  }

  const { key, ct, exp, sig } = req.query;
  const storage = createStorage();

  const chunks = [];
  let size = 0;
  const limit = Number(process.env.STUDIO_UPLOAD_MAX_BYTES || 200 * 1024 * 1024);

  try {
    for await (const chunk of req) {
      size += chunk.length;
      // Enforced while streaming, not after. Buffering an unbounded body first
      // and checking the size afterwards is how a single request fills the disk.
      if (size > limit) {
        return res.status(413).json({ error: `Upload exceeds ${limit} bytes` });
      }
      chunks.push(chunk);
    }

    const out = storage.put(key, {
      contentType: ct,
      expiresAt: exp,
      signature: sig,
      body: Buffer.concat(chunks),
    });
    return res.status(200).json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

// GET /api/studio/files/*  — public read
exports.serve = async (req, res) => {
  if (storageDriver() !== 'local') {
    return res.status(404).json({ error: 'Not found' });
  }

  const key = req.params[0];
  const storage = createStorage();

  try {
    const { path: full, contentType, bytes } = storage.get(key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', bytes);
    // These objects are immutable — the key carries a timestamp, so a changed
    // file is a new key.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The bucket equivalent of this folder holds attacker-influenceable
    // filenames on our own origin; stop the browser second-guessing the type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    return fs.createReadStream(full).pipe(res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};
