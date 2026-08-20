import { Router } from "express";

import * as grnController from "./goods-in.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createGoodsReceiptSchema, grnCancelSchema, updateGoodsReceiptSchema } from "./goods-in.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("goods_in.view"), grnController.listGoodsReceipts);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
router.get("/export.csv", requirePermission("goods_in.export"), exportLimiter, grnController.exportGoodsReceiptsCsv);
router.get("/export-lines.csv", requirePermission("goods_in.export"), exportLimiter, grnController.exportGoodsReceiptLinesCsv);
router.get("/:id", requirePermission("goods_in.view"), grnController.getGoodsReceipt);

router.post("/", requirePermission("goods_in.create"), writeLimiter, validateBody(createGoodsReceiptSchema), grnController.createGoodsReceipt);
router.patch("/:id", requirePermission("goods_in.edit"), writeLimiter, validateBody(updateGoodsReceiptSchema), grnController.updateGoodsReceipt);
router.delete("/:id", requirePermission("goods_in.delete"), writeLimiter, grnController.deleteGoodsReceipt);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/complete", requirePermission("goods_in.complete"), writeLimiter, grnController.completeGoodsReceipt);
router.post("/:id/cancel", requirePermission("goods_in.cancel"), writeLimiter, validateBody(grnCancelSchema), grnController.cancelGoodsReceipt);

// --- attachments ------------------------------------------------------------
router.delete("/:id/attachments/:attachmentId", requirePermission("goods_in.edit"), writeLimiter, grnController.removeAttachment);

export default router;
