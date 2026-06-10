import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet, { type HelmetOptions } from "helmet";

import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.middleware.js";
import routes from "./routes/index.js";

// helmet 8 ships separate CJS and ESM type entrypoints. Under the NodeNext
// module resolution used by the Vercel production build, helmet's default
// export type resolves to the module namespace (which has no call signature)
// even though the runtime value is always the middleware factory — so a direct
// call fails `tsc` there (TS2349) while it passes locally. Assert the call
// signature so the type-check passes on every toolchain; runtime is unchanged.
const helmetMiddleware = helmet as unknown as (
  options?: Readonly<HelmetOptions>,
) => RequestHandler;

export const app = express();

// Behind Vercel's (and most hosts') reverse proxy: trust the first hop so
// `req.ip` and express-rate-limit read the real client IP from X-Forwarded-For
// instead of the proxy's loopback address. Without this, rate limiting keys
// every client to one proxy IP and session device IPs log as 127.0.0.1/::1.
app.set("trust proxy", 1);

// Security headers (HSTS, nosniff, frameguard, referrer-policy, hides
// x-powered-by, etc.). CORP is relaxed to cross-origin because the API is
// consumed by the separate-origin SPA — actual access is still governed by the
// CORS policy below.
app.use(helmetMiddleware({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }),
);
// Larger limit so base64 logo/favicon uploads fit in the JSON body.
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Application routes (health check + feature routers).
app.use(routes);

// 404 + centralized error handling (must be registered last).
app.use(notFound);
app.use(errorHandler);
