import * as supplierService from "./supplier.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { CreateSupplierInput, UpdateSupplierInput } from "./supplier.validation.js";

// GET /suppliers?search=&status=&type=&sort=&page=&pageSize=
export const listSuppliers = asyncHandler(async (req, res) => {
  const { search, status, type, sort, page, pageSize } = req.query;
  const result = await supplierService.listSuppliers({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    type: typeof type === "string" ? type : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /suppliers/owner-options — active staff users for the owner picker.
export const listOwnerOptions = asyncHandler(async (_req, res) => {
  res.json({ owners: await supplierService.listOwnerOptions() });
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
