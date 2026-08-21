import type { Request } from "express";

import * as poService from "./purchase-order.service.js";
import * as documentService from "#modules/document/document.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrdersSplitInput,
  CloseHireShortInput,
  ExtendHireInput,
  PoAssignPmInput,
  PoAttachmentInput,
  PoCancelInput,
  PoDeliveryDateInput,
  PoRejectInput,
  PoSupplierAcceptInput,
  UpdatePurchaseOrderInput,
} from "./purchase-order.validation.js";

// GET /purchase-orders?search=&status=&statuses=&priority=&supplier=&warehouse=&sort=&page=&pageSize=
// `statuses` is a comma-separated list (e.g. statuses=sent,partially_received) for callers that
// need several statuses in one query (the warehouse "Expected deliveries" worklist).
// The list's filters, parsed once. Shared with the CSV export below so the download is exactly the
// rows on screen — a second copy of this parsing is a second place for a filter to be forgotten,
// and the symptom (an export quietly wider or narrower than the list) is not visible in the file.
function listParamsFrom(req: Request, actor: ReturnType<typeof actorFrom>): poService.ListPurchaseOrdersParams {
  const { search, status, statuses, priority, supplier, warehouse, pm, job, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    statuses: typeof statuses === "string" ? statuses.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    priority: queryStr(priority),
    supplier: queryStr(supplier),
    warehouse: queryStr(warehouse),
    // pm=me resolves to the signed-in user — the PM's "Awaiting my action" worklist.
    pm: typeof pm === "string" ? (pm === "me" ? actor.id ?? undefined : pm) : undefined,
    job: queryStr(job),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listPurchaseOrders = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  res.json(await poService.listPurchaseOrders(listParamsFrom(req, actor), actor));
});

// GET /purchase-orders/export.csv — the same filtered list as a download (paging ignored).
export const exportPurchaseOrdersCsv = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  sendCsv(res, "purchase-orders", await poService.exportPurchaseOrdersCsv(listParamsFrom(req, actor), actor));
});

// GET /purchase-orders/export-lines.csv — the same orders, ONE ROW PER LINE (the spend report).
export const exportPurchaseOrderLinesCsv = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  sendCsv(res, "purchase-order-lines", await poService.exportPurchaseOrderLinesCsv(listParamsFrom(req, actor), actor));
});

// GET /purchase-orders/pm-candidates?jobId= — eligible PMs for the Route-to-PM picker plus the
// suggested default (the linked job's creator, when they qualify).
export const listPmCandidates = asyncHandler(async (req, res) => {
  const { jobId } = req.query;
  res.json(await poService.resolvePmCandidates(queryStr(jobId)));
});

// GET /purchase-orders/suppliers/:supplierId/summary — the supplier detail "Procurement" tab.
export const getSupplierProcurementSummary = asyncHandler(async (req, res) => {
  res.json({ summary: await poService.getSupplierProcurementSummary(param(req, "supplierId")) });
});

// GET /purchase-orders/items/:irmItemId — POs referencing an IRM item (item detail "Purchase Orders" tab)
export const listPurchaseOrdersForItem = asyncHandler(async (req, res) => {
  res.json({ purchases: await poService.listPurchaseOrdersForItem(param(req, "irmItemId")) });
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
  // Returns { purchaseOrder, divertedToReview } — divertedToReview=true when a diverged PRF-born
  // draft was routed to review instead of approved, so the client can message it correctly.
  res.json(await poService.approvePurchaseOrder(param(req, "id"), actorFrom(req)));
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
// POST /purchase-orders/:id/assign-pm — route an approved PO to a PM (or re-assign in pm_review).
export const assignPmPurchaseOrder = asyncHandler(async (req, res) => {
  const { pmUserId } = req.body as PoAssignPmInput;
  res.json({ purchaseOrder: await poService.assignPmPurchaseOrder(param(req, "id"), pmUserId, actorFrom(req)) });
});
// POST /purchase-orders/:id/accept — record the supplier's acceptance (sent → supplier_accepted).
export const recordSupplierAcceptance = asyncHandler(async (req, res) => {
  res.json({ purchaseOrder: await poService.recordSupplierAcceptance(param(req, "id"), req.body as PoSupplierAcceptInput, actorFrom(req)) });
});
// PATCH /purchase-orders/:id/delivery-date — revise the confirmed delivery date (audited).
export const updateConfirmedDeliveryDate = asyncHandler(async (req, res) => {
  const { confirmedDeliveryDate, reason } = req.body as PoDeliveryDateInput;
  res.json({ purchaseOrder: await poService.updateConfirmedDeliveryDate(param(req, "id"), confirmedDeliveryDate, reason, actorFrom(req)) });
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

// PATCH /purchase-orders/:id/rental-lines/:lineId/close-short
export const closeHireShort = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.closeHireShort(
    param(req, "id"),
    param(req, "lineId"),
    req.body as CloseHireShortInput,
    actorFrom(req),
  );
  res.json({ purchaseOrder });
});

// PATCH /purchase-orders/:id/rental-lines/:lineId/extend
export const extendHire = asyncHandler(async (req, res) => {
  const purchaseOrder = await poService.extendHire(
    param(req, "id"),
    param(req, "lineId"),
    req.body as ExtendHireInput,
    actorFrom(req),
  );
  res.json({ purchaseOrder });
});

// GET /purchase-orders/rental-lines/on-hire
export const listOnHire = asyncHandler(async (req, res) => {
  res.json(
    await poService.listOnHire(
      {
        status: queryStr(req.query.status),
        page: queryInt(req.query.page),
        pageSize: queryInt(req.query.pageSize),
        // Set only by a warehouse's own receiving pane. The list is company-wide otherwise, because a
        // hire is chased by the PM on the order rather than by whoever holds the warehouse.
        warehouseId: queryStr(req.query.warehouseId),
        // Set by a rental item's own page — the live hires of that one item.
        rentalItemId: queryStr(req.query.rentalItemId),
        search: queryStr(req.query.search),
      },
      actorFrom(req),
    ),
  );
});

// GET /purchase-orders/rental-lines/on-hire/export
// GET /purchase-orders/rental-lines/extensions?search=&purchaseOrder=&from=&to=&page=&pageSize=
//
// The period filters, parsed once and shared with the export — a second copy is a second place for a
// filter to be forgotten, and the file gives no sign that it is wider than the list it came from.
function extensionParamsFrom(req: Request): poService.ListHireExtensionsParams {
  const { search, purchaseOrder, from, to, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    purchaseOrder: queryStr(purchaseOrder),
    from: queryStr(from),
    to: queryStr(to),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listHireExtensions = asyncHandler(async (req, res) => {
  res.json(await poService.listHireExtensions(extensionParamsFrom(req), actorFrom(req)));
});

// GET /purchase-orders/rental-lines/extensions/export.csv — the same period as a download.
export const exportHireExtensionsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "hire-extensions", await poService.exportHireExtensionsCsv(extensionParamsFrom(req), actorFrom(req)));
});

export const exportOnHireCsv = asyncHandler(async (req, res) => {
  sendCsv(
    res,
    "rentals-on-hire",
    // The SAME filters the screen carries. A download that quietly holds more rows than the list it
    // was taken from gives no sign of it.
    await poService.exportOnHireCsv(
      { status: queryStr(req.query.status), search: queryStr(req.query.search) },
      actorFrom(req),
    ),
  );
});
