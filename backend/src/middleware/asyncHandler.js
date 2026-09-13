// Wraps an async route handler so thrown errors / rejected promises
// are forwarded to Express's error-handling middleware.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncHandler;
