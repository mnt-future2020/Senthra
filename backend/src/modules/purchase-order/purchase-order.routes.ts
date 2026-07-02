import { Router } from "express";

import * as poController from "./purchase-order.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createPurchaseOrderSchema,
  createPurchaseOrdersSplitSchema,
  poAttachmentSchema,
  poCancelSchema,
  poRejectSchema,
  updatePurchaseOrderSchema,
} from "./purchase-order.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("purchase_orders.view"), poController.listPurchaseOrders);
// Static path before "/:id" so it isn't captured as an id.
router.get("/items/:irmItemId", requirePermission("purchase_orders.view"), poController.listPurchaseOrdersForItem);
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

export default router;
