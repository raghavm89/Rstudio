const IdempotencyKey = require('../models/idempotencyKey');

// Honors an `Idempotency-Key` header on mutating endpoints. Must run AFTER
// authenticate() because we scope keys per user. Replays return the cached
// (status, body) instead of executing the handler again.
function idempotency() {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();
    if (!req.user) return next();
    if (key.length > 255) {
      return res.status(400).json({ error: 'Idempotency-Key too long (max 255 chars)' });
    }

    const scope = { key, userId: req.user.id, method: req.method, path: req.path };

    const cached = await IdempotencyKey.find(scope);
    if (cached) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(cached.status).json(cached.response);
    }

    // Capture (status, body) on the way out so a future retry sees the same
    // response. Don't cache 5xx — those mean the request didn't really complete.
    const origJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      if (res.statusCode < 500) {
        IdempotencyKey.save({ ...scope, status: res.statusCode, response: body })
          .catch((err) => console.error('Idempotency save failed:', err));
      }
      return origJson(body);
    };

    next();
  };
}

module.exports = idempotency;
