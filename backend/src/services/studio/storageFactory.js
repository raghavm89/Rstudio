'use strict';

const { Storage } = require('./storage');
const { LocalStorage } = require('./localStorage');

/**
 * Which storage backend is in use.
 *
 * Chosen by configuration rather than by "is S3 configured", deliberately.
 * Falling back to local disk because an env var was missing is the kind of thing
 * nobody notices until Instagram cannot fetch the media — by which point a
 * month of posts are sitting on a laptop. So the choice is explicit, and a
 * misconfigured S3 setup fails loudly instead of quietly writing to disk.
 *
 *   STUDIO_STORAGE=local   → disk, no bucket needed (default)
 *   STUDIO_STORAGE=s3      → any S3-compatible endpoint
 */
function storageDriver() {
  return (process.env.STUDIO_STORAGE || 'local').toLowerCase();
}

function createStorage(overrides = {}) {
  const driver = storageDriver();
  if (driver === 's3') {
    const s3 = new Storage(overrides);
    s3.driver = 's3';
    return s3;
  }
  if (driver === 'local') return new LocalStorage(overrides);
  throw new Error(`Unknown STUDIO_STORAGE "${driver}" — expected local or s3`);
}

/**
 * Can a third party on the internet fetch what we store?
 *
 * Instagram's Content Publishing API fetches media from a URL, and fal must be
 * able to fetch a training zip. Local disk on a laptop can do neither, so the
 * publish path checks this rather than discovering it as a failed API call at
 * the last step of a flow that worked all the way up to it.
 */
function isPubliclyFetchable() {
  if (storageDriver() === 's3') return Boolean(process.env.S3_PUBLIC_BASE);
  const base = process.env.STUDIO_PUBLIC_BASE || '';
  return /^https?:\/\//.test(base) && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(:|$)/.test(base);
}

module.exports = { createStorage, storageDriver, isPubliclyFetchable };
