import { Router } from "express";

import * as warehouseTypeController from "./warehouse-type.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createWarehouseTypeSchema,
  updateWarehouseTypeSchema,
} from "./warehouse-type.validation.js";

const router = Router();

router.use(requireAuth);

// The type list is read by type-managers AND by the warehouse form's type picker
// (which staff reach via warehouse.create / warehouse.edit), so either may read it —
// mirrors how the category list allows customers.edit.
router.get(
  "/",
  requireAnyPermission("warehouse_types.view", "warehouse.create", "warehouse.edit"),
  warehouseTypeController.listWarehouseTypes,
);
router.get(
  "/:id",
  requireAnyPermission("warehouse_types.view", "warehouse_types.edit"),
  warehouseTypeController.getWarehouseType,
);

router.post(
  "/",
  requirePermission("warehouse_types.create"),
  writeLimiter,
  validateBody(createWarehouseTypeSchema),
  warehouseTypeController.createWarehouseType,
);
router.put(
  "/:id",
  requirePermission("warehouse_types.edit"),
  writeLimiter,
  validateBody(updateWarehouseTypeSchema),
  warehouseTypeController.updateWarehouseType,
);
router.delete(
  "/:id",
  requirePermission("warehouse_types.delete"),
  writeLimiter,
  warehouseTypeController.deleteWarehouseType,
);

export default router;
