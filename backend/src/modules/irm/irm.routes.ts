import { Router } from "express";

import * as irmController from "./irm.controller.js";
import { IRM_PICKER_PERMISSIONS } from "./irm.service.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createIrmItemSchema, updateIrmItemSchema } from "./irm.validation.js";

const router = Router();

router.use(requireAuth);

// Wider than irm.view on purpose — see IRM_PICKER_PERMISSIONS. The PRF, PO, goods-receipt and JOB
// forms all pick items from this list, and a role built from the jobs capability alone holds no
// catalogue permission at all: its picker was silently empty, which is the exact failure the rental
// and supplier routes were widened to prevent.
//
// The extra readers do NOT get item cost. Unlike the rental catalogue, an IRM item carries
// `standardCost`, so the controller blanks it for a caller holding none of IRM_COST_PERMISSIONS —
// widening the route without that would have been a new exposure, not a fix.
router.get("/", requireAnyPermission(...IRM_PICKER_PERMISSIONS), irmController.listIrmItems);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
router.get("/export.csv", requirePermission("irm.export"), exportLimiter, irmController.exportIrmItemsCsv);
router.get("/:id", requirePermission("irm.view"), irmController.getIrmItem);

router.post(
  "/",
  requirePermission("irm.create"),
  writeLimiter,
  validateBody(createIrmItemSchema),
  irmController.createIrmItem,
);
router.patch(
  "/:id",
  requirePermission("irm.edit"),
  writeLimiter,
  validateBody(updateIrmItemSchema),
  irmController.updateIrmItem,
);
router.delete("/:id", requirePermission("irm.delete"), writeLimiter, irmController.deleteIrmItem);

// Barcode generate / regenerate — its own dedicated permission (separate from catalogue edits).
router.post(
  "/:id/generate-barcode",
  requirePermission("irm.barcode.manage"),
  writeLimiter,
  irmController.generateBarcode,
);

export default router;
