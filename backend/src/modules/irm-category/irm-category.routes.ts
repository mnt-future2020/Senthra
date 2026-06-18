import { Router } from "express";

import * as irmCategoryController from "./irm-category.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createIrmCategorySchema,
  updateIrmCategorySchema,
} from "./irm-category.validation.js";

const router = Router();

router.use(requireAuth);

// Read by category-managers AND by the IRM item form's category picker.
router.get(
  "/",
  requireAnyPermission("irm_categories.view", "irm.create", "irm.edit"),
  irmCategoryController.listIrmCategories,
);
router.get(
  "/:id",
  requireAnyPermission("irm_categories.view", "irm_categories.edit"),
  irmCategoryController.getIrmCategory,
);

router.post(
  "/",
  // Inline-create is allowed for IRM item creators/editors too (no Settings round-trip),
  // mirroring how the category list is already readable by them. Rename/delete stay restricted.
  requireAnyPermission("irm_categories.create", "irm.create", "irm.edit"),
  writeLimiter,
  validateBody(createIrmCategorySchema),
  irmCategoryController.createIrmCategory,
);
router.put(
  "/:id",
  requirePermission("irm_categories.edit"),
  writeLimiter,
  validateBody(updateIrmCategorySchema),
  irmCategoryController.updateIrmCategory,
);
router.delete(
  "/:id",
  requirePermission("irm_categories.delete"),
  writeLimiter,
  irmCategoryController.deleteIrmCategory,
);

export default router;
