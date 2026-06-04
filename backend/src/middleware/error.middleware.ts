import type { ErrorRequestHandler, Request, Response } from "express";
import { Prisma } from "@prisma/client";

import { HttpError } from "../utils/http-error.js";

// Reached when no route matched the request.
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not Found" });
}

// Map well-known Prisma error codes to client-facing HTTP statuses so a bad
// request (e.g. a malformed :id) doesn't surface as a 500. Returns null when the
// error isn't a recognised Prisma error.
function prismaStatus(err: unknown): { status: number; message: string } | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (err.code) {
    // Malformed ObjectID / inconsistent value, and record-not-found on a write —
    // both mean "no such resource" to the caller.
    case "P2023":
    case "P2025":
      return { status: 404, message: "Not Found" };
    // Unique constraint violation.
    case "P2002":
      return { status: 409, message: "That value is already in use." };
    default:
      return null;
  }
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : 500;
}

// Centralized error handler. Must be registered last (4 args = error middleware).
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const mapped = prismaStatus(err);
  const status = mapped?.status ?? statusOf(err);
  // Never leak internal details for 500s; surface them server-side for diagnosis.
  if (status >= 500) console.error(err);
  const message =
    status >= 500
      ? "Internal Server Error"
      : mapped
        ? mapped.message
        : err instanceof Error
          ? err.message
          : "Error";
  res.status(status).json({ error: message });
};
