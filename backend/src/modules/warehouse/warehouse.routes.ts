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

const router = Router();

router.use(requireAuth);

// Field-engineer picker (canHoldStock roles only) for the job "assign an engineer" dropdowns and
// for the warehouse's WALK-IN issue, where a reviewer hands van stock straight to an engineer who
// turned up at the counter. Available to whoever can create/edit/assign a job, or review van stock
// requests — without the van-stock key the walk-in form's engineer dropdown is silently empty (it
// swallows the rejection), so the issue can never be recorded. Static route BEFORE the /:id param
// route so it isn't captured as an id.
router.get(
  "/engineer-options",
  requireAnyPermission(
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.assign",
    "van_stock_request.review",
  ),
  warehouseController.listEngineerOptions,
);

// Active-warehouse options (scoped to the caller) for pickers. Every caller must be listed below or
// its dropdown renders silently EMPTY — each one swallows the rejection rather than surfacing it:
//   • the user form's "Assigned Warehouses"          → users.create / users.edit
//   • the purchase-order per-row warehouse           → purchase_orders.create
//   • the job pack's kit-line source warehouse       → jobs.create / jobs.edit
//   • the additional-kit REVIEW modal                → jobs.kit_request.review
//   • the van stock request's per-line source picker → van_stock_request.review
// The job and van-stock callers were added to the UI later than this guard and were missing from it.
// Widening grants no reach: the endpoint returns only names/codes of warehouses the caller may
// already see. Static route BEFORE /:id so "options" isn't captured as an id.
router.get(
  "/options",
  requireAnyPermission(
    "users.create",
    "users.edit",
    "purchase_orders.create",
    "jobs.create",
    "jobs.edit",
    "jobs.kit_request.review",
    "van_stock_request.review",
  ),
  warehouseController.listWarehouseOptions,
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
