import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  getSettings,
  updateSettings,
  sendTestEmail,
} from "../controllers/settings.controller.js";
import { requireAuth } from "../middleware/auth.js";

// Throttle the test-email endpoint so it can't be used to spam.
const testEmailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many test emails. Please wait a few minutes." },
});

const router = Router();

router.get("/", requireAuth, getSettings);
router.put("/", requireAuth, updateSettings);
router.post("/email/test", requireAuth, testEmailLimiter, sendTestEmail);

export default router;
