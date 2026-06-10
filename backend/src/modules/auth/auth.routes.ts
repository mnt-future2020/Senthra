import { Router } from "express";

import * as authController from "./auth.controller.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.middleware.js";
import {
  forgotPasswordLimiter,
  loginLimiter,
  passwordChangeLimiter,
  refreshLimiter,
  resetPasswordLimiter,
} from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  changeCredentialsSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  resetPasswordSchema,
} from "./auth.validation.js";

const router = Router();

router.post("/login", loginLimiter, validateBody(loginSchema), authController.login);
router.post("/google", loginLimiter, validateBody(googleLoginSchema), authController.googleLogin);
router.get("/google/config", authController.googleConfig);
router.post("/refresh", refreshLimiter, authController.refresh);
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  validateBody(forgotPasswordSchema),
  authController.forgotPassword,
);
router.post(
  "/reset-password",
  resetPasswordLimiter,
  validateBody(resetPasswordSchema),
  authController.resetPassword,
);
router.get("/me", requireAuth, authController.me);
// Super-admin account email/password (Settings → Account).
router.patch(
  "/credentials",
  requireAuth,
  requireAdmin,
  validateBody(changeCredentialsSchema),
  authController.changeCredentials,
);
// Staff user or customer: change own password (first-login forced change +
// voluntary). Rate-limited — a voluntary change re-verifies via bcrypt.
router.post(
  "/password",
  requireAuth,
  passwordChangeLimiter,
  validateBody(changePasswordSchema),
  authController.changePassword,
);
router.post("/logout", requireAuth, authController.logout);

// Device sessions for the current principal.
router.get("/sessions", requireAuth, authController.listSessions);
router.post("/sessions/revoke-others", requireAuth, authController.revokeOtherSessions);

export default router;
