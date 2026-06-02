// Reached when no route matched the request.
export function notFound(req, res, next) {
  res.status(404).json({ error: "Not Found" });
}

// Centralized error handler. Must be registered last (4 args = error middleware).
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  const message = status === 500 ? "Internal Server Error" : err.message;
  res.status(status).json({ error: message });
}
