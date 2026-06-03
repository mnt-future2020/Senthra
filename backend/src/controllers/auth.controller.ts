import * as authService from "../services/auth.service.js";
import { asyncHandler } from "../utils/async-handler.js";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../utils/cookies.js";
import { unauthorized } from "../utils/http-error.js";
import type {
  ChangeCredentialsInput,
  ForgotPasswordInput,
  GoogleLoginInput,
  LoginInput,
  ResetPasswordInput,
} from "../validations/auth.validation.js";

// POST /auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, password, remember } = req.body as LoginInput;
  const { admin, accessToken, refreshToken } = await authService.login(email, password);
  setAuthCookies(res, accessToken, refreshToken, remember !== false);
  res.json({ token: accessToken, admin });
});

// GET /auth/me  (protected)
export const me = asyncHandler(async (req, res) => {
  const admin = await authService.getCurrentAdmin(req.adminId!);
  res.json({ admin });
});

// PATCH /auth/credentials  (protected) — change email and/or password.
export const changeCredentials = asyncHandler(async (req, res) => {
  const { admin, tokens } = await authService.changeCredentials(
    req.adminId!,
    req.body as ChangeCredentialsInput,
  );
  // Re-issue a fresh session if the password changed (keeps the device signed in).
  if (tokens) setAuthCookies(res, tokens.accessToken, tokens.refreshToken, true);
  res.json({ admin });
});

// POST /auth/refresh — rotate tokens using the refresh cookie.
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
  res.json({ token: result.accessToken, admin: result.admin });
});

// POST /auth/logout  (protected) — revoke sessions + clear cookies.
export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.adminId!);
  clearAuthCookies(res);
  res.json({ ok: true });
});

// POST /auth/forgot-password — email a reset link.
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
  const { admin, accessToken, refreshToken } = await authService.googleLogin(credential);
  setAuthCookies(res, accessToken, refreshToken, remember !== false);
  res.json({ token: accessToken, admin });
});
