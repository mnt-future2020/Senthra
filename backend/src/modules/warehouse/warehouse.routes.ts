import { Router } from "express";

import * as warehouseController from "./warehouse.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createWarehouseSchema, updateWarehouseSchema } from "./warehouse.validation.js";
import {
  ENGINEER_OPTION_READERS,
  WAREHOUSE_DELIVERY_OPTION_READERS,
  WAREHOUSE_OPTION_READERS,
} from "#modules/role/permissions.js";

const router = Router();

router.use(requireAuth);

// Field-engineer picker (canHoldStock roles only) for the job "assign an engineer" dropdowns and
// for the warehouse's WALK-IN issue, where a reviewer hands van stock straight to an engineer who
// turned up at the counter. Available to whoever can create/edit/assign a job, or review van stock
// requests — without the van-stock key the walk-in form's engineer dropdown is silently empty (it
// swallows the rejection), so the issue can never be recorded. Static route BEFORE the /:id param
// route so it isn't captured as an id.
// The admin engineer-transfer board filters by engineer too (engineer_stock.view) — see
// ENGINEER_OPTION_READERS.
router.get(
  "/engineer-options",
  requireAnyPermission(...ENGINEER_OPTION_READERS),
  warehouseController.listEngineerOptions,
);

// Active-warehouse options (scoped to the caller) for pickers and filters. Every caller must be listed
// in WAREHOUSE_OPTION_READERS or its dropdown renders silently EMPTY — each one swallows the rejection
// rather than surfacing it. Widening grants no reach: the endpoint returns only names/codes of the
// warehouses the caller may already see. Static route BEFORE /:id so "options" isn't captured as an id.
router.get(
  "/options",
  requireAnyPermission(...WAREHOUSE_OPTION_READERS),
  warehouseController.listWarehouseOptions,
);

// The PR / PO delivery-warehouse picker — option + address, scoped like /options. See
// WAREHOUSE_DELIVERY_OPTION_READERS for why this is not simply a wider /options. Before /:id.
router.get(
  "/delivery-options",
  requireAnyPermission(...WAREHOUSE_DELIVERY_OPTION_READERS),
  warehouseController.listWarehouseDeliveryOptions,
);

router.get("/", requirePermission("warehouse.view"), warehouseController.listWarehouses);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
router.get("/export.csv", requirePermission("warehouse.export"), exportLimiter, warehouseController.exportWarehousesCsv);
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
