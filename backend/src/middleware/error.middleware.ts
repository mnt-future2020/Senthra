import type { ErrorRequestHandler, Request, Response } from "express";

import { HttpError } from "../utils/http-error.js";

// Reached when no route matched the request.
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not Found" });
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : 500;
}

// Centralized error handler. Must be registered last (4 args = error middleware).
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = statusOf(err);
  // Never leak internal details for 500s; surface them server-side for diagnosis.
  if (status >= 500) console.error(err);
  const message =
    status >= 500
      ? "Internal Server Error"
      : err instanceof Error
        ? err.message
        : "Error";
  res.status(status).json({ error: message });
};
