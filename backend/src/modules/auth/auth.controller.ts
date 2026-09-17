import type { Request } from "express";

import * as authService from "./auth.service.js";
import type { AuthMeta } from "./auth.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import {
  clearAuthCookies,
  clearTwoFactorCookie,
  REFRESH_COOKIE,
  setAuthCookies,
  setTwoFactorCookie,
  TWO_FACTOR_COOKIE,
} from "../../utils/cookies.js";
import { forbidden, HttpError, unauthorized } from "../../utils/http-error.js";
import type {
  ChangeCredentialsInput,
  ChangePasswordInput,
  ForgotPasswordInput,
  GoogleLoginInput,
  LoginInput,
  ResetPasswordInput,
  TwoFactorVerifyInput,
} from "./auth.validation.js";

// IP + user-agent snapshot recorded with a login (audit trail).
function authMeta(req: Request): AuthMeta {
  return { ip: req.ip, userAgent: req.get("user-agent") ?? undefined };
}

// POST /auth/login — unified: super-admin account, active staff user, or customer portal user.
// With 2FA on this answers 202 and sets ONLY the challenge cookie: no session exists yet, so the
// account's existing device is untouched until the emailed code is proven.
export const login = asyncHandler(async (req, res) => {
  const { email, password, remember } = req.body as LoginInput;
  const outcome = await authService.login(email, password, remember !== false, authMeta(req));

  if (outcome.twoFactorRequired) {
    setTwoFactorCookie(res, outcome.challengeToken);
    res.status(202).json(publicChallenge(outcome));
    return;
  }

  setAuthCookies(res, outcome.accessToken, outcome.refreshToken, remember !== false);
  res.json({ token: outcome.accessToken, principal: outcome.principal });
});

// The browser-safe view of a pending challenge: masked email, expiry and resend state. Never the
// code, the challenge token, the principal id or its type.
function publicChallenge(c: {
  email: string;
  expiresInSeconds: number;
  resendInSeconds: number;
  resendsRemaining: number;
}) {
  return {
    twoFactorRequired: true as const,
    email: c.email,
    // DURATIONS, not instants: the page counts them down against its own elapsed time, so a browser
    // whose clock is wrong still sees the cooldown and the expiry the server is actually enforcing.
    // Server-derived, so a page refresh resumes the REAL remainder instead of restarting a fresh 60s.
    expiresInSeconds: c.expiresInSeconds,
    resendInSeconds: c.resendInSeconds,
    resendsRemaining: c.resendsRemaining,
  };
}

// Raw challenge token from the httpOnly cookie. NEVER read from the body — a body-supplied token
// would let another origin drive someone else's pending challenge.
function challengeToken(req: Request): string {
  return (req.cookies?.[TWO_FACTOR_COOKIE] as string | undefined) ?? "";
}

// GET /auth/2fa/challenge — is a challenge pending for this browser?
// The login page calls this on mount; the cookie is httpOnly, so the page cannot look for itself.
// Does not count as an attempt and does not extend the expiry.
export const twoFactorChallenge = asyncHandler(async (req, res) => {
  const pending = await authService.readTwoFactorChallenge(challengeToken(req));
  if (!pending) {
    clearTwoFactorCookie(res);
    res.status(401).json({ error: "No pending verification." });
    return;
  }
  res.json(publicChallenge(pending));
});

// A 410 means the challenge no longer exists (burned by too many wrong codes, expired, used). Drop
// the stale cookie with it, so a refresh lands on the credential form instead of a dead OTP step.
// Same shape as the /auth/refresh handler below, which clears its cookies on failure for the same
// reason: the client must not keep presenting a credential the server has already thrown away.
function clearChallengeIfEnded(res: Parameters<typeof clearTwoFactorCookie>[0], err: unknown): void {
  if (err instanceof HttpError && err.status === 410) clearTwoFactorCookie(res);
}

// POST /auth/2fa/verify — the ONLY place a session is created when 2FA is on.
export const twoFactorVerify = asyncHandler(async (req, res) => {
  const { code } = req.body as TwoFactorVerifyInput;

  let result;
  try {
    result = await authService.completeTwoFactorLogin(challengeToken(req), code, authMeta(req));
  } catch (err) {
    clearChallengeIfEnded(res, err);
    throw err;
  }

  clearTwoFactorCookie(res);
  setAuthCookies(res, result.accessToken, result.refreshToken, result.remember);
  res.json({ token: result.accessToken, principal: result.principal });
});

// POST /auth/2fa/resend — a resend re-bases the challenge's expiry, so the cookie's lifetime is
// refreshed alongside it or the cookie could lapse while the challenge is still live.
export const twoFactorResend = asyncHandler(async (req, res) => {
  const token = challengeToken(req);

  let pending;
  try {
    pending = await authService.resendTwoFactorCode(token);
  } catch (err) {
    clearChallengeIfEnded(res, err);
    throw err;
  }

  setTwoFactorCookie(res, token);
  res.json(publicChallenge(pending));
});

