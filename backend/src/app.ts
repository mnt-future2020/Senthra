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

// Response headers the browser is allowed to hand to the SPA. Anything outside the small CORS
// safelist is stripped from a cross-origin response before JS can read it, and this API is ALWAYS
// cross-origin from the dashboard (separate hosts in production, :3000 → :8000 in dev). Miss one
// here and the failure is silent: a CSV download loses its filename, and every "export was
// truncated" flag reads as false because the header carrying it never reaches the client — so the
// user is handed a partial file believing it is complete. Add to this list the moment a controller
// starts answering with a header the frontend needs to read.
const EXPOSED_HEADERS = [
  "Content-Disposition", // download filename, every CSV/PDF export
  "X-Export-Capped", // customer portal: own stock + own submissions CSV
  "X-Audit-Export-Capped",
  "X-Inventory-Export-Capped",
  "X-Movement-Export-Capped",
  "X-Inventory-Export-Count",
];

app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  }),
);
// --- body parsing -----------------------------------------------------------
//
// Base64 inflates a file by 4/3, so a 5mb JSON ceiling only admits a ~3.7 MB file. The four
// file-upload endpoints validate (and advertise to the user) 10 MB, 10 MB, 10 MB and 5 MB — needing
// up to ~13.4 MB of body — so every upload above ~3.7 MB was rejected by the parser with a raw
// "request entity too large" long before the schema that promised to allow it ever ran.
//
// EVERY endpoint whose schema accepts a `data:` URI larger than ~3.7 MB must be listed here. The
// image endpoints (branding logo/favicon, avatars, signatures, kit-request / van-stock /
// engineer-transfer evidence) cap the data URI itself at 3 MB, so they fit under the global limit
// and are deliberately absent. `body-limit` in __tests__/app.body-limit.test.ts fails if a route
// advertising more than the global ceiling is missing from this list — the list is easy to extend
// and was, on first writing, silently short by two.
//
// The larger ceiling is scoped to these paths rather than raised globally: the global limit is also
// the limit on /auth/login and every other unauthenticated route, and there is no reason for those
// to accept a 15 MB body. Mounted BEFORE the global parser because whichever parser runs first owns
// the decision — body-parser marks the request and the second one steps aside — so a route-level
// parser mounted after would never get the chance to widen anything.
export const UPLOAD_BODY_PATHS =
  /^\/(?:jobs\/attachment|goods-management\/damage-photo|(?:purchase-requests|purchase-orders|goods-in)\/[^/]+\/attachments)\/?$/;
const uploadJson = express.json({ limit: "15mb" });
app.use((req, res, next) => (UPLOAD_BODY_PATHS.test(req.path) ? uploadJson(req, res, next) : next()));

// Everything else. Larger than default so base64 logo/favicon uploads fit in the JSON body.
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Application routes (health check + feature routers).
app.use(routes);

// 404 + centralized error handling (must be registered last).
app.use(notFound);
app.use(errorHandler);
