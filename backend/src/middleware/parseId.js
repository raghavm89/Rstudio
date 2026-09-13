// Parses a positive-integer route param. If invalid, responds 400 and
// short-circuits the chain. Use as: router.get('/:id', parseId('id'), handler)
function parseId(name = 'id') {
  return (req, res, next) => {
    const raw = req.params[name];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return res.status(400).json({ error: `Invalid ${name}` });
    }
    req.params[name] = n;
    next();
  };
}

module.exports = parseId;