// POST /auth/2fa/cancel — "Back to sign in". Deletes the challenge; touches NO session, because the
// caller has never been authenticated. Idempotent.
export const twoFactorCancel = asyncHandler(async (req, res) => {
  await authService.cancelTwoFactorChallenge(challengeToken(req));
  clearTwoFactorCookie(res);
  res.status(204).end();
});

// GET /auth/me  (protected) — the resolved principal (admin, staff user, or customer).
export const me = asyncHandler(async (req, res) => {
  res.json({ principal: req.principal });
});

// PATCH /auth/credentials  (admin only) — change the super-admin email/password.
export const changeCredentials = asyncHandler(async (req, res) => {
  const { principal, tokens } = await authService.changeCredentials(
    req.adminId!,
    req.body as ChangeCredentialsInput,
    req.sessionId ?? "",
  );
  // Re-issue a fresh session if the password changed (keeps the device signed in).
  if (tokens) setAuthCookies(res, tokens.accessToken, tokens.refreshToken, true);
  res.json({ principal });
});

// POST /auth/password  (protected, staff user OR customer) — change own password.
// Powers the first-login forced change and voluntary changes; re-issues the
// session. Dispatches EXPLICITLY on the principal type so a customer's password
// lives in the Customer collection and a staff user's in User. The super-admin
// changes its credentials via PATCH /auth/credentials, never here — an admin token
// is rejected rather than falling through to the user path (which would carry an
// undefined id into the user lookup).
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  const sid = req.sessionId ?? "";
  const type = req.principal?.type;

  let result;
  if (type === "customer") {
    // req.principal.id is the signed-in CustomerUser (the login identity), not the
    // company — that's whose password we change.
    result = await authService.changeCustomerPassword(req.principal!.id, currentPassword, newPassword, sid);
  } else if (type === "user") {
    result = await authService.changeUserPassword(req.userId!, currentPassword, newPassword, sid);
  } else {
    throw forbidden("Use account settings to change the administrator password.");
  }

  setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken, true);
  res.json({ principal: result.principal });
});

// POST /auth/refresh — rotate tokens using the refresh cookie (admin, staff user, or customer).
export const refresh = asyncHandler(async (req, res) => {
  const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? req.body?.refreshToken;
  if (!token) throw unauthorized("No refresh token.");

  let result;
  try {
    result = await authService.refreshSession(token);
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
  setAuthCookies(res, result.accessToken, result.refreshToken, true);
  res.json({ token: result.accessToken, principal: result.principal });
});

// POST /auth/logout  (protected) — sign out the current device + clear cookies.
export const logout = asyncHandler(async (req, res) => {
  if (req.principal) await authService.logout(req.principal, req.sessionId ?? "");
  clearAuthCookies(res);
  res.json({ ok: true });
});

// GET /auth/sessions  (protected) — the principal's active devices.
export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await authService.listSessions(req.principal!, req.sessionId ?? "");
  res.json({ sessions });
});

// POST /auth/sessions/revoke-others  (protected) — sign out all other devices.
export const revokeOtherSessions = asyncHandler(async (req, res) => {
  await authService.revokeOtherSessions(req.principal!, req.sessionId ?? "");
  res.json({ ok: true });
});

// POST /auth/forgot-password — email a reset link (admin or staff user).
// Always returns the same generic response to avoid email enumeration.
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body as ForgotPasswordInput;
  await authService.forgotPassword(email);
  res.json({
    message: "If that email is registered, a password reset link has been sent.",
  });
});

// POST /auth/reset-password — set a new password using the emailed token.
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body as ResetPasswordInput;
  await authService.resetPassword(token, newPassword);
  res.json({ message: "Password reset successfully. You can now sign in." });
});

// GET /auth/google/config — public. Whether Google sign-in is enabled + client id.
export const googleConfig = asyncHandler(async (_req, res) => {
  res.json(await authService.getGoogleConfig());
});

// POST /auth/google — verify the Google ID token, then the SAME branch the password login takes:
// with 2FA on this answers 202 with a challenge instead of a session, so Google is not a way around
// the second factor.
export const googleLogin = asyncHandler(async (req, res) => {
  const { credential, remember } = req.body as GoogleLoginInput;
  const outcome = await authService.googleLogin(credential, remember !== false, authMeta(req));

  if (outcome.twoFactorRequired) {
    setTwoFactorCookie(res, outcome.challengeToken);
    res.status(202).json(publicChallenge(outcome));
    return;
  }

  setAuthCookies(res, outcome.accessToken, outcome.refreshToken, remember !== false);
  res.json({ token: outcome.accessToken, principal: outcome.principal });
});
