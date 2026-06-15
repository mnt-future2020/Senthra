import { Router } from "express";

import * as supplierController from "./supplier.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createSupplierSchema, updateSupplierSchema } from "./supplier.validation.js";

const router = Router();

router.use(requireAuth);

// Static route BEFORE the /:id param route so it isn't captured as an id. The owner
// picker is needed by anyone who can view/create/edit a supplier.
router.get(
  "/owner-options",
  requireAnyPermission("suppliers.view", "suppliers.create", "suppliers.edit"),
  supplierController.listOwnerOptions,
);

router.get("/", requirePermission("suppliers.view"), supplierController.listSuppliers);
router.get("/:id", requirePermission("suppliers.view"), supplierController.getSupplier);

router.post(
  "/",
  requirePermission("suppliers.create"),
  writeLimiter,
  validateBody(createSupplierSchema),
  supplierController.createSupplier,
);
router.patch(
  "/:id",
  requirePermission("suppliers.edit"),
  writeLimiter,
  validateBody(updateSupplierSchema),
  supplierController.updateSupplier,
);
router.delete("/:id", requirePermission("suppliers.delete"), writeLimiter, supplierController.deleteSupplier);

export default router;
