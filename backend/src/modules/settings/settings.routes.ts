import { Router } from "express";

import * as settingsController from "./settings.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { storageProbeLimiter, testEmailLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  testEmailSchema,
  testStorageSchema,
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
// Same shape as the email test — a privileged, network-touching probe that should not be a way to
// hammer a third party from an authenticated session — in the storage probes' own bucket.
router.post(
  "/storage/test",
  requirePermission("settings.manage"),
  storageProbeLimiter,
  validateBody(testStorageSchema),
  settingsController.testStorage,
);
// Writes into the Cloudinary account (creates or repairs the upload presets), so it is gated and
// limited exactly like the probes above. No body: it prepares whatever credentials are in effect.
router.post(
  "/storage/cloudinary/presets",
  requirePermission("settings.manage"),
  storageProbeLimiter,
  settingsController.setupCloudinaryPresets,
);
router.post(
  "/branding/upload",
  requirePermission("settings.manage"),
  validateBody(uploadBrandingSchema),
  settingsController.uploadBrandingImage,
);

export default router;
