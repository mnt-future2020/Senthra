import { Router } from "express";

import * as settingsController from "../controllers/settings.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { testEmailLimiter } from "../middleware/rateLimit.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import {
  testEmailSchema,
  updateSettingsSchema,
} from "../validations/settings.validation.js";

const router = Router();

router.get("/", requireAuth, settingsController.getSettings);
router.put("/", requireAuth, validateBody(updateSettingsSchema), settingsController.updateSettings);
router.post(
  "/email/test",
  requireAuth,
  testEmailLimiter,
  validateBody(testEmailSchema),
  settingsController.sendTestEmail,
);

export default router;
