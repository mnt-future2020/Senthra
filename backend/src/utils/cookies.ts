import type { CookieOptions, Response } from "express";

import { env, isProduction } from "../config/env.js";

export const ACCESS_COOKIE = "senthra_access";
export const REFRESH_COOKIE = "senthra_refresh";

// The refresh cookie is scoped to the refresh endpoint only, so it is never sent
// on normal API calls (limits its exposure).
const REFRESH_PATH = "/auth/refresh";

const ACCESS_MAX_AGE = 60 * 60 * 1000; // 1h (slightly longer than the token, harmless)
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7d

function baseOptions(): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: isProduction,
    // In production the SPA and API are served from different sites (separate
    // *.vercel.app hosts), so the browser only stores/sends the auth cookies on
    // those cross-site requests when SameSite=None. None REQUIRES Secure, which
    // we already enable in production (HTTPS). Locally we keep Lax over plain
    // HTTP, where None+Secure would be dropped.
    sameSite: isProduction ? "none" : "lax",
  };
  if (env.COOKIE_DOMAIN) opts.domain = env.COOKIE_DOMAIN;
  return opts;
}

// Set both auth cookies. `remember = false` makes the refresh cookie a session
// cookie (cleared when the browser closes).
export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  remember = true,
): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    path: "/",
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    path: REFRESH_PATH,
    ...(remember ? { maxAge: REFRESH_MAX_AGE } : {}),
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: REFRESH_PATH });
}
