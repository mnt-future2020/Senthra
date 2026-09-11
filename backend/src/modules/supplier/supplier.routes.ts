import { Router } from "express";

import * as supplierController from "./supplier.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createSupplierSchema, updateSupplierSchema } from "./supplier.validation.js";
import { SUPPLIER_OPTION_READERS } from "#modules/role/permissions.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("suppliers.view"), supplierController.listSuppliers);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
// Static route BEFORE "/:id" so "options" is not parsed as an id.
//
// Wider than suppliers.view on purpose, and it grants no reach: this returns only the id, code and
// name of ACTIVE suppliers — the same names already printed on the requests and orders these
// callers create and list. A purchaser who may raise a PRF but not administer the supplier directory
// still has to be able to pick one, or the form is unusable; and a list's supplier FILTER must not
// 403 for a role that already sees the supplier on every row. See SUPPLIER_OPTION_READERS.
router.get(
  "/options",
  requireAnyPermission(...SUPPLIER_OPTION_READERS),
  supplierController.listSupplierOptions,
);
router.get("/export.csv", requirePermission("suppliers.export"), exportLimiter, supplierController.exportSuppliersCsv);
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
