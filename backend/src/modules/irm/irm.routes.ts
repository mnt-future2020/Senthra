import { Router } from "express";

import * as irmController from "./irm.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createIrmItemSchema, updateIrmItemSchema } from "./irm.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("irm.view"), irmController.listIrmItems);
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
