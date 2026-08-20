import { Router } from "express";

import * as rentalItemController from "./rental-item.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createRentalItemSchema, updateRentalItemSchema } from "./rental-item.validation.js";

const router = Router();

router.use(requireAuth);

// The PRF form's rental-line picker reads this list, so a requester who may raise a purchase
// request needs it too — otherwise the picker is empty and no rental can ever be requested.
router.get(
  "/",
  requireAnyPermission("rentals.view", "purchase_requests.create", "purchase_requests.edit"),
  rentalItemController.listRentalItems,
);
// Declared before "/:id" so Express does not read "export" as a rental-item id.
router.get("/export", requirePermission("rentals.export"), exportLimiter, rentalItemController.exportRentalItemsCsv);
router.get("/:id", requirePermission("rentals.view"), rentalItemController.getRentalItem);
// The printable label. `rentals.view` and no write limiter, because this creates nothing — unlike
// IRM's generate-barcode, which mints and stores an image and so carries its own manage permission.
router.get("/:id/barcode", requirePermission("rentals.view"), rentalItemController.getRentalItemBarcode);

router.post(
  "/",
  requirePermission("rentals.create"),
  writeLimiter,
  validateBody(createRentalItemSchema),
  rentalItemController.createRentalItem,
);
router.patch(
  "/:id",
  requirePermission("rentals.edit"),
  writeLimiter,
  validateBody(updateRentalItemSchema),
  rentalItemController.updateRentalItem,
);
router.delete(
  "/:id",
  requirePermission("rentals.delete"),
  writeLimiter,
  rentalItemController.deleteRentalItem,
);

export default router;
