import { Router } from "express";

import * as poController from "./purchase-order.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createPurchaseOrderSchema,
  createPurchaseOrdersSplitSchema,
  poAssignPmSchema,
  poAttachmentSchema,
  poCancelSchema,
  poDeliveryDateSchema,
  poRejectSchema,
  poSupplierAcceptSchema,
  updatePurchaseOrderSchema,
  extendHireSchema,
} from "./purchase-order.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("purchase_orders.view"), poController.listPurchaseOrders);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
router.get("/export.csv", requirePermission("purchase_orders.export"), exportLimiter, poController.exportPurchaseOrdersCsv);
router.get("/export-lines.csv", requirePermission("purchase_orders.export"), exportLimiter, poController.exportPurchaseOrderLinesCsv);
// Static paths before "/:id" so they aren't captured as an id.
router.get("/items/:irmItemId", requirePermission("purchase_orders.view"), poController.listPurchaseOrdersForItem);
// Eligible PMs for the Route-to-PM picker (+ the suggested default from the linked job).
router.get("/pm-candidates", requirePermission("purchase_orders.assign_pm"), poController.listPmCandidates);
// Supplier procurement summary — counts + spend for the supplier detail "Procurement" tab.
router.get("/suppliers/:supplierId/summary", requirePermission("purchase_orders.view"), poController.getSupplierProcurementSummary);
router.get("/:id", requirePermission("purchase_orders.view"), poController.getPurchaseOrder);
// Preview / download the generated PO document (PDF). PDF render is heavy (synchronous
// pdfkit render + remote logo fetch), so throttle it like the CSV export — otherwise an
// authenticated client could loop downloads and pin the single-threaded event loop.
router.get("/:id/pdf", requirePermission("purchase_orders.view"), exportLimiter, poController.downloadPurchaseOrderPdf);

router.post(
  "/",
  requirePermission("purchase_orders.create"),
  writeLimiter,
  validateBody(createPurchaseOrderSchema),
  poController.createPurchaseOrder,
);
// Multi-warehouse auto-split create: one request → N single-warehouse POs (one per warehouse group).
router.post(
  "/split",
  requirePermission("purchase_orders.create"),
  writeLimiter,
  validateBody(createPurchaseOrdersSplitSchema),
  poController.createPurchaseOrdersSplit,
);
router.patch(
  "/:id",
  requirePermission("purchase_orders.edit"),
  writeLimiter,
  validateBody(updatePurchaseOrderSchema),
  poController.updatePurchaseOrder,
);
router.delete("/:id", requirePermission("purchase_orders.delete"), writeLimiter, poController.deletePurchaseOrder);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/submit", requirePermission("purchase_orders.submit"), writeLimiter, poController.submitPurchaseOrder);
router.post("/:id/approve", requirePermission("purchase_orders.approve"), writeLimiter, poController.approvePurchaseOrder);
router.post(
  "/:id/reject",
  requirePermission("purchase_orders.approve"),
  writeLimiter,
  validateBody(poRejectSchema),
  poController.rejectPurchaseOrder,
);
router.post("/:id/send", requirePermission("purchase_orders.send"), writeLimiter, poController.sendPurchaseOrder);
router.post(
  "/:id/cancel",
  requirePermission("purchase_orders.cancel"),
  writeLimiter,
  validateBody(poCancelSchema),
  poController.cancelPurchaseOrder,
);
router.post("/:id/close", requirePermission("purchase_orders.close"), writeLimiter, poController.closePurchaseOrder);
// Route an approved PO to a Project Manager for review + send (or re-assign while in pm_review).
router.post(
  "/:id/assign-pm",
  requirePermission("purchase_orders.assign_pm"),
  writeLimiter,
  validateBody(poAssignPmSchema),
  poController.assignPmPurchaseOrder,
);
// Record the supplier's acknowledgement of an issued order. Advances sent → supplier_accepted;
// on an already-receiving order it records the acknowledgement without changing status.
router.post(
  "/:id/accept",
  requirePermission("purchase_orders.acknowledge"),
  writeLimiter,
  validateBody(poSupplierAcceptSchema),
  poController.recordSupplierAcceptance,
);
// Revise an existing confirmed delivery date, until the order closes (audited prev/new/reason).
router.patch(
  "/:id/delivery-date",
  requirePermission("purchase_orders.acknowledge"),
  writeLimiter,
  validateBody(poDeliveryDateSchema),
  poController.updateConfirmedDeliveryDate,
);

// --- attachments ------------------------------------------------------------
router.post(
  "/:id/attachments",
  requirePermission("purchase_orders.edit"),
  writeLimiter,
  validateBody(poAttachmentSchema),
  poController.addAttachment,
);
router.delete(
  "/:id/attachments/:attachmentId",
  requirePermission("purchase_orders.edit"),
  writeLimiter,
  poController.removeAttachment,
);

// Two-segment paths, so they cannot be shadowed by the single-segment "/:id" above. Keep them
// two-segment: a bare "/rental-lines" GET would be read as a purchase-order id and 404.
router.get("/rental-lines/on-hire", requirePermission("rentals.view"), poController.listOnHire);
router.get(
  "/rental-lines/on-hire/export",
  requirePermission("rentals.export"),
  exportLimiter,
  poController.exportOnHireCsv,
);
// Every extension agreed in a period — the breakdown of the running total each hire carries.
router.get("/rental-lines/extensions", requirePermission("rentals.view"), poController.listHireExtensions);
router.get(
  "/rental-lines/extensions/export.csv",
  requirePermission("rentals.export"),
  exportLimiter,
  poController.exportHireExtensionsCsv,
);

// ── Rental hires ─────────────────────────────────────────────────────────────────────────────
// Gated on rentals.hire.manage rather than purchase_orders.edit: these act on a LIVE hire
// committed to a supplier, and "mark returned" is what takes it off the deadline badge.
// Receiving a hire is NOT here: a delivery of hired kit is a RECORD (quantities, condition, the
// supplier's asset tags, photographs) and it lives in its own module — POST /rental-receipts. A
// one-click "mark received" could not carry any of that, and two ways to start a hire is one too many.
router.patch(
  "/:id/rental-lines/:lineId/return",
  requirePermission("rentals.hire.manage"),
  writeLimiter,
  poController.markHireReturned,
);
router.patch(
  "/:id/rental-lines/:lineId/extend",
  requirePermission("rentals.hire.manage"),
  writeLimiter,
  validateBody(extendHireSchema),
  poController.extendHire,
);

export default router;
