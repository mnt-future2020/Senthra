import type { RequestHandler } from "express";
import type { ZodType } from "zod";

import { badRequest } from "../utils/http-error.js";

// Validates (and normalizes — trims, lowercases, etc.) req.body against a zod
// schema. On success the parsed value replaces req.body; on failure it forwards
// a 400 carrying the first issue's message to the centralized error handler.
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      next(badRequest(issue?.message ?? "Invalid request body."));
      return;
    }
    req.body = result.data;
    next();
  };
}
