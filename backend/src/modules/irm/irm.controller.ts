import type { Request } from "express";

import * as irmService from "./irm.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateIrmItemInput, UpdateIrmItemInput } from "./irm.validation.js";

// GET /irm-items?search=&status=&type=&category=&supplier=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the resulting file
// gives no sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): irmService.ListIrmItemsParams {
  const { search, status, type, category, supplier, sort, page, pageSize, ids } = req.query;
  return {
    search: queryStr(search),
    // The list route admits callers who were never granted the catalogue itself (a job planner
    // picking kit lines). They get every field the picker needs and NOT the cost — see
    // IRM_COST_PERMISSIONS. An admin principal has no permission array and sees everything.
    includeCost: req.principal ? req.principal.type === "admin" || irmService.canReadIrmCost(req.principal.permissions) : false,
    // ?ids=a,b,c — a narrowing lookup for callers that already hold the ids they need.
    ids: queryStr(ids)?.split(",").map((v) => v.trim()).filter(Boolean),
    status: queryStr(status),
    type: queryStr(type),
    category: queryStr(category),
    supplier: queryStr(supplier),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listIrmItems = asyncHandler(async (req, res) => {
  res.json(await irmService.listIrmItems(listParamsFrom(req)));
});

// GET /irm-items/export.csv — the same filtered catalogue as a download (paging ignored).
export const exportIrmItemsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "irm-catalogue", await irmService.exportIrmItemsCsv(listParamsFrom(req), actorFrom(req)));
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
