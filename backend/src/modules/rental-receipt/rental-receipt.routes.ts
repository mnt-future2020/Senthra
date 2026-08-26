import { Router } from "express";

import * as receiptController from "./rental-receipt.controller.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { HIRE_SETTLE_PERMISSIONS } from "#modules/role/permissions.js";
import { exportLimiter, writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createRentalReceiptSchema,
  createRentalReturnSchema,
  recordDamageChargeSchema,
  chargeCustodyExitSchema,
  reportHireDamageSchema,
  reverseRentalReceiptSchema,
} from "./rental-receipt.validation.js";

/** The warehouse floor's own work. `manage` is a superset, so it passes every one of these too. */
const HIRE_FLOOR = ["rentals.hire.receive", "rentals.hire.settle", "rentals.hire.manage"] as const;

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
// Charging ONE record that already exists — a job's damage report, or a declared loss.
//
// `HIRE_SETTLE_PERMISSIONS`, like every other act that agrees money with a supplier: the floor reports
// what it finds, and settling what we owe for it is a commercial decision. Raising the provider's
// document is part of this call rather than a form the user fills first, because the report it is
// raised from was already written — by the engineer, on the day.
router.post(
  "/custody-exits/:exitId/charge",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(chargeCustodyExitSchema),
  receiptController.chargeCustodyExit,
);
// What the supplier is CHARGING for the damage — the one value on a note that can be set after the
// fact, because it feeds no running total (see recordDamageCharge). `settle`, not the bare floor key
// and not `manage` either: the floor ALREADY types this figure, on the damage report and the return
// note, whenever the driver hands it over at the door. Withholding the later correction meant the
// same person could write £450 today and not fix it to £400 when the invoice arrived.
router.patch(
  "/:id/damage-charge",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
  writeLimiter,
  validateBody(recordDamageChargeSchema),
  receiptController.recordDamageCharge,
);

// Reversing rewrites how much of a hire moved, after the fact — so it is `settle`, not the bare
// floor key. It is not procurement's either: the note being corrected was typed at the receiving bay,
// and the person who typed it wrong is the one who knows it. Scoped to the note's own warehouse by
// assertWarehouseAccess, so a manager can only undo their own sites' records.
router.patch(
  "/:id/reverse",
  requireAnyPermission(...HIRE_SETTLE_PERMISSIONS),
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
