import { Router } from "express";

import * as inventoryController from "./inventory.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { addStockSchema, adjustStockSchema, createTransferSchema } from "./inventory.validation.js";

const router = Router();

router.use(requireAuth);

// Static paths first so they aren't captured by "/:id".
router.get("/", requirePermission("inventory.view"), inventoryController.listInventory);
router.get("/export.csv", requirePermission("inventory.export"), exportLimiter, inventoryController.exportInventoryCsv);
router.get("/availability", requirePermission("inventory.view"), inventoryController.getAvailability);
// Reorder workbench: netted per-item×warehouse buy suggestions (warehouse-scoped in the service).
router.get("/reorder-suggestions", requirePermission("inventory.view"), inventoryController.getReorderSuggestions);

// Movement history + the only write (warehouse → warehouse transfer).
router.get("/transfers", requirePermission("inventory.history"), inventoryController.listTransfers);
router.post("/transfers", requirePermission("inventory.move"), writeLimiter, validateBody(createTransferSchema), inventoryController.createTransfer);

// Manual stock add (existing / opening / legacy stock straight into a warehouse).
router.post("/add-stock", requirePermission("inventory.adjust"), writeLimiter, validateBody(addStockSchema), inventoryController.addStock);
// Manual downward correction (damage / shrinkage / miscount) of existing stock.
router.post("/adjust", requirePermission("inventory.adjust"), writeLimiter, validateBody(adjustStockSchema), inventoryController.adjustStock);

// Inventory Hub read endpoints (positions / summary / movements).
// positions/export.csv MUST come before /positions so it isn't parsed as /:id.
router.get("/positions/export.csv", requirePermission("inventory.export"), exportLimiter, inventoryController.exportAllPositionsCsv);
router.get("/positions", requirePermission("inventory.view"), inventoryController.listPositions);
router.get("/summary", requirePermission("inventory.view"), inventoryController.getSummary);
// Static export path before the plain /movements read. Export requires BOTH the history view-right and
// the dedicated export-right, so a role can't download movement data it isn't allowed to view.
router.get("/movements/export.csv", requirePermission("inventory.history"), requirePermission("inventory.export"), exportLimiter, inventoryController.exportMovementsCsv);
router.get("/movements", requirePermission("inventory.history"), inventoryController.listMovements);

// Task 16 — Item-scoped detail endpoints (static /items/... paths before /:id wildcard).
router.get("/items/:irmItemId/distribution", requirePermission("inventory.view"), inventoryController.getItemDistribution);
router.get("/items/:irmItemId/holders", requirePermission("inventory.view"), inventoryController.getItemHolders);
router.get("/items/:irmItemId/jobs", requirePermission("inventory.view"), inventoryController.getItemJobs);

// Engineer lens — engineers overview + one engineer's holdings/jobs (static paths before /:id).
// BEFORE "/engineers/:engineerId" — "engineer-options" is not an engineer id.
router.get("/engineer-options", requirePermission("inventory.view"), inventoryController.listEngineerOptions);
router.get("/engineers", requirePermission("inventory.view"), inventoryController.listEngineers);
router.get("/engineers/:engineerId", requirePermission("inventory.view"), inventoryController.getEngineerInventory);

// Balance detail + its tabs (id = InventoryBalance id).
router.get("/:id", requirePermission("inventory.view"), inventoryController.getInventory);
router.get("/:id/transactions", requirePermission("inventory.view"), inventoryController.listTransactions);
router.get("/:id/purchases", requirePermission("inventory.view"), inventoryController.listPurchases);

export default router;
