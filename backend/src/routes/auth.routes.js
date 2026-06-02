import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  login,
  me,
  changeCredentials,
  googleConfig,
  googleLogin,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.js";

// Brute-force protection on the auth-sensitive endpoints.
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many refresh attempts." },
});

// Password-reset endpoints: throttle to curb abuse / email spam.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

const router = Router();

router.post("/login", loginLimiter, login);
router.post("/google", loginLimiter, googleLogin);
router.get("/google/config", googleConfig);
router.post("/refresh", refreshLimiter, refresh);
router.post("/forgot-password", forgotLimiter, forgotPassword);
router.post("/reset-password", resetLimiter, resetPassword);
router.get("/me", requireAuth, me);
router.patch("/credentials", requireAuth, changeCredentials);
router.post("/logout", requireAuth, logout);

export default router;
