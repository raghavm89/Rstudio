// Parses ?limit=&offset= and attaches { limit, offset } to req.pagination.
// Use as: router.get('/x', paginate(), handler)
function paginate({ defaultLimit = 20, maxLimit = 100 } = {}) {
  return (req, res, next) => {
    const rawLimit  = req.query.limit;
    const rawOffset = req.query.offset;

    let limit = defaultLimit;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > maxLimit) {
        return res.status(400).json({ error: `limit must be an integer between 1 and ${maxLimit}` });
      }
      limit = n;
    }

    let offset = 0;
    if (rawOffset !== undefined) {
      const n = Number(rawOffset);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      offset = n;
    }

    req.pagination = { limit, offset };
    next();
  };
}

// Helper for controllers — wraps rows + total in a consistent envelope.
function paginated(data, total, { limit, offset }) {
  return { data, pagination: { limit, offset, total } };
}

module.exports = { paginate, paginated };
