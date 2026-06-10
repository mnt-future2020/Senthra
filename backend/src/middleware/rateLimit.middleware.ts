import rateLimit from "express-rate-limit";

const json = (error: string) => ({ error });

// Brute-force protection on the auth-sensitive endpoints.
export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many attempts. Please try again in a few minutes."),
});

export const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many refresh attempts."),
});

// Password-reset endpoints: throttle to curb abuse / email spam.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many requests. Please try again later."),
});

export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many attempts. Please try again later."),
});

// Authenticated "change my own password" (POST /auth/password). A voluntary
// change re-verifies the current password with bcrypt, so an unbounded endpoint is
// an online-guess / CPU-exhaustion surface — cap it even though a session is required.
export const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many attempts. Please try again later."),
});

// Throttle the test-email endpoint so it can't be used to spam.
export const testEmailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many test emails. Please wait a few minutes."),
});

// General throttle for admin write operations (create/update/delete of users,
// roles, templates). Generous for normal admin use, but caps a runaway script
// or a compromised session. Read endpoints are intentionally not limited.
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many changes in a short time. Please slow down."),
});
