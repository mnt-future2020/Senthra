import type { Request } from "express";

import * as warehouseService from "./warehouse.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateWarehouseInput, UpdateWarehouseInput } from "./warehouse.validation.js";

// GET /warehouses?search=&status=&type=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the resulting file
// gives no sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): warehouseService.ListWarehousesParams {
  const { search, status, type, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    type: queryStr(type),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listWarehouses = asyncHandler(async (req, res) => {
  res.json(await warehouseService.listWarehouses(listParamsFrom(req), actorFrom(req)));
});

// GET /warehouses/export.csv — the same filtered list as a download (paging ignored).
export const exportWarehousesCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "warehouses", await warehouseService.exportWarehousesCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /warehouses/engineer-options — active FIELD ENGINEERS (canHoldStock roles) for the
// "assign an engineer" pickers on jobs and dispatches.
export const listEngineerOptions = asyncHandler(async (_req, res) => {
  res.json({ engineers: await warehouseService.listEngineerOptions() });
});

// GET /warehouses/options — active warehouses (id/code/name) for assignment / PO pickers. Scoped to
// the caller: a warehouse-scoped user only sees their assigned warehouses.
export const listWarehouseOptions = asyncHandler(async (req, res) => {
  res.json({ options: await warehouseService.listWarehouseOptions(actorFrom(req)) });
});

// GET /warehouses/:id  (id or code)
export const getWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await warehouseService.getWarehouse(param(req, "id"), actorFrom(req));
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
