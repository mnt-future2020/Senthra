import { Router } from "express";

import * as receiptController from "./rental-receipt.controller.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { exportLimiter, writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createRentalReceiptSchema,
  createRentalReturnSchema,
  recordDamageChargeSchema,
  reportHireDamageSchema,
  reverseRentalReceiptSchema,
} from "./rental-receipt.validation.js";

/** The warehouse floor's own work. `manage` is a superset, so it passes every one of these too. */
const HIRE_FLOOR = ["rentals.hire.receive", "rentals.hire.manage"] as const;

const router = Router();

router.use(requireAuth);

// The REGISTER and its two exports. Declared before "/:id", like every literal path here, so Express
// never reads "export.csv" as a receipt code and answers a download with "Hire delivery not found."
router.get("/", requirePermission("rentals.view"), receiptController.listRentalReceipts);
// Throttled and permissioned as an EXPORT, not as a view: the same rule the GRN register follows.
// Reading one movement is a page view; extracting the company's whole hire history is an event.
router.get(
  "/export.csv",
  requirePermission("rentals.export"),
  exportLimiter,
  receiptController.exportRentalReceiptsCsv,
);
router.get(
  "/export-lines.csv",
  requirePermission("rentals.export"),
  exportLimiter,
  receiptController.exportRentalReceiptLinesCsv,
);

// Declared before "/:id" so Express does not read "purchase-order" as a receipt id.
router.get(
  "/purchase-order/:id",
  requirePermission("rentals.view"),
  receiptController.listForPurchaseOrder,
);
router.get("/:id", requirePermission("rentals.view"), receiptController.getRentalReceipt);

// Booking kit IN, handing it BACK and reporting it broken are all the WAREHOUSE FLOOR's work, and they
// share one permission (`rentals.hire.receive`) for that reason. Deliberately not the same permission
// as extending a hire or reversing a record: those change what the supplier gets paid, and the person
// with a scanner in their hand should not need — or be given — that authority to do their job. See
// `rentals.hire.manage` is accepted everywhere `receive` is, so a role that already held it keeps
// working untouched — no migration, and no warehouse that silently stops being able to receive.
//
// Declared before "/:id" so Express never reads "returns" or "damage" as a receipt id.
router.post(
  "/",
  requireAnyPermission(...HIRE_FLOOR),
  writeLimiter,
  validateBody(createRentalReceiptSchema),
  receiptController.createRentalReceipt,
);
router.post(
  "/returns",
  requireAnyPermission(...HIRE_FLOOR),
  writeLimiter,
  validateBody(createRentalReturnSchema),
  receiptController.createRentalReturn,
);
router.post(
  "/damage",
  requireAnyPermission(...HIRE_FLOOR),
  writeLimiter,
  validateBody(reportHireDamageSchema),
  receiptController.reportHireDamage,
);
// What the supplier is CHARGING for the damage — the one value on a note that can be set after the
// fact, because it feeds no running total (see recordDamageCharge). `manage`, not the floor
// permission: agreeing what we owe a supplier is a commercial act, and the person with the scanner
// should not need that authority to do their job.
router.patch(
  "/:id/damage-charge",
  requirePermission("rentals.hire.manage"),
  writeLimiter,
  validateBody(recordDamageChargeSchema),
  receiptController.recordDamageCharge,
);

// Reversing is the exception: it rewrites how much of a hire moved, after the fact, and that is a
// commercial correction rather than a floor operation.
router.patch(
  "/:id/reverse",
  requirePermission("rentals.hire.manage"),
  writeLimiter,
  validateBody(reverseRentalReceiptSchema),
  receiptController.reverseRentalReceipt,
);

// Photos are ADDED through the shared direct-upload endpoint (purpose `hire_delivery_photo`), which
// signs, verifies and attaches in one path for every module. Only the removal needs a route of its
// own — it also releases the Cloudinary asset, once nothing else references it.
router.delete(
  "/:id/photos/:attachmentId",
  requireAnyPermission(...HIRE_FLOOR),
  writeLimiter,
  receiptController.removePhoto,
);

export default router;
