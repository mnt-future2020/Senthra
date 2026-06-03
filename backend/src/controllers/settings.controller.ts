import * as settingsService from "../services/settings.service.js";
import { asyncHandler } from "../utils/async-handler.js";
import type {
  TestEmailInput,
  UpdateSettingsInput,
} from "../validations/settings.validation.js";

// GET /settings  (protected)
export const getSettings = asyncHandler(async (_req, res) => {
  const settings = await settingsService.getSettings();
  res.json({ settings });
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
