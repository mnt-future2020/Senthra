import { Router } from "express";

import * as controller from "./goods-management.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { scanLookupSchema } from "./goods-management.validation.js";

const router = Router();
router.use(requireAuth);

router.post("/scan-lookup", requirePermission("goods_management.view"), writeLimiter, validateBody(scanLookupSchema), controller.scanLookup);

export default router;
