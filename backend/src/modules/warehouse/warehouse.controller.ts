import * as warehouseService from "./warehouse.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { CreateWarehouseInput, UpdateWarehouseInput } from "./warehouse.validation.js";

// GET /warehouses?search=&status=&type=&sort=&page=&pageSize=
export const listWarehouses = asyncHandler(async (req, res) => {
  const { search, status, type, sort, page, pageSize } = req.query;
  const result = await warehouseService.listWarehouses({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    type: typeof type === "string" ? type : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /warehouses/manager-options — active staff users for the manager picker.
export const listManagerOptions = asyncHandler(async (_req, res) => {
  res.json({ managers: await warehouseService.listManagerOptions() });
});

// GET /warehouses/:id  (id or code)
export const getWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await warehouseService.getWarehouse(param(req, "id"));
  res.json({ warehouse });
});

// POST /warehouses
export const createWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await warehouseService.createWarehouse(
    req.body as CreateWarehouseInput,
    actorFrom(req),
  );
  res.status(201).json({ warehouse });
});

// PATCH /warehouses/:id
export const updateWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await warehouseService.updateWarehouse(
    param(req, "id"),
    req.body as UpdateWarehouseInput,
    actorFrom(req),
  );
  res.json({ warehouse });
});

// DELETE /warehouses/:id — soft delete (guarded for future inventory).
export const deleteWarehouse = asyncHandler(async (req, res) => {
  await warehouseService.deleteWarehouse(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
