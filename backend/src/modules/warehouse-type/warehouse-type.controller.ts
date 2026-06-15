import * as warehouseTypeService from "./warehouse-type.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateWarehouseTypeInput,
  UpdateWarehouseTypeInput,
} from "./warehouse-type.validation.js";

// GET /warehouse-types
export const listWarehouseTypes = asyncHandler(async (_req, res) => {
  res.json({ warehouseTypes: await warehouseTypeService.listWarehouseTypes() });
});

// GET /warehouse-types/:id  (id or key)
export const getWarehouseType = asyncHandler(async (req, res) => {
  const warehouseType = await warehouseTypeService.getWarehouseType(param(req, "id"));
  res.json({ warehouseType });
});

// POST /warehouse-types
export const createWarehouseType = asyncHandler(async (req, res) => {
  const warehouseType = await warehouseTypeService.createWarehouseType(
    req.body as CreateWarehouseTypeInput,
    actorFrom(req),
  );
  res.status(201).json({ warehouseType });
});

// PUT /warehouse-types/:id
export const updateWarehouseType = asyncHandler(async (req, res) => {
  const warehouseType = await warehouseTypeService.updateWarehouseType(
    param(req, "id"),
    req.body as UpdateWarehouseTypeInput,
    actorFrom(req),
  );
  res.json({ warehouseType });
});

// DELETE /warehouse-types/:id — blocked when warehouses still use the type.
export const deleteWarehouseType = asyncHandler(async (req, res) => {
  await warehouseTypeService.deleteWarehouseType(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
