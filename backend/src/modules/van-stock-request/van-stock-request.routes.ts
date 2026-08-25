import { Router } from "express";

import * as ctrl from "./van-stock-request.controller.js";
import { requireAuth, requirePermission, requireAnyPermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  approveVanStockRequestSchema,
  closeShortSchema,
  createVanStockRequestSchema,
  declineVanStockRequestSchema,
  fulfilVanStockRequestSchema,
  scanLookupSchema,
  uploadImageSchema,
  walkInSchema,
} from "./van-stock-request.validation.js";

// Non-job engineer ↔ warehouse van stock. Engineers (engineer.van_stock.request) raise restocks /
// returns and cancel their own; warehouse reviewers (van_stock_request.review) approve/decline,
// scan-fulfil, close short, and create walk-ins.
const router = Router();

router.use(requireAuth);

const ENGINEER = "engineer.van_stock.request";
const REVIEW = "van_stock_request.review";

// ---- Engineer self-service (static paths BEFORE /:id) ------------------------------------------
router.get("/mine", requirePermission(ENGINEER), ctrl.listMine);
router.get("/mine/open-lines", requirePermission(ENGINEER), ctrl.openLines);
router.get("/my-holdings", requirePermission(ENGINEER), ctrl.myHoldings);
// Item search serves BOTH composers: the engineer's restock modal and the reviewer's walk-in modal.
router.get("/item-search", requireAnyPermission(ENGINEER, REVIEW), ctrl.itemSearch);
// Walk-in composer only (reviewer): same catalogue search but annotated with THIS warehouse's on-hand.
router.get("/warehouse-item-search", requirePermission(REVIEW), ctrl.warehouseItemSearch);
// Engineer composer only: catalogue search narrowed to items in stock at SOME active warehouse.
router.get("/requestable-item-search", requirePermission(ENGINEER), ctrl.requestableItemSearch);
router.get("/warehouses-lite", requirePermission(ENGINEER), ctrl.warehousesLite);
// Serves BOTH the engineer's restock composer and the reviewer's approval UI (per-line source picker).
router.get("/availability", requireAnyPermission(ENGINEER, REVIEW), ctrl.availability);
router.post("/", requirePermission(ENGINEER), writeLimiter, validateBody(createVanStockRequestSchema), ctrl.create);
router.post("/attachments", requirePermission(ENGINEER), writeLimiter, validateBody(uploadImageSchema), ctrl.uploadAttachment);

// ---- Reviewer queue -----------------------------------------------------------------------------
router.get("/pending-count", requirePermission(REVIEW), ctrl.pendingCount);
router.get("/", requirePermission(REVIEW), ctrl.listAll);
router.post("/scan-lookup", requirePermission(REVIEW), writeLimiter, validateBody(scanLookupSchema), ctrl.scanLookup);
router.post("/walk-in", requirePermission(REVIEW), writeLimiter, validateBody(walkInSchema), ctrl.walkIn);

// ---- Single request (requester OR reviewer — service scopes) ------------------------------------
router.get("/:id", requireAnyPermission(ENGINEER, REVIEW), ctrl.getOne);

// ---- Transitions ---------------------------------------------------------------------------------
router.post("/:id/approve", requirePermission(REVIEW), writeLimiter, validateBody(approveVanStockRequestSchema), ctrl.approve);
router.post("/:id/decline", requirePermission(REVIEW), writeLimiter, validateBody(declineVanStockRequestSchema), ctrl.decline);
router.post("/:id/fulfil", requirePermission(REVIEW), writeLimiter, validateBody(fulfilVanStockRequestSchema), ctrl.fulfil);
router.post("/:id/close-short", requirePermission(REVIEW), writeLimiter, validateBody(closeShortSchema), ctrl.closeShort);
router.post("/:id/cancel", requirePermission(ENGINEER), writeLimiter, ctrl.cancel);
router.post("/:id/cancel-remaining", requirePermission(ENGINEER), writeLimiter, ctrl.cancelRemaining);

export default router;
