import { Router } from "express";

import * as controller from "./goods-management.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { postMovementSchema, scanLookupSchema } from "./goods-management.validation.js";

const router = Router();
router.use(requireAuth);

router.get("/queue", requirePermission("goods_management.view"), controller.listQueue);
router.get("/jobs/:jobId", requirePermission("goods_management.view"), controller.getJobGoods);
router.post("/scan-lookup", requirePermission("goods_management.view"), writeLimiter, validateBody(scanLookupSchema), controller.scanLookup);
router.post("/jobs/:jobId/issue", requirePermission("goods_management.issue"), writeLimiter, validateBody(postMovementSchema), controller.postIssue);

export default router;
