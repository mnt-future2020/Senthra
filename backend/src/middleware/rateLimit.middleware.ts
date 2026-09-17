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

/**
 * The auth IP budgets, as data.
 *
 * Exported so the relationships BETWEEN them can be asserted rather than eyeballed — a verify
 * budget tighter than the login budget, for instance, lets an IP start more sign-ins than it can
 * finish, which reads as an outage to everyone behind one office NAT. Windows differ, so compare
 * them normalised (see rateLimit.twoFactor.test.ts), never by `limit` alone.
 */
export const AUTH_RATE_LIMITS = {
  login: { windowMs: 5 * 60 * 1000, limit: 10 },
  twoFactorVerify: { windowMs: 15 * 60 * 1000, limit: 30 },
  twoFactorResend: { windowMs: 15 * 60 * 1000, limit: 10 },
  twoFactorStatus: { windowMs: 15 * 60 * 1000, limit: 300 },
  twoFactorCancel: { windowMs: 15 * 60 * 1000, limit: 60 },
} as const;

// Brute-force protection on the auth-sensitive endpoints.
export const loginLimiter = makeLimiter({
  ...AUTH_RATE_LIMITS.login,
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

// --- Email 2FA ---
// The PER-CHALLENGE counters (MAX_ATTEMPTS = 5, MAX_RESENDS = 3) are the primary brute-force
// defence; these IP limiters are the secondary one, because an attacker can rotate addresses but
// cannot rotate the challenge row. They are sized for SHARED EGRESS — an office NAT or a mobile
// carrier puts many legitimate users behind one address.
//
// At least as permissive as loginLimiter (10 / 5 min = 30 / 15 min). A tighter budget here let an
// IP start more logins than it could finish, so a user behind shared NAT could be emailed a code
// and then blocked from ever submitting it — locked out by a limiter rather than by anything they
// did. Per-challenge attempts stay capped at 5 regardless.
export const twoFactorVerifyLimiter = makeLimiter({
  ...AUTH_RATE_LIMITS.twoFactorVerify,
  message: json("Too many attempts. Please try again later."),
});

// Above two users' full per-challenge allowance (3 each), so two colleagues on one office
// connection cannot exhaust the bucket for everyone behind it. Still well under what an abuser
// would need for mail-bombing, and the 60s per-challenge cooldown is untouched.
export const twoFactorResendLimiter = makeLimiter({
  ...AUTH_RATE_LIMITS.twoFactorResend,
  message: json("Too many code requests. Please wait a few minutes."),
});

// DELIBERATELY SEPARATE from twoFactorVerifyLimiter, and deliberately generous. The login page calls
// GET /auth/2fa/challenge on EVERY mount to decide which step to draw, so sharing a bucket with
// verify would let ordinary page refreshes exhaust the verification budget and lock a legitimate
// user out of their own OTP step. It is a cheap indexed read that returns no secret.
//
// Sized per BUILDING, not per person, because that mount happens on every visit by everyone behind
// the address — signed-in users bouncing off /login included, none of whom are doing 2FA at all. An
// earlier 60 was a single busy morning for one office: once spent, a user mid-verification who
// refreshed was dropped back to the credential form and had to start a second sign-in.
export const twoFactorStatusLimiter = makeLimiter({
  ...AUTH_RATE_LIMITS.twoFactorStatus,
  message: json("Too many requests. Please try again later."),
});

// "Back to sign in". Its own bucket rather than the status one: they are both cheap, but sharing
// meant the page's automatic on-mount probes could spend the budget for a DELIBERATE user action,
// and a refused cancel leaves the challenge alive — so the next visit to /login puts the user back
// on the OTP step they just tried to leave.
export const twoFactorCancelLimiter = makeLimiter({
  ...AUTH_RATE_LIMITS.twoFactorCancel,
  message: json("Too many requests. Please try again later."),
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
