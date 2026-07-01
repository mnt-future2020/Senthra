import { Router } from "express";

import * as ctrl from "./engineer-transfer.controller.js";
import { requireAuth, requirePermission, requireAnyPermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createTransferSchema,
  declineSchema,
  acknowledgeSchema,
  uploadAttachmentSchema,
} from "./engineer-transfer.validation.js";

const router = Router();

router.use(requireAuth);

// ---- Discovery (item holders) ---------------------------------------------------------------
// GET /engineer-transfers/holders?ownership=company&irmItemId=... (or ownership=customer&customerStockEntryId=...)
router.get(
  "/holders",
  requireAnyPermission("engineer.transfer", "engineer_stock.view", "engineer_stock.transfer"),
  ctrl.getHolders,
);

// ---- Engineer self-service (own inbox / outbox) ---------------------------------------------
// GET /engineer-transfers/mine?role=incoming|outgoing|all&status=&sort=&page=&pageSize=
router.get(
  "/mine",
  requireAnyPermission("engineer.transfer", "engineer_stock.view", "engineer_stock.transfer"),
  ctrl.listMine,
);

// ---- Admin oversight (all transfers) — engineer_stock perms ONLY (engineers use /mine) ------
// GET /engineer-transfers?status=&engineerId=&ownership=&sort=&page=&pageSize=
router.get(
  "/",
  requireAnyPermission("engineer_stock.view", "engineer_stock.transfer"),
  ctrl.listAll,
);

// ---- A source engineer's transferable holdings (admin picker — engineer_stock ONLY) --------
// Engineers must NOT browse another engineer's full inventory; they discover via item search.
// GET /engineer-transfers/holdings/:engineerId  (two-segment path — never captured by /:id)
router.get(
  "/holdings/:engineerId",
  requireAnyPermission("engineer_stock.view", "engineer_stock.transfer"),
  ctrl.getEngineerHoldings,
);

// ---- Discovery for engineer self-service (only items OTHER engineers hold; static paths) -----
// GET /engineer-transfers/company-search?search=...   (company/IRM stock held by other engineers)
router.get(
  "/company-search",
  requireAnyPermission("engineer.transfer", "engineer_stock.view", "engineer_stock.transfer"),
  ctrl.companyCandidates,
);
// GET /engineer-transfers/customer-search?search=...  (customer consignment held by other engineers)
router.get(
  "/customer-search",
  requireAnyPermission("engineer.transfer", "engineer_stock.view", "engineer_stock.transfer"),
  ctrl.customerCandidates,
);

// ---- Single transfer detail ----------------------------------------------------------------
// GET /engineer-transfers/:id
router.get(
  "/:id",
  requireAnyPermission("engineer.transfer", "engineer_stock.view", "engineer_stock.transfer"),
  ctrl.getOne,
);

// ---- Create a transfer request ---------------------------------------------------------------
// POST /engineer-transfers
router.post(
  "/",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  validateBody(createTransferSchema),
  ctrl.createTransfer,
);

// ---- Upload attachment (returns URL, does NOT create a transfer) ----------------------------
// POST /engineer-transfers/attachments
router.post(
  "/attachments",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  validateBody(uploadAttachmentSchema),
  ctrl.uploadAttachment,
);

// ---- State transitions -----------------------------------------------------------------------

// POST /engineer-transfers/:id/approve  (holder only — service enforces actor identity)
router.post(
  "/:id/approve",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  ctrl.approve,
);

// POST /engineer-transfers/:id/decline  (holder or admin)
router.post(
  "/:id/decline",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  validateBody(declineSchema),
  ctrl.decline,
);

// POST /engineer-transfers/:id/cancel  (requester only)
router.post(
  "/:id/cancel",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  ctrl.cancel,
);

// POST /engineer-transfers/:id/override  (admin force-complete — `engineer_stock.transfer` required)
router.post(
  "/:id/override",
  requirePermission("engineer_stock.transfer"),
  writeLimiter,
  ctrl.override,
);

// POST /engineer-transfers/:id/acknowledge  (recipient signature)
router.post(
  "/:id/acknowledge",
  requireAnyPermission("engineer.transfer", "engineer_stock.transfer"),
  writeLimiter,
  validateBody(acknowledgeSchema),
  ctrl.acknowledge,
);

export default router;
