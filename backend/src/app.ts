import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet, { type HelmetOptions } from "helmet";

import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.middleware.js";
import { EXPORT_CAPPED_HEADER } from "./utils/csv-response.js";
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
// TWO entries, and it stays two however many exports are added. Every module used to name its own
// capped header, so this list had to grow in lockstep with the export count — and the failure for a
// forgotten entry is exactly the silent one described above. utils/csv-response now sends ONE
// header for all of them, which is what makes this list finished rather than merely current.
const EXPOSED_HEADERS = [
  "Content-Disposition", // download filename, every CSV/PDF export
  EXPORT_CAPPED_HEADER, // "this file is not the whole answer" — every CSV export
];

app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  }),
);
// NO ROUTE NEEDS A WIDENED BODY ANY MORE.
//
// Three did, and all three took a file as base64 inside a JSON body: the job attachment, the
// goods-management damage photo, and the purchase-order attachment. Every one has been replaced by
// the signed direct upload, where the bytes go from the browser to Cloudinary and this server only
// ever sees a URL — so the global ceiling is now the only ceiling, and /auth/login is not sharing a
// 15 MB parser with anything.
//
// If a base64 upload schema is ever added back, `app.body-limit.test.ts` fails and says so; a
// route-level `express.json({ limit })` mounted BEFORE the global parser is how it gets widened
// again (whichever parser runs first owns the decision — body-parser marks the request and the
// second one steps aside).

// Everything else. Larger than default so base64 logo/favicon uploads fit in the JSON body.
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Application routes (health check + feature routers).
app.use(routes);

// 404 + centralized error handling (must be registered last).
app.use(notFound);
app.use(errorHandler);
