import { Router } from "express";

import * as supplierController from "./supplier.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createSupplierSchema, updateSupplierSchema } from "./supplier.validation.js";

const router = Router();

router.use(requireAuth);

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
