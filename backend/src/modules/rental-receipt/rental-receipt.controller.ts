import * as receiptService from "./rental-receipt.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import { sendCsv } from "../../utils/csv-response.js";
import type { Request } from "express";
import type {
  CreateRentalReceiptInput,
  CreateRentalReturnInput,
  RecordDamageChargeInput,
  ReportHireDamageInput,
  ReverseRentalReceiptInput,
} from "./rental-receipt.validation.js";

// GET /rental-receipts?search=&direction=&warehouse=&supplier=&purchaseOrder=&from=&to=&liveOnly=
//
// The register's filters, parsed ONCE and shared with both exports — a second copy is a second place
// for a filter to be forgotten, and the resulting file gives no sign that it is wider than the list
// it came from.
function listParamsFrom(req: Request): receiptService.ListRentalReceiptsParams {
  const { search, direction, warehouse, supplier, purchaseOrder, from, to, liveOnly, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    direction: queryStr(direction),
    warehouse: queryStr(warehouse),
    supplier: queryStr(supplier),
    purchaseOrder: queryStr(purchaseOrder),
    from: queryStr(from),
    to: queryStr(to),
    // Opt-IN, and phrased as the narrowing: reversed notes belong in a register by default, and only
    // a caller that means to sum the quantities asks for them to be dropped.
    includeReversed: queryStr(liveOnly) === "true" ? false : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

// GET /rental-receipts — the register: every movement, across every order.
export const listRentalReceipts = asyncHandler(async (req, res) => {
  res.json(await receiptService.listRentalReceipts(listParamsFrom(req), actorFrom(req)));
});

// GET /rental-receipts/export.csv — the same filtered register as a download (paging ignored).
export const exportRentalReceiptsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "hire-movements", await receiptService.exportRentalReceiptsCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /rental-receipts/export-lines.csv — the same movements, ONE ROW PER ITEM.
export const exportRentalReceiptLinesCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "hire-movement-lines", await receiptService.exportRentalReceiptLinesCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /rental-receipts/purchase-order/:id — every live movement note against one order.
export const listForPurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ receipts: await receiptService.listForPurchaseOrder(param(req, "id"), actorFrom(req)) });
});

// PATCH /rental-receipts/:id/damage-charge — what the supplier is charging, recorded after the fact.
export const recordDamageCharge = asyncHandler(async (req, res) => {
  const receipt = await receiptService.recordDamageCharge(
    param(req, "id"),
    req.body as RecordDamageChargeInput,
    actorFrom(req),
  );
  res.json({ receipt });
});

// GET /rental-receipts/:id  (id or code)
export const getRentalReceipt = asyncHandler(async (req, res) => {
  res.json({ receipt: await receiptService.getRentalReceipt(param(req, "id"), actorFrom(req)) });
});

// POST /rental-receipts — record a delivery of hired kit.
export const createRentalReceipt = asyncHandler(async (req, res) => {
  const receipt = await receiptService.createRentalReceipt(req.body as CreateRentalReceiptInput, actorFrom(req));
  res.status(201).json({ receipt });
});

// POST /rental-receipts/returns — record hired kit going back to the supplier.
export const createRentalReturn = asyncHandler(async (req, res) => {
  const receipt = await receiptService.createRentalReturn(req.body as CreateRentalReturnInput, actorFrom(req));
  res.status(201).json({ receipt });
});

// POST /rental-receipts/damage — report damage found while the kit is with us.
export const reportHireDamage = asyncHandler(async (req, res) => {
  const receipt = await receiptService.reportHireDamage(req.body as ReportHireDamageInput, actorFrom(req));
  res.status(201).json({ receipt });
});

// PATCH /rental-receipts/:id/reverse
export const reverseRentalReceipt = asyncHandler(async (req, res) => {
  const receipt = await receiptService.reverseRentalReceipt(
    param(req, "id"),
    req.body as ReverseRentalReceiptInput,
    actorFrom(req),
  );
  res.json({ receipt });
});

// DELETE /rental-receipts/:id/photos/:attachmentId
export const removePhoto = asyncHandler(async (req, res) => {
  const receipt = await receiptService.removePhoto(param(req, "id"), param(req, "attachmentId"), actorFrom(req));
  res.json({ receipt });
});
