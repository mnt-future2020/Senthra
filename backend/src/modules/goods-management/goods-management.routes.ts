import { Router } from "express";

import * as controller from "./goods-management.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { closeReconcileSchema, postMovementSchema, restoreDamagedSchema, scanLookupSchema, uploadDamagePhotoSchema } from "./goods-management.validation.js";

const router = Router();
router.use(requireAuth);

router.get("/queue", requirePermission("goods_management.view"), controller.listQueue);
// Cross-job demand — gated by inventory.view (planners + warehouse staff have it, like /availability).
router.get("/demand", requirePermission("inventory.view"), controller.getDemand);
router.get("/warehouses/:warehouseId/demand", requirePermission("inventory.view"), controller.getWarehouseDemand);
router.get("/jobs/:jobId", requirePermission("goods_management.view"), controller.getJobGoods);
router.post("/scan-lookup", requirePermission("goods_management.view"), writeLimiter, validateBody(scanLookupSchema), controller.scanLookup);
router.post("/jobs/:jobId/issue", requirePermission("goods_management.issue"), writeLimiter, validateBody(postMovementSchema), controller.postIssue);
router.post("/jobs/:jobId/return", requirePermission("goods_management.receive_return"), writeLimiter, validateBody(postMovementSchema), controller.postReturn);
router.post("/jobs/:jobId/close", requirePermission("goods_management.reconcile"), writeLimiter, validateBody(closeReconcileSchema), controller.closeReconcile);
router.get("/damaged", requirePermission("goods_management.view"), controller.listDamaged);
// Drill-down: every report + restore behind one damaged row (each with its OWN reason and photo).
// Same permission as the list it is opened from — it exposes nothing the list doesn't, just the
// earlier entries the aggregated row can't show. Warehouse-scoped in the service.
router.get("/damaged/history", requirePermission("goods_management.view"), controller.getDamagedHistory);
router.post("/damaged/restore", requirePermission("goods_management.reconcile"), writeLimiter, validateBody(restoreDamagedSchema), controller.restoreDamaged);
router.get("/overdue", requirePermission("goods_management.view"), controller.listOverdue);
router.post("/damage-photo", requirePermission("goods_management.receive_return"), writeLimiter, validateBody(uploadDamagePhotoSchema), controller.uploadDamagePhoto);

export default router;
