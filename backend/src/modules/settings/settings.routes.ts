import { Router } from "express";

import * as settingsController from "./settings.controller.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.middleware.js";
import { testEmailLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  testEmailSchema,
  updateSettingsSchema,
  uploadBrandingSchema,
} from "./settings.validation.js";

const router = Router();

// Public — branding for the login page / first paint (no auth).
router.get("/branding", settingsController.getBranding);

// Everything below is super-admin only.
router.use(requireAuth, requireAdmin);

router.get("/", settingsController.getSettings);
router.put("/", validateBody(updateSettingsSchema), settingsController.updateSettings);
router.post(
  "/email/test",
  testEmailLimiter,
  validateBody(testEmailSchema),
  settingsController.sendTestEmail,
);
router.post(
  "/branding/upload",
  validateBody(uploadBrandingSchema),
  settingsController.uploadBrandingImage,
);

export default router;
