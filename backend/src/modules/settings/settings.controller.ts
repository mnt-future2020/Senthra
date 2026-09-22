import * as settingsService from "./settings.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type {
  TestEmailInput,
  TestStorageInput,
  UpdateSettingsInput,
  UploadBrandingInput,
} from "./settings.validation.js";

// GET /settings  (protected)
export const getSettings = asyncHandler(async (_req, res) => {
  const settings = await settingsService.getSettings();
  res.json({ settings });
});

// GET /settings/branding  (public) — brand name/logo/favicon/footer/tagline.
export const getBranding = asyncHandler(async (_req, res) => {
  const branding = await settingsService.getBranding();
  res.json({ branding });
});

// POST /settings/branding/upload  (protected) — upload logo/favicon to Cloudinary.
export const uploadBrandingImage = asyncHandler(async (req, res) => {
  const { type, image } = req.body as UploadBrandingInput;
  const result = await settingsService.uploadBrandingImage(type, image);
  res.json(result);
});

// PUT /settings  (protected)
export const updateSettings = asyncHandler(async (req, res) => {
  // The acting principal is passed through so a change to the sign-in policy is attributable.
  const settings = await settingsService.updateSettings(req.body as UpdateSettingsInput, {
    id: req.principal?.id,
    email: req.principal?.email,
    type: req.principal?.type,
  });
  res.json({ settings });
});

/**
 * POST /settings/storage/test  (protected) — prove a storage configuration works.
 *
 * Tests the SUBMITTED values, not the stored ones, so an administrator can verify new credentials
 * before committing to them. Returns `{ ok, message }` and nothing else: no configuration is echoed
 * back, and no SDK detail reaches the browser.
 */
export const testStorage = asyncHandler(async (req, res) => {
  const result = await settingsService.testStorageConnection(req.body as TestStorageInput);
  res.json(result);
});

// POST /settings/email/test  (protected) — send a test email.
export const sendTestEmail = asyncHandler(async (req, res) => {
  const result = await settingsService.sendTestEmail(req.body as TestEmailInput);
  res.json({ ok: true, ...result });
});
