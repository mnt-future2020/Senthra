import type { Request } from "express";

import * as prfService from "./purchase-request.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type {
  CreatePurchaseRequestInput,
  GenerateReorderInput,
  PrfCancelInput,
  PrfRejectInput,
  PrfReopenInput,
  UpdatePurchaseRequestInput,
} from "./purchase-request.validation.js";

// GET /purchase-requests?search=&status=&statuses=&supplier=&warehouse=&job=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export below so the download is exactly the
// rows on screen — a second copy is a second place for a filter to be forgotten, and the resulting
// file gives no sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): prfService.ListPurchaseRequestsParams {
  const { search, status, statuses, supplier, warehouse, job, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    statuses: typeof statuses === "string" ? statuses.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    supplier: queryStr(supplier),
    warehouse: queryStr(warehouse),
    job: queryStr(job),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listPurchaseRequests = asyncHandler(async (req, res) => {
  res.json(await prfService.listPurchaseRequests(listParamsFrom(req), actorFrom(req)));
});

// GET /purchase-requests/export.csv — the same filtered list as a download (paging ignored).
export const exportPurchaseRequestsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "purchase-requests", await prfService.exportPurchaseRequestsCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /purchase-requests/export-lines.csv — the same requests, ONE ROW PER LINE.
export const exportPurchaseRequestLinesCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "purchase-request-lines", await prfService.exportPurchaseRequestLinesCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /purchase-requests/:id  (id or code)
export const getPurchaseRequest = asyncHandler(async (req, res) => {
  res.json({ purchaseRequest: await prfService.getPurchaseRequest(param(req, "id"), actorFrom(req)) });
});

// POST /purchase-requests
export const createPurchaseRequest = asyncHandler(async (req, res) => {
  const purchaseRequest = await prfService.createPurchaseRequest(req.body as CreatePurchaseRequestInput, actorFrom(req));
  res.status(201).json({ purchaseRequest });
});

// POST /purchase-requests/generate-reorder — Reorder-workbench generation: confirmed rows in,
// draft PRFs (grouped supplier × warehouse) + skipped/adjusted report out.
export const generateReorderPrfs = asyncHandler(async (req, res) => {
  const result = await prfService.generateReorderPrfs(req.body as GenerateReorderInput, actorFrom(req));
  res.status(201).json(result);
});

// PATCH /purchase-requests/:id  (draft only)
export const updatePurchaseRequest = asyncHandler(async (req, res) => {
  const purchaseRequest = await prfService.updatePurchaseRequest(param(req, "id"), req.body as UpdatePurchaseRequestInput, actorFrom(req));
  res.json({ purchaseRequest });
});

// DELETE /purchase-requests/:id  (draft only)
export const deletePurchaseRequest = asyncHandler(async (req, res) => {
  await prfService.deletePurchaseRequest(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// --- workflow actions -------------------------------------------------------
export const submitPurchaseRequest = asyncHandler(async (req, res) => {
  res.json({ purchaseRequest: await prfService.submitPurchaseRequest(param(req, "id"), actorFrom(req)) });
});
export const approvePurchaseRequest = asyncHandler(async (req, res) => {
  res.json({ purchaseRequest: await prfService.approvePurchaseRequest(param(req, "id"), actorFrom(req)) });
});
export const rejectPurchaseRequest = asyncHandler(async (req, res) => {
  const { reason } = req.body as PrfRejectInput;
  res.json({ purchaseRequest: await prfService.rejectPurchaseRequest(param(req, "id"), reason, actorFrom(req)) });
});
export const reopenPurchaseRequest = asyncHandler(async (req, res) => {
  const { reason } = req.body as PrfReopenInput;
  res.json({ purchaseRequest: await prfService.reopenPurchaseRequest(param(req, "id"), reason, actorFrom(req)) });
});
export const cancelPurchaseRequest = asyncHandler(async (req, res) => {
  const { reason } = req.body as PrfCancelInput;
  res.json({ purchaseRequest: await prfService.cancelPurchaseRequest(param(req, "id"), reason, actorFrom(req)) });
});

// POST /purchase-requests/:id/convert — generate the PO from a finance-approved PRF.
export const convertPurchaseRequest = asyncHandler(async (req, res) => {
  const result = await prfService.convertPurchaseRequest(param(req, "id"), actorFrom(req));
  res.status(201).json(result);
});

// POST /purchase-requests/:id/duplicate — prefilled revision copy of a converted PRF.
export const duplicatePurchaseRequest = asyncHandler(async (req, res) => {
  const purchaseRequest = await prfService.duplicatePurchaseRequest(param(req, "id"), actorFrom(req));
  res.status(201).json({ purchaseRequest });
});

// --- attachments ------------------------------------------------------------
export const removeAttachment = asyncHandler(async (req, res) => {
  const purchaseRequest = await prfService.removeAttachment(param(req, "id"), param(req, "attachmentId"), actorFrom(req));
  res.json({ purchaseRequest });
});
