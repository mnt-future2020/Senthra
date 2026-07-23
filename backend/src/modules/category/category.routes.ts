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

// Who may read the category master list: the people who MANAGE it, plus everyone whose form
// has to render the category picker. Category is a required field on a customer stock entry,
// so anyone who can write one must be able to read this list or they simply cannot save.
//
// Keep this in step with the write guards on the /stock-entries routes. It previously listed
// only the coarse `customers.edit`; when the customer RBAC split moved those routes onto
// granular keys (customer_stock.*, stock_requests.*), this guard was left behind. Roles
// holding the old coarse key kept working — CUSTOMER_COMPAT_BACKFILL is additive, so they
// never lost it — which hid the breakage. Any role granted only the granular keys (the normal
// way to set up a warehouse manager today) got a 403 here and an empty, unsaveable form.
// `customers.edit` stays in the list for exactly those legacy roles.
export const CATEGORY_LIST_READERS = [
  "categories.view",
  "customer_stock.create", // POST /customers/:id/stock-entries - direct create form
  "customer_stock.edit", // PUT /stock-entries/:id - edit form
  "stock_requests.complete", // warehouse receive, then fill in the entry's details
  "customers.edit", // legacy coarse key, pre-RBAC-split roles
];

router.get("/", requireAnyPermission(...CATEGORY_LIST_READERS), categoryController.listCategories);
router.get("/:id", requireAnyPermission("categories.view", "categories.edit"), categoryController.getCategory);

router.post("/", requirePermission("categories.create"), writeLimiter, validateBody(createCategorySchema), categoryController.createCategory);
router.put("/:id", requirePermission("categories.edit"), writeLimiter, validateBody(updateCategorySchema), categoryController.updateCategory);
router.delete("/:id", requirePermission("categories.delete"), writeLimiter, categoryController.deleteCategory);

export default router;
