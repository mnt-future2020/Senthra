import type { Request } from "express";

import * as authService from "./auth.service.js";
import type { AuthMeta } from "./auth.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../../utils/cookies.js";
import { forbidden, unauthorized } from "../../utils/http-error.js";
import type {
  ChangeCredentialsInput,
  ChangePasswordInput,
  ForgotPasswordInput,
  GoogleLoginInput,
  LoginInput,
  ResetPasswordInput,
} from "./auth.validation.js";

// IP + user-agent snapshot recorded with a login (audit trail).
function authMeta(req: Request): AuthMeta {
  return { ip: req.ip, userAgent: req.get("user-agent") ?? undefined };
}

// POST /auth/login — unified: super-admin account or an active staff user.
export const login = asyncHandler(async (req, res) => {
  const { email, password, remember } = req.body as LoginInput;
  const { principal, accessToken, refreshToken } = await authService.login(
    email,
    password,
    authMeta(req),
  );
  setAuthCookies(res, accessToken, refreshToken, remember !== false);
  res.json({ token: accessToken, principal });
});

// GET /auth/me  (protected) — the resolved principal (admin or user).
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
    result = await authService.changeCustomerPassword(req.customerId!, currentPassword, newPassword, sid);
  } else if (type === "user") {
    result = await authService.changeUserPassword(req.userId!, currentPassword, newPassword, sid);
  } else {
    throw forbidden("Use account settings to change the administrator password.");
  }

  setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken, true);
  res.json({ principal: result.principal });
});

// POST /auth/refresh — rotate tokens using the refresh cookie (admin or user).
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

// POST /auth/google — verify the Google ID token and start a session.
export const googleLogin = asyncHandler(async (req, res) => {
  const { credential, remember } = req.body as GoogleLoginInput;
  const { principal, accessToken, refreshToken } = await authService.googleLogin(
    credential,
    authMeta(req),
  );
  setAuthCookies(res, accessToken, refreshToken, remember !== false);
  res.json({ token: accessToken, principal });
});
