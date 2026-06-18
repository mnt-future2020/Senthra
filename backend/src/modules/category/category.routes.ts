import { Router } from "express";

import * as categoryController from "./category.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createCategorySchema, updateCategorySchema } from "./category.validation.js";

const router = Router();

router.use(requireAuth);

// The category list is read by category-managers AND by the stock-entry form's
// category picker (which staff reach via customers.edit), so either may read it.
router.get("/", requireAnyPermission("categories.view", "customers.edit"), categoryController.listCategories);
router.get("/:id", requireAnyPermission("categories.view", "categories.edit"), categoryController.getCategory);

router.post("/", requirePermission("categories.create"), writeLimiter, validateBody(createCategorySchema), categoryController.createCategory);
router.put("/:id", requirePermission("categories.edit"), writeLimiter, validateBody(updateCategorySchema), categoryController.updateCategory);
router.delete("/:id", requirePermission("categories.delete"), writeLimiter, categoryController.deleteCategory);

export default router;
