import { Router } from "express";

import * as warehouseController from "./warehouse.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createWarehouseSchema, updateWarehouseSchema } from "./warehouse.validation.js";

const router = Router();

router.use(requireAuth);

// Field-engineer picker (canHoldStock roles only) for the job "assign an engineer" dropdowns.
// Available to whoever can create/edit/assign a job. Static route BEFORE the /:id param route so
// it isn't captured as an id.
router.get(
  "/engineer-options",
  requireAnyPermission(
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.assign",
  ),
  warehouseController.listEngineerOptions,
);

// Active-warehouse options (scoped to the caller) for pickers — the user form's "Assigned
// Warehouses" and the purchase-order per-row warehouse. Available to whoever manages users or
// creates POs. Static route BEFORE /:id so "options" isn't captured as an id.
router.get(
  "/options",
  requireAnyPermission("users.create", "users.edit", "purchase_orders.create"),
  warehouseController.listWarehouseOptions,
);

router.get("/", requirePermission("warehouse.view"), warehouseController.listWarehouses);
router.get("/:id", requirePermission("warehouse.view"), warehouseController.getWarehouse);

router.post(
  "/",
  requirePermission("warehouse.create"),
  writeLimiter,
  validateBody(createWarehouseSchema),
  warehouseController.createWarehouse,
);
router.patch(
  "/:id",
  requirePermission("warehouse.edit"),
  writeLimiter,
  validateBody(updateWarehouseSchema),
  warehouseController.updateWarehouse,
);
router.delete("/:id", requirePermission("warehouse.delete"), writeLimiter, warehouseController.deleteWarehouse);

export default router;
