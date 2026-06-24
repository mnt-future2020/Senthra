import * as inventoryService from "./inventory.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { AddStockInput, CreateTransferInput } from "./inventory.validation.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// GET /inventory?search=&warehouse=&category=&status=&page=&pageSize=
export const listInventory = asyncHandler(async (req, res) => {
  const { search, warehouse, category, status, page, pageSize } = req.query;
  res.json(
    await inventoryService.listInventory(
      {
        search: str(search),
        warehouse: str(warehouse),
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
