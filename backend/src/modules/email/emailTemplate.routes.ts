import { Router } from "express";

import * as templateController from "./emailTemplate.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
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

router.use(requireAuth);

router.get("/", templateController.listTemplates);
router.post("/", writeLimiter, validateBody(createTemplateSchema), templateController.createTemplate);
router.get("/:id", templateController.getTemplate);
router.put("/:id", writeLimiter, validateBody(updateTemplateSchema), templateController.updateTemplate);
router.patch(
  "/:id/enabled",
  writeLimiter,
  validateBody(setEnabledSchema),
  templateController.setEnabled,
);
router.post("/:id/duplicate", writeLimiter, templateController.duplicateTemplate);
router.post("/:id/restore", writeLimiter, templateController.restoreDefault);
router.post(
  "/:id/preview",
  validateBody(previewTemplateSchema),
  templateController.previewTemplate,
);
router.post(
  "/:id/test",
  testEmailLimiter,
  validateBody(testTemplateSchema),
  templateController.sendTest,
);
router.delete("/:id", writeLimiter, templateController.deleteTemplate);

export default router;
