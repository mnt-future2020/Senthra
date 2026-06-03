import { Router } from "express";

import * as authController from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
  forgotPasswordLimiter,
  loginLimiter,
  refreshLimiter,
  resetPasswordLimiter,
} from "../middleware/rateLimit.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import {
  changeCredentialsSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  resetPasswordSchema,
} from "../validations/auth.validation.js";

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
router.patch(
  "/credentials",
  requireAuth,
  validateBody(changeCredentialsSchema),
  authController.changeCredentials,
);
router.post("/logout", requireAuth, authController.logout);

export default router;
