import * as templateService from "../services/emailTemplate.service.js";
import { actorFrom } from "../utils/actor.js";
import { asyncHandler } from "../utils/async-handler.js";
import { param } from "../utils/request.js";
import type {
  CreateTemplateInput,
  PreviewTemplateInput,
  SetEnabledInput,
  TestTemplateInput,
  UpdateTemplateInput,
} from "../validations/emailTemplate.validation.js";

// GET /email-templates  (protected)
export const listTemplates = asyncHandler(async (_req, res) => {
  res.json({ templates: await templateService.listTemplates() });
});

// GET /email-templates/:id  (protected)
export const getTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.getTemplate(param(req, "id")) });
});

// POST /email-templates  (protected) — create a custom template.
export const createTemplate = asyncHandler(async (req, res) => {
  const template = await templateService.createTemplate(
    req.body as CreateTemplateInput,
    actorFrom(req),
  );
  res.status(201).json({ template });
});

// PUT /email-templates/:id  (protected) — bumps version.
export const updateTemplate = asyncHandler(async (req, res) => {
  const template = await templateService.updateTemplate(
    param(req, "id"),
    req.body as UpdateTemplateInput,
    actorFrom(req),
  );
  res.json({ template });
});

// PATCH /email-templates/:id/enabled  (protected)
export const setEnabled = asyncHandler(async (req, res) => {
  const { enabled } = req.body as SetEnabledInput;
  const template = await templateService.setEnabled(param(req, "id"), enabled, actorFrom(req));
  res.json({ template });
});

// POST /email-templates/:id/duplicate  (protected)
export const duplicateTemplate = asyncHandler(async (req, res) => {
  const template = await templateService.duplicateTemplate(param(req, "id"), actorFrom(req));
  res.status(201).json({ template });
});

// POST /email-templates/:id/restore  (protected) — restore built-in default.
export const restoreDefault = asyncHandler(async (req, res) => {
  const template = await templateService.restoreDefault(param(req, "id"), actorFrom(req));
  res.json({ template });
});

// POST /email-templates/:id/preview  (protected) — render with sample variables.
export const previewTemplate = asyncHandler(async (req, res) => {
  const preview = await templateService.previewTemplate(
    param(req, "id"),
    req.body as PreviewTemplateInput,
  );
  res.json({ preview });
});

// POST /email-templates/:id/test  (protected, rate-limited) — send a test email.
export const sendTest = asyncHandler(async (req, res) => {
  const { to } = req.body as TestTemplateInput;
  const result = await templateService.sendTestTemplate(param(req, "id"), to);
  res.json({ ok: true, ...result });
});

// DELETE /email-templates/:id  (protected) — custom templates only.
export const deleteTemplate = asyncHandler(async (req, res) => {
  await templateService.deleteTemplate(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
