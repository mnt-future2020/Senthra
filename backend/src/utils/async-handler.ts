import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

// Wraps an async controller so any thrown/rejected error is forwarded to the
// centralized error middleware instead of crashing the process.
export const asyncHandler =
  (handler: AsyncRouteHandler): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
