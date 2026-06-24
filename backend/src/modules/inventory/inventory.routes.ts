import { Router } from "express";

import * as inventoryController from "./inventory.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { addStockSchema, createTransferSchema } from "./inventory.validation.js";

const router = Router();

router.use(requireAuth);

// Static paths first so they aren't captured by "/:id".
router.get("/", requirePermission("inventory.view"), inventoryController.listInventory);
router.get("/export.csv", requirePermission("inventory.export"), inventoryController.exportInventoryCsv);
router.get("/availability", requirePermission("inventory.view"), inventoryController.getAvailability);

// Movement history + the only write (warehouse → warehouse transfer).
router.get("/transfers", requirePermission("inventory.history"), inventoryController.listTransfers);
router.post("/transfers", requirePermission("inventory.move"), writeLimiter, validateBody(createTransferSchema), inventoryController.createTransfer);

// Manual stock add (existing / opening / legacy stock straight into a warehouse).
router.post("/add-stock", requirePermission("inventory.adjust"), writeLimiter, validateBody(addStockSchema), inventoryController.addStock);

// Balance detail + its tabs (id = InventoryBalance id).
router.get("/:id", requirePermission("inventory.view"), inventoryController.getInventory);
router.get("/:id/transactions", requirePermission("inventory.view"), inventoryController.listTransactions);
router.get("/:id/purchases", requirePermission("inventory.view"), inventoryController.listPurchases);

export default router;
