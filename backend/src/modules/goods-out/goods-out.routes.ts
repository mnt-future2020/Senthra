import { Router } from "express";

import * as goodsOutController from "./goods-out.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { cancelGoodsOutSchema, createGoodsOutSchema, updateGoodsOutSchema } from "./goods-out.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("goods_out.view"), goodsOutController.listGoodsOut);
router.get("/:id", requirePermission("goods_out.view"), goodsOutController.getGoodsOut);

router.post("/", requirePermission("goods_out.create"), writeLimiter, validateBody(createGoodsOutSchema), goodsOutController.createGoodsOut);
router.patch("/:id", requirePermission("goods_out.edit"), writeLimiter, validateBody(updateGoodsOutSchema), goodsOutController.updateGoodsOut);
router.delete("/:id", requirePermission("goods_out.delete"), writeLimiter, goodsOutController.deleteGoodsOut);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/dispatch", requirePermission("goods_out.dispatch"), writeLimiter, goodsOutController.dispatchGoodsOut);
router.post("/:id/cancel", requirePermission("goods_out.cancel"), writeLimiter, validateBody(cancelGoodsOutSchema), goodsOutController.cancelGoodsOut);

export default router;
