import * as supplierTypeService from "./supplier-type.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateSupplierTypeInput,
  UpdateSupplierTypeInput,
} from "./supplier-type.validation.js";

// GET /supplier-types
export const listSupplierTypes = asyncHandler(async (_req, res) => {
  res.json({ supplierTypes: await supplierTypeService.listSupplierTypes() });
});

// GET /supplier-types/:id  (id or key)
export const getSupplierType = asyncHandler(async (req, res) => {
  const supplierType = await supplierTypeService.getSupplierType(param(req, "id"));
  res.json({ supplierType });
});

// POST /supplier-types
export const createSupplierType = asyncHandler(async (req, res) => {
  const supplierType = await supplierTypeService.createSupplierType(
    req.body as CreateSupplierTypeInput,
    actorFrom(req),
  );
  res.status(201).json({ supplierType });
});

// PUT /supplier-types/:id
export const updateSupplierType = asyncHandler(async (req, res) => {
  const supplierType = await supplierTypeService.updateSupplierType(
    param(req, "id"),
    req.body as UpdateSupplierTypeInput,
    actorFrom(req),
  );
  res.json({ supplierType });
});

// DELETE /supplier-types/:id — blocked when suppliers still use the type.
export const deleteSupplierType = asyncHandler(async (req, res) => {
  await supplierTypeService.deleteSupplierType(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
