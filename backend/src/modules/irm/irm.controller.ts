import * as irmService from "./irm.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateIrmItemInput, UpdateIrmItemInput } from "./irm.validation.js";

// GET /irm-items?search=&status=&type=&category=&supplier=&sort=&page=&pageSize=
export const listIrmItems = asyncHandler(async (req, res) => {
  const { search, status, type, category, supplier, sort, page, pageSize } = req.query;
  const result = await irmService.listIrmItems({
    search: queryStr(search),
    status: queryStr(status),
    type: queryStr(type),
    category: queryStr(category),
    supplier: queryStr(supplier),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /irm-items/owner-options — active staff users for the owner picker.
export const listOwnerOptions = asyncHandler(async (_req, res) => {
  res.json({ owners: await irmService.listOwnerOptions() });
});

// GET /irm-items/:id  (id or code)
export const getIrmItem = asyncHandler(async (req, res) => {
  const item = await irmService.getIrmItem(param(req, "id"));
  res.json({ item });
});

// POST /irm-items
export const createIrmItem = asyncHandler(async (req, res) => {
  const item = await irmService.createIrmItem(req.body as CreateIrmItemInput, actorFrom(req));
  res.status(201).json({ item });
});

// PATCH /irm-items/:id
export const updateIrmItem = asyncHandler(async (req, res) => {
  const item = await irmService.updateIrmItem(param(req, "id"), req.body as UpdateIrmItemInput, actorFrom(req));
  res.json({ item });
});

// DELETE /irm-items/:id — soft delete (guarded for future procurement modules).
export const deleteIrmItem = asyncHandler(async (req, res) => {
  await irmService.deleteIrmItem(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// POST /irm-items/:id/generate-barcode — generate / regenerate the item's barcode image.
export const generateBarcode = asyncHandler(async (req, res) => {
  const item = await irmService.generateBarcode(param(req, "id"), actorFrom(req));
  res.json({ item });
});
