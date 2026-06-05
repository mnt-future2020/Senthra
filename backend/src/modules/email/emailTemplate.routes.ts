import { Router } from "express";

import * as templateController from "./emailTemplate.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { testEmailLimiter, writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createTemplateSchema,
  previewTemplateSchema,
  setEnabledSchema,
  testTemplateSchema,
  updateTemplateSchema,
} from "./emailTemplate.validation.js";

const router = Router();

// All template routes require auth; reading needs email_templates.view, mutating
// (and sending a test) needs email_templates.manage. The super-admin always passes.
router.use(requireAuth);

const canView = requirePermission("email_templates.view");
const canManage = requirePermission("email_templates.manage");

router.get("/", canView, templateController.listTemplates);
router.get("/:id", canView, templateController.getTemplate);
router.post("/:id/preview", canView, validateBody(previewTemplateSchema), templateController.previewTemplate);

router.post("/", canManage, writeLimiter, validateBody(createTemplateSchema), templateController.createTemplate);
router.put("/:id", canManage, writeLimiter, validateBody(updateTemplateSchema), templateController.updateTemplate);
router.patch(
  "/:id/enabled",
  canManage,
  writeLimiter,
  validateBody(setEnabledSchema),
  templateController.setEnabled,
);
router.post("/:id/duplicate", canManage, writeLimiter, templateController.duplicateTemplate);
router.post("/:id/restore", canManage, writeLimiter, templateController.restoreDefault);
router.post(
  "/:id/test",
  canManage,
  testEmailLimiter,
  validateBody(testTemplateSchema),
  templateController.sendTest,
);
router.delete("/:id", canManage, writeLimiter, templateController.deleteTemplate);

export default router;
