import * as settingsService from "./settings.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type {
  TestEmailInput,
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
  const settings = await settingsService.updateSettings(req.body as UpdateSettingsInput);
  res.json({ settings });
});

// POST /settings/email/test  (protected) — send a test email.
export const sendTestEmail = asyncHandler(async (req, res) => {
  const result = await settingsService.sendTestEmail(req.body as TestEmailInput);
  res.json({ ok: true, ...result });
});
