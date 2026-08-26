import { Router } from "express";

import * as poController from "./purchase-order.controller.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { HIRE_SETTLE_PERMISSIONS } from "#modules/role/permissions.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createPurchaseOrderSchema,
  createPurchaseOrdersSplitSchema,
  poAssignPmSchema,
  poCancelSchema,
  poDeliveryDateSchema,
  poRejectSchema,
  poSupplierAcceptSchema,
  updatePurchaseOrderSchema,
  closeHireShortSchema,
  extendHireSchema,
  declareHireLostSchema,
  recoverHireLossSchema,
  dismissCustodyExitSchema,
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
// committed to a supplier, and closing one short writes off what the supplier still owes.
// Receiving a hire is NOT here: a delivery of hired kit is a RECORD (quantities, condition, the
// supplier's asset tags, photographs) and it lives in its own module — POST /rental-receipts. A
// one-click "mark received" could not carry any of that, and two ways to start a hire is one too many.
// `rentals.hire.settle`, not `manage`. Closing short IS a decision about what the supplier still
// owes — but the person who learns it is the one at the receiving bay being told by the driver that
// there is no third one, and routing it through procurement left the shortfall sitting on the
// warehouse's own intake queue with no action available to the role the queue belongs to. Already
// warehouse-scoped through loadOrThrow, so a manager reaches only their own sites' orders.
//
// EXTENDING stays `manage` alone: that is fresh money committed to a supplier, which the receiving
// bay is not in a position to agree.
router.patch(
  "/:id/rental-lines/:lineId/close-short",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(closeHireShortSchema),
  poController.closeHireShort,
);
router.patch(
  "/:id/rental-lines/:lineId/extend",
  requirePermission("rentals.hire.manage"),
  writeLimiter,
  validateBody(extendHireSchema),
  poController.extendHire,
);

// Declaring hired kit lost, and booking it back in if it turns up.
//
// `HIRE_SETTLE_PERMISSIONS`, exactly as close-short above — and for the same reason, from the other
// end of the hire. Close short says "the rest is never arriving"; this says "the rest is never coming
// back". Both are decisions about what the provider is still owed, both are learned by the people
// working the equipment rather than by procurement, and both are warehouse-scoped at the service.
//
// The pair rather than `rentals.hire.settle` alone because `manage` is documented as a SUPERSET of
// settle (see permissions.ts) — every settle-class route in this module takes both, and taking only
// the narrower key here would lock out a procurement role that legitimately holds the wider one.
router.post(
  "/:id/rental-lines/:lineId/declare-lost",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(declareHireLostSchema),
  poController.declareHireLost,
);
router.post(
  "/:id/custody-exits/:exitId/recover",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(recoverHireLossSchema),
  poController.recoverHireLoss,
);

// Answering a damage report with "nothing is owed" — the third outcome, beside charging it and
// withdrawing the note behind it.
//
// `HIRE_SETTLE_PERMISSIONS`, exactly like the charge it is the alternative to (POST
// /rental-receipts/custody-exits/:exitId/charge). Deciding NOT to bill a provider is the same class of
// commercial decision as deciding to, taken by the same people, and giving it a narrower key would
// have left the warehouse floor able to close a claim procurement could not. No new permission: the
// existing model already expresses "may settle a hire record with the provider", which is precisely
// what this is.
//
// A POST and not a PATCH, matching `recover` above: this records a DECISION taken on a date, not an
// edit to a field. Warehouse-scoped and transactional at the service, like every other one here.
router.post(
  "/:id/custody-exits/:exitId/dismiss",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(dismissCustodyExitSchema),
  poController.dismissCustodyExit,
);

// Reading the custody record back. `rentals.view` — seeing that a tester was lost or broken is part of
// seeing the hire; ACTING on it is what needs settlement authority (the two POSTs above).
//
// The open-list route is declared BEFORE the :id one it would otherwise be swallowed by — "rental-lines"
// is not an ObjectId, but Express matches on order, not on shape.
router.get("/rental-lines/custody-exits", requirePermission("rentals.view"), poController.listOpenCustodyExits);
router.get("/rental-lines/:lineId/custody-exits", requirePermission("rentals.view"), poController.listHireCustodyHistory);
router.get("/:id/custody-exits", requirePermission("rentals.view"), poController.listOrderCustodyExits);

export default router;
