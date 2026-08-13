import type { Request } from "express";

import * as grnService from "./goods-in.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateGoodsReceiptInput, GRNAttachmentInput, GRNCancelInput, UpdateGoodsReceiptInput } from "./goods-in.validation.js";

// GET /goods-in?search=&status=&warehouse=&purchaseOrder=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the resulting file
// gives no sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): grnService.ListGoodsReceiptsParams {
  const { search, status, warehouse, purchaseOrder, supplier, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    warehouse: queryStr(warehouse),
    purchaseOrder: queryStr(purchaseOrder),
    supplier: queryStr(supplier),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listGoodsReceipts = asyncHandler(async (req, res) => {
  res.json(await grnService.listGoodsReceipts(listParamsFrom(req), actorFrom(req)));
});

// GET /goods-in/export.csv — the same filtered register as a download (paging ignored).
export const exportGoodsReceiptsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "goods-in", await grnService.exportGoodsReceiptsCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /goods-in/export-lines.csv — the same receipts, ONE ROW PER LINE (the quality report).
export const exportGoodsReceiptLinesCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "goods-in-lines", await grnService.exportGoodsReceiptLinesCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /goods-in/:id  (id or code)
export const getGoodsReceipt = asyncHandler(async (req, res) => {
  res.json({ goodsReceipt: await grnService.getGoodsReceipt(param(req, "id"), actorFrom(req)) });
});

// POST /goods-in
export const createGoodsReceipt = asyncHandler(async (req, res) => {
  const goodsReceipt = await grnService.createGoodsReceipt(req.body as CreateGoodsReceiptInput, actorFrom(req));
  res.status(201).json({ goodsReceipt });
});

// PATCH /goods-in/:id  (draft only)
export const updateGoodsReceipt = asyncHandler(async (req, res) => {
  res.json({ goodsReceipt: await grnService.updateGoodsReceipt(param(req, "id"), req.body as UpdateGoodsReceiptInput, actorFrom(req)) });
});

// DELETE /goods-in/:id  (draft only)
export const deleteGoodsReceipt = asyncHandler(async (req, res) => {
  await grnService.deleteGoodsReceipt(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// --- workflow ---------------------------------------------------------------
export const completeGoodsReceipt = asyncHandler(async (req, res) => {
  res.json({ goodsReceipt: await grnService.completeGoodsReceipt(param(req, "id"), actorFrom(req)) });
});
export const cancelGoodsReceipt = asyncHandler(async (req, res) => {
  const { reason } = req.body as GRNCancelInput;
  res.json({ goodsReceipt: await grnService.cancelGoodsReceipt(param(req, "id"), reason, actorFrom(req)) });
});

// --- attachments ------------------------------------------------------------
export const addAttachment = asyncHandler(async (req, res) => {
  const goodsReceipt = await grnService.addAttachment(param(req, "id"), req.body as GRNAttachmentInput, actorFrom(req));
  res.status(201).json({ goodsReceipt });
});
export const removeAttachment = asyncHandler(async (req, res) => {
  res.json({ goodsReceipt: await grnService.removeAttachment(param(req, "id"), param(req, "attachmentId"), actorFrom(req)) });
});
