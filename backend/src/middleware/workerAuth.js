'use strict';

const crypto = require('crypto');

/**
 * Worker authentication.
 *
 * A render worker is not a logged-in person, so it cannot carry a user JWT: it
 * runs unattended on a laptop or a rented GPU box and needs a credential that
 * survives restarts and belongs to no one's session. It authenticates with a
 * shared secret in `STUDIO_WORKER_TOKEN` and identifies itself with
 * `X-Worker-Id`, which is what lands in `render_jobs.claimed_by` and makes a
 * stranded lease traceable to the machine that stranded it.
 *
 * Deliberately narrow: these routes can claim work, heartbeat and report a
 * result. They cannot read a tenant's posts, touch billing, or act as a user.
 * A leaked worker token should cost you renders, not data.
 *
 * The comparison is constant-time. A plain `===` on a secret leaks its prefix
 * through response timing, which is a small hole but a free one to close.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so hash first to fix the length —
  // this compares in constant time regardless of how wrong the input is.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const WORKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

function workerAuth(req, res, next) {
  const expected = process.env.STUDIO_WORKER_TOKEN;

  // Fail closed. An unset secret must not mean "let everyone in" — that is how
  // a queue ends up open to the internet on the day someone forgets an env var.
  if (!expected) {
    return res.status(503).json({ error: 'Worker endpoints are not configured' });
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  if (!timingSafeEqual(header.slice(7), expected)) {
    return res.status(401).json({ error: 'Invalid worker token' });
  }

  const workerId = req.headers['x-worker-id'];
  if (!workerId || !WORKER_ID_RE.test(workerId)) {
    return res.status(400).json({
      error: 'X-Worker-Id header required — 2-64 chars of letters, digits, dot, dash or underscore',
    });
  }

  req.worker = { id: workerId };
  next();
}

module.exports = workerAuth;
