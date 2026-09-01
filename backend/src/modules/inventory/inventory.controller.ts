import type { Request } from "express";

import * as inventoryService from "./inventory.service.js";
import * as aggregation from "./aggregation.service.js";
import * as movementService from "./movement.service.js";
import { movementFiltersFrom } from "./movement.service.js";
import { decodeCursor } from "./movement.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryBool, queryInt, queryStr } from "../../utils/request.js";
import type { AddStockInput, AdjustStockInput, CreateTransferInput } from "./inventory.validation.js";
import type { Ownership, LocationType, PositionFilters, PositionStatusFilter } from "./stock-position.js";


// GET /inventory?search=&warehouse=&irmItem=&category=&status=&page=&pageSize=
//
// The list's filters, parsed ONCE and shared with the CSV export below — the same bargain every
// other module in this codebase makes. It was two literals here, and they had already drifted: the
// export omitted `irmItem`, so a request narrowed to ONE item downloaded every item's balances with
// nothing in the file to say so. That is exactly the failure a shared parser exists to prevent.
function listParamsFrom(req: Request): inventoryService.ListInventoryParams {
  const { search, warehouse, irmItem, category, status } = req.query;
  return {
    search: queryStr(search),
    warehouse: queryStr(warehouse),
    irmItem: queryStr(irmItem),
    category: queryStr(category),
    status: queryStr(status),
  };
}

export const listInventory = asyncHandler(async (req, res) => {
  res.json(
    await inventoryService.listInventory(
      { ...listParamsFrom(req), page: queryInt(req.query.page), pageSize: queryInt(req.query.pageSize) },
      actorFrom(req),
    ),
  );
});

// GET /inventory/reorder-suggestions — the Reorder workbench read (per item × warehouse, netted).
export const getReorderSuggestions = asyncHandler(async (req, res) => {
  res.json(await inventoryService.getReorderSuggestions(actorFrom(req)));
});

// GET /inventory/export.csv?... — the SAME filtered list as a download (paging ignored).
export const exportInventoryCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "inventory", await inventoryService.exportInventoryCsv(listParamsFrom(req), actorFrom(req)));
});

// GET /inventory/availability?irmItem=&warehouse=
export const getAvailability = asyncHandler(async (req, res) => {
  res.json(await inventoryService.getAvailability(queryStr(req.query.irmItem) ?? "", queryStr(req.query.warehouse) ?? "", actorFrom(req)));
});

// GET /inventory/transfers (movement history)
export const listTransfers = asyncHandler(async (req, res) => {
  const { search, irmItem, warehouse, fromWarehouse, toWarehouse, movedFrom, movedTo, page, pageSize } = req.query;
  res.json(
    await inventoryService.listTransfers(
      {
        search: queryStr(search),
        irmItem: queryStr(irmItem),
        warehouse: queryStr(warehouse),
        fromWarehouse: queryStr(fromWarehouse),
        toWarehouse: queryStr(toWarehouse),
        movedFrom: queryStr(movedFrom),
        movedTo: queryStr(movedTo),
        page: queryInt(page),
        pageSize: queryInt(pageSize),
      },
      actorFrom(req),
    ),
  );
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

// The positions filters, parsed ONCE and shared with the CSV export below. Two literals is two
// places for a filter to be forgotten, and a download that quietly holds more rows than the screen
// it was taken from gives no sign of it.
//
// `holderSearch` and `holdingOnly` are the ENGINEER LENS's own two filters (see the field-stock
// export): they narrow by who is holding the stock rather than what it is, which is why they are not
// covered by `search`. The lens itself does not read them from here — it has its own endpoint — but
// its export does, and it must resolve them the same way the lens does.
function positionParamsFrom(req: Request): PositionFilters {
  const q = req.query;
  return {
    ownership: queryStr(q.ownership) as Ownership | undefined,
    locationType: queryStr(q.location) as LocationType | undefined,
    warehouseId: queryStr(q.warehouse),
    categoryName: queryStr(q.category),
    search: queryStr(q.search),
    status: queryStr(q.status) as PositionStatusFilter | undefined,
    customerId: queryStr(q.customer),
    // The engineer lens's own search, forwarded so its download narrows to the engineers on screen.
    // `holding` is deliberately NOT read here: it cannot change which positions exist (see
    // resolveEngineerIds), and reading it dragged the location scope along with it.
    engineerSearch: queryStr(q.engineerSearch),
  };
}

// GET /inventory/positions
export const listPositions = asyncHandler(async (req, res) => {
  // `actorFrom(req)` is what applies the warehouse scope — the same argument the CSV export of this
  // data has always passed. Without it a warehouse-restricted user could read any warehouse's
  // positions, with or without the ?warehouse filter.
  const result = await aggregation.listStockPositions(
    { ...positionParamsFrom(req), page: queryInt(req.query.page), pageSize: queryInt(req.query.pageSize) },
    actorFrom(req),
  );
  res.json(result);
});

// GET /inventory/summary
export const getSummary = asyncHandler(async (_req, res) => {
  res.json(await aggregation.getInventorySummary());
});

// GET /inventory/movements — unified Stock Movement History, narrowed to the caller's warehouse scope.
// ?dateFrom&dateTo&irmItem&warehouse&engineer&customer&ownership&location&type&sourceType&cursor&limit
//
// `actorFrom(req)` is what applies that scope. Without it a warehouse-restricted user could read any
// warehouse's ledger by passing `?warehouse=<other>` — the UI never offers it, but the API is callable
// directly. Every other read in this controller already passed the actor; this one didn't.
export const listMovements = asyncHandler(async (req, res) => {
  res.json(
    await movementService.listMovements(
      movementFiltersFrom(req.query),
      decodeCursor(queryStr(req.query.cursor)),
      queryInt(req.query.limit),
      actorFrom(req),
    ),
  );
});

// GET /inventory/movements/export.csv — the SAME filtered movement history as a CSV download.
// Same filter params as listMovements (cursor/limit ignored — the export walks the whole filtered set).
export const exportMovementsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "stock-movements", await movementService.exportMovementsCsv(movementFiltersFrom(req.query), actorFrom(req)));
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

// GET /inventory/positions/export.csv — the SAME filtered positions as a download (paging ignored).
export const exportAllPositionsCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await aggregation.exportAllPositionsCsv(positionParamsFrom(req), actorFrom(req));
  sendCsv(res, "all-inventory", { csv, capped });
});

// GET /inventory/engineers (engineer lens overview)
// GET /inventory/engineer-options — the COMPLETE field-engineer roster for filter pickers.
//
// Separate from /inventory/engineers, which is the paged LENS. A picker must offer everyone; a list
// must not load everyone. Conflating the two is what capped the pickers at 100.
export const listEngineerOptions = asyncHandler(async (_req, res) => {
  res.json({ engineers: await aggregation.listEngineerOptions() });
});

export const listEngineers = asyncHandler(async (req, res) => {
  // Paged and filterable now — the raw array had no ceiling and no way to narrow it. The response
  // is an OBJECT, so callers that only wanted the whole list read `.rows`.
  res.json(
    await aggregation.listEngineerInventoryPaged({
      search: queryStr(req.query.search),
      // The shared strict parser: `1`/`true` on, `0`/`false` off, anything else "not asked".
      holdingOnly: queryBool(req.query.holding),
      page: queryInt(req.query.page),
      pageSize: queryInt(req.query.pageSize),
    }),
  );
});

// GET /inventory/engineers/:engineerId (one engineer's holdings + active jobs)
export const getEngineerInventory = asyncHandler(async (req, res) => {
  res.json(await aggregation.getEngineerInventory(param(req, "engineerId")));
});
