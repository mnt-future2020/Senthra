import * as customFieldService from "./poCustomField.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreatePoCustomFieldInput,
  ReorderPoCustomFieldsInput,
  UpdatePoCustomFieldInput,
} from "./poCustomField.validation.js";

// GET /purchase-orders/custom-fields — every definition (active + inactive), in display order.
export const listCustomFields = asyncHandler(async (_req, res) => {
  res.json({ fields: await customFieldService.listCustomFields() });
});

// POST /purchase-orders/custom-fields
export const createCustomField = asyncHandler(async (req, res) => {
  const field = await customFieldService.createCustomField(req.body as CreatePoCustomFieldInput, actorFrom(req));
  res.status(201).json({ field });
});

// PATCH /purchase-orders/custom-fields/:fieldId — rename / activate / deactivate / print on PDF.
export const updateCustomField = asyncHandler(async (req, res) => {
  const field = await customFieldService.updateCustomField(
    param(req, "fieldId"),
    req.body as UpdatePoCustomFieldInput,
    actorFrom(req),
  );
  res.json({ field });
});

// PUT /purchase-orders/custom-fields/order — the complete list of ids in their new order.
export const reorderCustomFields = asyncHandler(async (req, res) => {
  const { ids } = req.body as ReorderPoCustomFieldsInput;
  res.json({ fields: await customFieldService.reorderCustomFields(ids, actorFrom(req)) });
});
