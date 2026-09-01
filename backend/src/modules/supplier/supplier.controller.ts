import type { Request } from "express";

import * as supplierService from "./supplier.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateSupplierInput, UpdateSupplierInput } from "./supplier.validation.js";

// GET /suppliers?search=&status=&type=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the file gives no
// sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): supplierService.ListSuppliersParams {
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

export const listSuppliers = asyncHandler(async (req, res) => {
  res.json(await supplierService.listSuppliers(listParamsFrom(req)));
});

// GET /suppliers/export.csv — the same filtered list as a download (paging ignored).
export const exportSuppliersCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "suppliers", await supplierService.exportSuppliersCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /suppliers/:id  (id or code)
export const getSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.getSupplier(param(req, "id"));
  res.json({ supplier });
});

// POST /suppliers
export const createSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.createSupplier(
    req.body as CreateSupplierInput,
    actorFrom(req),
  );
  res.status(201).json({ supplier });
});

// PATCH /suppliers/:id
export const updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.updateSupplier(
    param(req, "id"),
    req.body as UpdateSupplierInput,
    actorFrom(req),
  );
  res.json({ supplier });
});

// DELETE /suppliers/:id — soft delete (guarded for future procurement modules).
export const deleteSupplier = asyncHandler(async (req, res) => {
  await supplierService.deleteSupplier(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// GET /suppliers/options — the complete active set, lean, for pickers.
export const listSupplierOptions = asyncHandler(async (_req, res) => {
  res.json({ options: await supplierService.listSupplierOptions() });
});
