import * as inventoryService from "./inventory.service.js";
import * as aggregation from "./aggregation.service.js";
import * as movementService from "./movement.service.js";
import { movementFiltersFrom } from "./movement.service.js";
import { decodeCursor } from "./movement.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { AddStockInput, AdjustStockInput, CreateTransferInput } from "./inventory.validation.js";
import type { Ownership, LocationType, StockPositionStatus } from "./stock-position.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// GET /inventory?search=&warehouse=&irmItem=&category=&status=&page=&pageSize=
export const listInventory = asyncHandler(async (req, res) => {
  const { search, warehouse, irmItem, category, status, page, pageSize } = req.query;
  res.json(
    await inventoryService.listInventory(
      {
        search: str(search),
        warehouse: str(warehouse),
        irmItem: str(irmItem),
        category: str(category),
        status: str(status),
        page: queryInt(page),
        pageSize: queryInt(pageSize),
      },
      actorFrom(req),
    ),
  );
});

// GET /inventory/export.csv?... (same filters as the list)
export const exportInventoryCsv = asyncHandler(async (req, res) => {
  const { search, warehouse, category, status } = req.query;
  const { csv, capped } = await inventoryService.exportInventoryCsv(
    { search: str(search), warehouse: str(warehouse), category: str(category), status: str(status) },
    actorFrom(req),
  );
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="inventory-${date}.csv"`);
  if (capped) res.setHeader("X-Inventory-Export-Capped", "true");
  res.send("﻿" + csv); // UTF-8 BOM so Excel renders accented text correctly
});

// GET /inventory/availability?irmItem=&warehouse=
export const getAvailability = asyncHandler(async (req, res) => {
  res.json(await inventoryService.getAvailability(str(req.query.irmItem) ?? "", str(req.query.warehouse) ?? "", actorFrom(req)));
});

// GET /inventory/transfers (movement history)
export const listTransfers = asyncHandler(async (req, res) => {
  const { search, irmItem, warehouse, page, pageSize } = req.query;
  res.json(await inventoryService.listTransfers({ search: str(search), irmItem: str(irmItem), warehouse: str(warehouse), page: queryInt(page), pageSize: queryInt(pageSize) }, actorFrom(req)));
});

// POST /inventory/transfers (move stock)
export const createTransfer = asyncHandler(async (req, res) => {
  const transfer = await inventoryService.transferStock(req.body as CreateTransferInput, actorFrom(req));
  res.status(201).json({ transfer });
});

// POST /inventory/add-stock (manual add of existing/opening stock)
export const addStock = asyncHandler(async (req, res) => {
  const adjustment = await inventoryService.addStock(req.body as AddStockInput, actorFrom(req));
  res.status(201).json({ adjustment });
});

// POST /inventory/adjust (manual downward correction of existing stock)
export const adjustStock = asyncHandler(async (req, res) => {
  const adjustment = await inventoryService.adjustStock(req.body as AdjustStockInput, actorFrom(req));
  res.status(201).json({ adjustment });
});

// GET /inventory/:id (balance detail)
export const getInventory = asyncHandler(async (req, res) => {
  res.json({ inventory: await inventoryService.getInventory(param(req, "id"), actorFrom(req)) });
});

// GET /inventory/:id/transactions (ledger, paged)
export const listTransactions = asyncHandler(async (req, res) => {
  res.json(await inventoryService.listInventoryTransactions(param(req, "id"), queryInt(req.query.page) ?? 1, queryInt(req.query.pageSize) ?? 20, actorFrom(req)));
});

// GET /inventory/:id/purchases (purchase history, read-only)
export const listPurchases = asyncHandler(async (req, res) => {
  res.json({ purchases: await inventoryService.listPurchaseHistory(param(req, "id"), actorFrom(req)) });
});

// GET /inventory/positions
export const listPositions = asyncHandler(async (req, res) => {
  const q = req.query;
  const result = await aggregation.listStockPositions({
    ownership: q.ownership as Ownership | undefined,
    locationType: q.location as LocationType | undefined,
    warehouseId: q.warehouse as string | undefined,
    categoryName: q.category as string | undefined,
    search: q.search as string | undefined,
    status: q.status as StockPositionStatus | undefined,
    customerId: q.customer as string | undefined,
    page: queryInt(q.page),
    pageSize: queryInt(q.pageSize),
  });
  res.json(result);
});

// GET /inventory/summary
export const getSummary = asyncHandler(async (_req, res) => {
  res.json(await aggregation.getInventorySummary());
});

// GET /inventory/movements — unified Stock Movement History (company-wide).
// ?dateFrom&dateTo&irmItem&warehouse&engineer&customer&ownership&location&type&sourceType&cursor&limit
export const listMovements = asyncHandler(async (req, res) => {
  res.json(
    await movementService.listMovements(
      movementFiltersFrom(req.query),
      decodeCursor(str(req.query.cursor)),
      queryInt(req.query.limit),
    ),
  );
});

// GET /inventory/movements/export.csv — the SAME filtered movement history as a CSV download.
// Same filter params as listMovements (cursor/limit ignored — the export walks the whole filtered set).
export const exportMovementsCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await movementService.exportMovementsCsv(movementFiltersFrom(req.query));
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="stock-movements-${date}.csv"`);
  if (capped) res.setHeader("X-Movement-Export-Capped", "true");
  res.send("﻿" + csv); // UTF-8 BOM so Excel renders accented text correctly
});

// GET /inventory/items/:irmItemId/distribution
export const getItemDistribution = asyncHandler(async (req, res) => {
  const irmItemId = param(req, "irmItemId");
  res.json(await aggregation.getItemDistribution(irmItemId));
});

// GET /inventory/items/:irmItemId/holders
export const getItemHolders = asyncHandler(async (req, res) => {
  const irmItemId = param(req, "irmItemId");
  res.json(await aggregation.getItemHolders(irmItemId));
});

// GET /inventory/items/:irmItemId/jobs
export const getItemJobs = asyncHandler(async (req, res) => {
  const irmItemId = param(req, "irmItemId");
  res.json(await aggregation.getItemJobs(irmItemId));
});

// GET /inventory/positions/export.csv
export const exportAllPositionsCsv = asyncHandler(async (req, res) => {
  const q = req.query;
  const { csv, count } = await aggregation.exportAllPositionsCsv({
    ownership: q.ownership as Ownership | undefined,
    locationType: q.location as LocationType | undefined,
    warehouseId: q.warehouse as string | undefined,
    categoryName: q.category as string | undefined,
    search: q.search as string | undefined,
    status: q.status as StockPositionStatus | undefined,
    customerId: q.customer as string | undefined,
  });
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="all-inventory-${date}.csv"`);
  res.setHeader("X-Inventory-Export-Count", String(count));
  res.send("﻿" + csv); // UTF-8 BOM so Excel renders accented text correctly
});

// GET /inventory/engineers (engineer lens overview)
export const listEngineers = asyncHandler(async (_req, res) => {
  res.json(await aggregation.listEngineerInventory());
});

// GET /inventory/engineers/:engineerId (one engineer's holdings + active jobs)
export const getEngineerInventory = asyncHandler(async (req, res) => {
  res.json(await aggregation.getEngineerInventory(param(req, "engineerId")));
});
