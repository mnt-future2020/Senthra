import { Router } from "express";

import * as supplierTypeController from "./supplier-type.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createSupplierTypeSchema,
  updateSupplierTypeSchema,
} from "./supplier-type.validation.js";

const router = Router();

router.use(requireAuth);

// The type list is read by type-managers AND by the supplier form's type picker
// (which staff reach via suppliers.create / suppliers.edit), so either may read it —
// mirrors how the warehouse-type list allows warehouse.create / warehouse.edit.
router.get(
  "/",
  requireAnyPermission("supplier_types.view", "suppliers.create", "suppliers.edit"),
  supplierTypeController.listSupplierTypes,
);
router.get(
  "/:id",
  requireAnyPermission("supplier_types.view", "supplier_types.edit"),
  supplierTypeController.getSupplierType,
);

router.post(
  "/",
  // Inline-create is allowed for supplier creators/editors too (no Settings round-trip),
  // mirroring how the type list is already readable by them. Rename/delete stay restricted.
  requireAnyPermission("supplier_types.create", "suppliers.create", "suppliers.edit"),
  writeLimiter,
  validateBody(createSupplierTypeSchema),
  supplierTypeController.createSupplierType,
);
router.put(
  "/:id",
  requirePermission("supplier_types.edit"),
  writeLimiter,
  validateBody(updateSupplierTypeSchema),
  supplierTypeController.updateSupplierType,
);
router.delete(
  "/:id",
  requirePermission("supplier_types.delete"),
  writeLimiter,
  supplierTypeController.deleteSupplierType,
);

export default router;
