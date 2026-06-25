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

// Static route BEFORE the /:id param route so it isn't captured as an id. The manager
// picker is needed by anyone who can view/create/edit a warehouse.
router.get(
  "/manager-options",
  requireAnyPermission("warehouse.view", "warehouse.create", "warehouse.edit"),
  warehouseController.listManagerOptions,
);

// Field-engineer picker (canHoldStock roles only) for the job + dispatch "assign an engineer"
// dropdowns. Available to whoever can create/edit/assign a job or create/edit a dispatch.
router.get(
  "/engineer-options",
  requireAnyPermission(
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.assign",
    "goods_out.create",
    "goods_out.edit",
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
