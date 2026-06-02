export const ACCESS_COOKIE = "senthra_access";
export const REFRESH_COOKIE = "senthra_refresh";

// The refresh cookie is scoped to the refresh endpoint only, so it is never sent
// on normal API calls (limits its exposure).
const REFRESH_PATH = "/auth/refresh";

const ACCESS_MAX_AGE = 60 * 60 * 1000; // 1h (slightly longer than the token, harmless)
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7d

function baseOptions() {
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };
  if (process.env.COOKIE_DOMAIN) opts.domain = process.env.COOKIE_DOMAIN;
  return opts;
}

// Set both auth cookies. `remember = false` makes the refresh cookie a session
// cookie (cleared when the browser closes).
export function setAuthCookies(res, accessToken, refreshToken, remember = true) {
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

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: REFRESH_PATH });
}
