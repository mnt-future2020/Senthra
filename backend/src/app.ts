import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.middleware.js";
import routes from "./routes/index.js";

export const app = express();

// Security headers (HSTS, nosniff, frameguard, referrer-policy, hides
// x-powered-by, etc.). CORP is relaxed to cross-origin because the API is
// consumed by the separate-origin SPA — actual access is still governed by the
// CORS policy below.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

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
