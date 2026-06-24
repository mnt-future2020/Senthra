import * as poService from "./purchase-order.service.js";
import * as documentService from "#modules/document/document.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrdersSplitInput,
  PoAttachmentInput,
  PoCancelInput,
  PoRejectInput,
  UpdatePurchaseOrderInput,
} from "./purchase-order.validation.js";

// GET /purchase-orders?search=&status=&statuses=&priority=&supplier=&warehouse=&sort=&page=&pageSize=
// `statuses` is a comma-separated list (e.g. statuses=sent,partially_received) for callers that
// need several statuses in one query (the warehouse "Expected deliveries" worklist).
export const listPurchaseOrders = asyncHandler(async (req, res) => {
  const { search, status, statuses, priority, supplier, warehouse, sort, page, pageSize } = req.query;
  const result = await poService.listPurchaseOrders({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    statuses: typeof statuses === "string" ? statuses.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    priority: typeof priority === "string" ? priority : undefined,
    supplier: typeof supplier === "string" ? supplier : undefined,
    warehouse: typeof warehouse === "string" ? warehouse : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  }, actorFrom(req));
  res.json(result);
});

// GET /purchase-orders/:id  (id or code)
export const getPurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.getPurchaseOrder(param(req, "id"), actorFrom(req)) });
});

// GET /purchase-orders/:id/pdf  (id or code) — stream the generated PO document for preview/download.
export const downloadPurchaseOrderPdf = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const po = await poService.loadPurchaseOrderEntity(param(req, "id"), actor);
  const pdf = await documentService.generatePurchaseOrderPdf(po, actor.email);
  res.setHeader("Content-Type", pdf.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${pdf.filename}"`);
  res.send(pdf.buffer);
});

// POST /purchase-orders
export const createPurchaseOrder = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.createPurchaseOrder(req.body as CreatePurchaseOrderInput, actorFrom(req));
  res.status(201).json({ purchaseOrder });
});

// POST /purchase-orders/split — one purchasing operation, items each carrying a warehouse → the
// backend auto-splits into one single-warehouse PO per warehouse and returns them all.
export const createPurchaseOrdersSplit = asyncHandler(async (req, res) => {
  const purchaseOrders = await poService.createPurchaseOrdersBySplit(
    req.body as CreatePurchaseOrdersSplitInput,
    actorFrom(req),
  );
  res.status(201).json({ purchaseOrders });
});

// PATCH /purchase-orders/:id  (draft only)
export const updatePurchaseOrder = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.updatePurchaseOrder(param(req, "id"), req.body as UpdatePurchaseOrderInput, actorFrom(req));
  res.json({ purchaseOrder });
});

// DELETE /purchase-orders/:id  (draft only)
export const deletePurchaseOrder = asyncHandler(async (req, res) => {
  await poService.deletePurchaseOrder(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// --- workflow actions -------------------------------------------------------
export const submitPurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.submitPurchaseOrder(param(req, "id"), actorFrom(req)) });
});
export const approvePurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.approvePurchaseOrder(param(req, "id"), actorFrom(req)) });
});
export const rejectPurchaseOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body as PoRejectInput;
  res.json({ purchaseOrder: await poService.rejectPurchaseOrder(param(req, "id"), reason, actorFrom(req)) });
});
export const sendPurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.sendPurchaseOrder(param(req, "id"), actorFrom(req)) });
});
export const cancelPurchaseOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body as PoCancelInput;
  res.json({ purchaseOrder: await poService.cancelPurchaseOrder(param(req, "id"), reason, actorFrom(req)) });
});
export const closePurchaseOrder = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.closePurchaseOrder(param(req, "id"), actorFrom(req)) });
});

// --- attachments ------------------------------------------------------------
export const addAttachment = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.addAttachment(param(req, "id"), req.body as PoAttachmentInput, actorFrom(req));
  res.status(201).json({ purchaseOrder });
});
export const removeAttachment = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.removeAttachment(param(req, "id"), param(req, "attachmentId"), actorFrom(req));
  res.json({ purchaseOrder });
});
