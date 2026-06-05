import { Router } from "express";

import * as settingsController from "./settings.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
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

// Everything below requires auth; reading needs settings.view, mutating needs
// settings.manage (the super-admin always passes both).
router.use(requireAuth);

router.get("/", requirePermission("settings.view"), settingsController.getSettings);
router.put("/", requirePermission("settings.manage"), validateBody(updateSettingsSchema), settingsController.updateSettings);
router.post(
  "/email/test",
  requirePermission("settings.manage"),
  testEmailLimiter,
  validateBody(testEmailSchema),
  settingsController.sendTestEmail,
);
router.post(
  "/branding/upload",
  requirePermission("settings.manage"),
  validateBody(uploadBrandingSchema),
  settingsController.uploadBrandingImage,
);

export default router;
