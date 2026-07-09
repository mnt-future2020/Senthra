import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";

import { isProduction } from "../config/env.js";

const json = (error: string) => ({ error });

// Resilient client key. In production the app runs behind a reverse proxy (Vercel) with
// `trust proxy` set, so `req.ip` is always the real client IP. But on a DIRECT local-dev
// connection (localhost, no proxy, no X-Forwarded-For) `req.ip` can come back `undefined` — and
// express-rate-limit v8 THROWS `ERR_ERL_UNDEFINED_IP_ADDRESS` from its default keyGenerator,
// which surfaces as a hung request that only ends when the client times out (~20s). Falling back
// to a fixed key when the IP is missing keeps every write endpoint responsive in dev.
// `ipKeyGenerator` is the library's own helper for correct IPv6-subnet keying.
//
// SECURITY: the fallback collapses every ip-less request into ONE shared bucket, so in production
// it would turn the brute-force limiters into a single global counter (an attacker could exhaust
// it to lock everyone out, or normal aggregate traffic would trip it). That should never happen —
// `req.ip` is always set behind the proxy — so if it DOES fire in production it means `trust proxy`
// is misconfigured or a proxy hop stripped X-Forwarded-For. Warn LOUDLY (once) in that case instead
// of degrading security silently, so the misconfig is caught in logs.
let warnedUndefinedIp = false;
function clientKey(req: { ip?: string }): string {
  if (req.ip) return ipKeyGenerator(req.ip);
  if (isProduction && !warnedUndefinedIp) {
    warnedUndefinedIp = true;
    console.error(
      "[rateLimit] req.ip is undefined in PRODUCTION — all clients now share ONE rate-limit bucket. " +
        "Check `trust proxy` and that the proxy forwards X-Forwarded-For. Brute-force protection is degraded until fixed.",
    );
  }
  return "ip-less";
}

// Every limiter shares the resilient key + JSON error shape; each passes its own window/limit/message.
const makeLimiter = (opts: Pick<Options, "windowMs" | "limit" | "message">) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    ...opts,
  });

// Brute-force protection on the auth-sensitive endpoints.
export const loginLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  message: json("Too many attempts. Please try again in a few minutes."),
});

export const refreshLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  message: json("Too many refresh attempts."),
});

// Password-reset endpoints: throttle to curb abuse / email spam.
export const forgotPasswordLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: json("Too many requests. Please try again later."),
});

export const resetPasswordLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: json("Too many attempts. Please try again later."),
});

// Authenticated "change my own password" (POST /auth/password). A voluntary
// change re-verifies the current password with bcrypt, so an unbounded endpoint is
// an online-guess / CPU-exhaustion surface — cap it even though a session is required.
export const passwordChangeLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  message: json("Too many attempts. Please try again later."),
});

// Throttle the test-email endpoint so it can't be used to spam.
export const testEmailLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: json("Too many test emails. Please wait a few minutes."),
});

// General throttle for admin write operations (create/update/delete of users,
// roles, templates). Generous for normal admin use, but caps a runaway script
// or a compromised session. Read endpoints are intentionally not limited.
export const writeLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: json("Too many changes in a short time. Please slow down."),
});

// Bulk site import: the client sends sites in sequential batches (≤500 each). A handful
// of batches per import is normal; this caps a runaway loop / abusive client.
export const bulkWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: json("Too many import batches in a short time. Please slow down."),
});

// CSV export does heavier work than a normal read (scans up to the export cap),
// so throttle it even though a session is required.
export const exportLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  message: json("Too many exports. Please wait a few minutes."),
});
