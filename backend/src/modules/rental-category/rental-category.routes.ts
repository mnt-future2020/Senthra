import { Router } from "express";

import * as rentalCategoryController from "./rental-category.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createRentalCategorySchema,
  updateRentalCategorySchema,
} from "./rental-category.validation.js";

const router = Router();

router.use(requireAuth);

// Read by category-managers AND by the rental item form's category picker — a holder of
// rentals.create who lacked rental_categories.view would otherwise face an empty dropdown they
// cannot fill. It discloses nothing new: a category name is already visible on every rental item
// that holder can list. Mirrors the same admission on the IRM category list.
router.get(
  "/",
  requireAnyPermission("rental_categories.view", "rentals.view", "rentals.create", "rentals.edit"),
  rentalCategoryController.listRentalCategories,
);
router.get(
  "/:id",
  requireAnyPermission("rental_categories.view", "rental_categories.edit"),
  rentalCategoryController.getRentalCategory,
);

router.post(
  "/",
  // Inline-create for rental item creators/editors too, so adding a category does not mean a
  // Settings round-trip mid-form. Rename and delete stay restricted.
  requireAnyPermission("rental_categories.create", "rentals.create", "rentals.edit"),
  writeLimiter,
  validateBody(createRentalCategorySchema),
  rentalCategoryController.createRentalCategory,
);
router.put(
  "/:id",
  requirePermission("rental_categories.edit"),
  writeLimiter,
  validateBody(updateRentalCategorySchema),
  rentalCategoryController.updateRentalCategory,
);
router.delete(
  "/:id",
  requirePermission("rental_categories.delete"),
  writeLimiter,
  rentalCategoryController.deleteRentalCategory,
);

export default router;
