import * as grnService from "./goods-in.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { CreateGoodsReceiptInput, GRNAttachmentInput, GRNCancelInput, UpdateGoodsReceiptInput } from "./goods-in.validation.js";

// GET /goods-in?search=&status=&warehouse=&purchaseOrder=&sort=&page=&pageSize=
export const listGoodsReceipts = asyncHandler(async (req, res) => {
  const { search, status, warehouse, purchaseOrder, sort, page, pageSize } = req.query;
  const result = await grnService.listGoodsReceipts({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    warehouse: typeof warehouse === "string" ? warehouse : undefined,
    purchaseOrder: typeof purchaseOrder === "string" ? purchaseOrder : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  }, actorFrom(req));
  res.json(result);
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
