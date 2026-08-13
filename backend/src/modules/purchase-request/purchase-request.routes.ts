import { Router } from "express";

import * as prfController from "./purchase-request.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createPurchaseRequestSchema,
  generateReorderSchema,
  prfAttachmentSchema,
  prfCancelSchema,
  prfRejectSchema,
  prfReopenSchema,
  updatePurchaseRequestSchema,
} from "./purchase-request.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("purchase_requests.view"), prfController.listPurchaseRequests);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
router.get("/export.csv", requirePermission("purchase_requests.export"), exportLimiter, prfController.exportPurchaseRequestsCsv);
router.get("/export-lines.csv", requirePermission("purchase_requests.export"), exportLimiter, prfController.exportPurchaseRequestLinesCsv);
router.get("/:id", requirePermission("purchase_requests.view"), prfController.getPurchaseRequest);

router.post(
  "/",
  requirePermission("purchase_requests.create"),
  writeLimiter,
  validateBody(createPurchaseRequestSchema),
  prfController.createPurchaseRequest,
);
// Reorder-workbench generation — creates DRAFT PRFs, so the same permission as a manual create.
router.post(
  "/generate-reorder",
  requirePermission("purchase_requests.create"),
  writeLimiter,
  validateBody(generateReorderSchema),
  prfController.generateReorderPrfs,
);
router.patch(
  "/:id",
  requirePermission("purchase_requests.edit"),
  writeLimiter,
  validateBody(updatePurchaseRequestSchema),
  prfController.updatePurchaseRequest,
);
router.delete("/:id", requirePermission("purchase_requests.delete"), writeLimiter, prfController.deletePurchaseRequest);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/submit", requirePermission("purchase_requests.submit"), writeLimiter, prfController.submitPurchaseRequest);
router.post("/:id/approve", requirePermission("purchase_requests.approve"), writeLimiter, prfController.approvePurchaseRequest);
router.post(
  "/:id/reject",
  requirePermission("purchase_requests.approve"),
  writeLimiter,
  validateBody(prfRejectSchema),
  prfController.rejectPurchaseRequest,
);
// Reopen-for-revision (approved → draft) — a finance action, same permission as approve/reject.
router.post(
  "/:id/reopen",
  requirePermission("purchase_requests.approve"),
  writeLimiter,
  validateBody(prfReopenSchema),
  prfController.reopenPurchaseRequest,
);
router.post(
  "/:id/cancel",
  requirePermission("purchase_requests.cancel"),
  writeLimiter,
  validateBody(prfCancelSchema),
  prfController.cancelPurchaseRequest,
);
// Generate the Purchase Order from a finance-approved PRF (one per PRF, forever).
router.post("/:id/convert", requirePermission("purchase_requests.convert"), writeLimiter, prfController.convertPurchaseRequest);
// Duplicate a converted PRF as a prefilled draft revision (price-revision workflow).
router.post("/:id/duplicate", requirePermission("purchase_requests.create"), writeLimiter, prfController.duplicatePurchaseRequest);

// --- attachments ------------------------------------------------------------
router.post(
  "/:id/attachments",
  requirePermission("purchase_requests.edit"),
  writeLimiter,
  validateBody(prfAttachmentSchema),
  prfController.addAttachment,
);
router.delete(
  "/:id/attachments/:attachmentId",
  requirePermission("purchase_requests.edit"),
  writeLimiter,
  prfController.removeAttachment,
);

export default router;
