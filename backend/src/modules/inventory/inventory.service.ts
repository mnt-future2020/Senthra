import type { Prisma, InventoryTransaction, StockTransfer } from "@prisma/client";

import * as inventoryRepo from "./inventory.repository.js";
import type { InventoryBalanceWithRelations } from "./inventory.repository.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type { AddStockInput, CreateTransferInput } from "./inventory.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const EXPORT_MAX = 50_000;

// ── Inventory primitives (Goods In writes inbound; future Goods Out writes outbound) ──────────
export interface ApplyMovementInput {
  irmItemId: string;
  warehouseId: string;
  quantity: number; // POSITIVE magnitude
  sourceType: string;
  sourceId: string;
  sourceCode?: string | null;
  createdBy?: string | null;
  notes?: string | null;
}

async function applyDelta(tx: Prisma.TransactionClient, input: ApplyMovementInput, type: string, sign: 1 | -1): Promise<void> {
  if (input.quantity <= 0) return;
  const delta = sign * input.quantity;
  const balance = await inventoryRepo.upsertBalanceTx(tx, input.irmItemId, input.warehouseId, delta);
  await inventoryRepo.insertTransactionTx(tx, {
    irmItemId: input.irmItemId,
    warehouseId: input.warehouseId,
    quantityDelta: delta,
    type,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceCode: input.sourceCode ?? null,
    balanceAfter: balance.quantityOnHand,
    notes: input.notes ?? null,
    createdBy: input.createdBy ?? null,
  });
}

// Inbound (Goods In). Kept unchanged for the Goods In completion transaction.
export function applyInbound(tx: Prisma.TransactionClient, input: ApplyMovementInput): Promise<void> {
  return applyDelta(tx, input, "goods_in", 1);
}
// Outbound seam for FUTURE Goods Out / dispatch (not wired to any endpoint yet).
export function applyOutbound(tx: Prisma.TransactionClient, input: ApplyMovementInput): Promise<void> {
  return applyDelta(tx, input, "goods_out", -1);
}

// Read helpers (smoke + tooling).
export function getBalance(irmItemId: string, warehouseId: string) {
  return inventoryRepo.findBalance(irmItemId, warehouseId);
}
export function listTransactions(filters: { sourceType?: string; sourceId?: string; irmItemId?: string; warehouseId?: string } = {}) {
  return inventoryRepo.listTransactions(filters);
}

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────
export type InventoryStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface PublicInventoryBalance {
  id: string;
  irmItemId: string;
  warehouseId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  categoryName: string | null;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number | null;
  unitCostPence: number;
  valuePence: number;
  value: number;
  currency: string;
  status: InventoryStatus;
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  lastMovementAt: string;
}

export interface PublicInventoryDetail extends PublicInventoryBalance {
  incoming: number;
  outgoing: number;
}

export interface PublicInventoryTransaction {
  id: string;
  date: string;
  type: string;
  quantityDelta: number;
  balanceAfter: number;
  warehouseName: string;
  reference: string | null;
  notes: string | null;
  createdBy: string | null;
}

export interface PublicPurchaseHistoryRow {
  grnCode: string;
  poCode: string | null;
  supplierName: string | null;
  receivedQuantity: number;
  receivedDate: string;
}

export interface PublicStockTransfer {
  id: string;
  code: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  fromWarehouseId: string;
  fromWarehouseName: string;
  fromWarehouseCode: string | null;
  toWarehouseId: string;
  toWarehouseName: string;
  toWarehouseCode: string | null;
  quantity: number;
  movementDate: string;
  status: string;
  referenceNumber: string | null;
  description: string | null;
  internalNotes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface PublicStockAdjustment {
  id: string;
  code: string;
  warehouseId: string;
  warehouseName: string;
  irmItemId: string;
  itemName: string;
  quantity: number;
  balanceAfter: number;
  reason: string;
  movementDate: string;
  referenceNumber: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.trunc(n), lo), hi);

function statusOf(onHand: number, reorderLevel: number | null): InventoryStatus {
  if (onHand === 0) return "out_of_stock";
  if (onHand <= (reorderLevel ?? 0)) return "low_stock";
  return "in_stock";
}

function toBalanceDTO(b: InventoryBalanceWithRelations): PublicInventoryBalance {
  const onHand = b.quantityOnHand;
  const reserved = b.quantityReserved;
  const unitCostPence = b.irmItem.standardCostPence ?? 0;
  const valuePence = onHand * unitCostPence;
  return {
    id: b.id,
    irmItemId: b.irmItemId,
    warehouseId: b.warehouseId,
    itemCode: b.irmItem.code,
    itemName: b.irmItem.name,
    sku: b.irmItem.sku,
    baseUnit: b.irmItem.baseUnit,
    categoryName: b.irmItem.irmCategory?.name ?? null,
    warehouseName: b.warehouse.name,
    warehouseCode: b.warehouse.code,
    onHand,
    reserved,
    available: onHand - reserved, // server-authoritative
    reorderLevel: b.irmItem.reorderLevel,
    unitCostPence,
    valuePence,
    value: valuePence / 100,
    currency: b.irmItem.currency ?? "GBP",
    status: statusOf(onHand, b.irmItem.reorderLevel),
    trackSerialNumbers: b.irmItem.trackSerialNumbers,
    trackBatchNumbers: b.irmItem.trackBatchNumbers,
    lastMovementAt: b.updatedAt.toISOString(), // the balance only changes on a movement
  };
}

function toTransferDTO(t: StockTransfer): PublicStockTransfer {
  return {
    id: t.id,
    code: t.code,
    irmItemId: t.irmItemId,
    itemName: t.itemName,
    sku: t.sku,
    fromWarehouseId: t.fromWarehouseId,
    fromWarehouseName: t.fromWarehouseName,
    fromWarehouseCode: t.fromWarehouseCode,
    toWarehouseId: t.toWarehouseId,
    toWarehouseName: t.toWarehouseName,
    toWarehouseCode: t.toWarehouseCode,
    quantity: t.quantity,
    movementDate: t.movementDate.toISOString(),
    status: t.status ?? "completed",
    referenceNumber: t.referenceNumber,
    description: t.description,
    internalNotes: t.internalNotes,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

// ── Inventory list (search / filters / status / pagination / total value) ──────────────────────
export interface ListInventoryParams {
  search?: string;
  warehouse?: string;
  irmItem?: string; // exact item id — restricts the result to that item's per-warehouse balances
  category?: string;
  status?: string; // in_stock | low_stock | out_of_stock
  page?: number;
  pageSize?: number;
}

export interface PagedInventory {
  inventory: PublicInventoryBalance[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalValuePence: number;
  totalValue: number;
}

// All filtered balance DTOs (warehouse/category/search at the DB; status computed in-service because
// `onHand ≤ irmItem.reorderLevel` is a cross-document comparison Mongo can't express in a `where`).
// Bounded by items×warehouses; the result is paginated/serialised by the callers.
async function filteredBalanceDTOs(params: ListInventoryParams, actor?: AuditActor): Promise<PublicInventoryBalance[]> {
  const rows = await inventoryRepo.findAllBalances({
    search: params.search?.trim() || undefined,
    warehouseId: params.warehouse,
    irmItemId: params.irmItem,
    irmCategoryId: params.category,
    warehouseIds: warehouseScopeFilter(actor),
  });
  const status = params.status && ["in_stock", "low_stock", "out_of_stock"].includes(params.status) ? (params.status as InventoryStatus) : undefined;
  const dtos = rows.map(toBalanceDTO);
  return status ? dtos.filter((d) => d.status === status) : dtos;
}

export async function listInventory(params: ListInventoryParams = {}, actor?: AuditActor): Promise<PagedInventory> {
  const pageSize = clamp(params.pageSize ?? 20, 1, 100);
  const all = await filteredBalanceDTOs(params, actor);
  const total = all.length;
  const totalValuePence = all.reduce((s, d) => s + d.valuePence, 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(params.page ?? 1, 1, totalPages);
  const inventory = all.slice((page - 1) * pageSize, page * pageSize);
  return { inventory, total, page, pageSize, totalPages, totalValuePence, totalValue: totalValuePence / 100 };
}

async function loadBalanceOrThrow(balanceId: string): Promise<InventoryBalanceWithRelations> {
  const b = OBJECT_ID_RE.test(balanceId) ? await inventoryRepo.findBalanceById(balanceId) : null;
  if (!b) throw notFound("Inventory record not found.");
  return b;
}

export async function getInventory(balanceId: string, actor?: AuditActor): Promise<PublicInventoryDetail> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  const dto = toBalanceDTO(b);
  const incoming = await poService.incomingForItemWarehouse(b.irmItemId, b.warehouseId);
  return { ...dto, incoming, outgoing: b.quantityReserved };
}

export interface PagedTransactions {
  transactions: PublicInventoryTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listInventoryTransactions(balanceId: string, page = 1, pageSize = 20, actor?: AuditActor): Promise<PagedTransactions> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  const size = clamp(pageSize, 1, 100);
  const total = await inventoryRepo.countTransactions(b.irmItemId, b.warehouseId);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = clamp(page, 1, totalPages);
  const rows = await inventoryRepo.findTransactions(b.irmItemId, b.warehouseId, (p - 1) * size, size);
  const toTx = (t: InventoryTransaction): PublicInventoryTransaction => ({
    id: t.id,
    date: t.createdAt.toISOString(),
    type: t.type,
    quantityDelta: t.quantityDelta,
    balanceAfter: t.balanceAfter,
    warehouseName: b.warehouse.name,
    reference: t.sourceCode,
    notes: t.notes,
    createdBy: t.createdBy,
  });
  return { transactions: rows.map(toTx), total, page: p, pageSize: size, totalPages };
}

export async function listPurchaseHistory(balanceId: string, actor?: AuditActor): Promise<PublicPurchaseHistoryRow[]> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  const rows = await grnRepo.receivedHistoryForItemWarehouse(b.irmItemId, b.warehouseId);
  return rows.map((r) => ({
    grnCode: r.goodsReceipt.code,
    poCode: r.goodsReceipt.poCode,
    supplierName: r.goodsReceipt.supplierName,
    receivedQuantity: r.receivedQuantity,
    receivedDate: r.goodsReceipt.receivedDate.toISOString(),
  }));
}

export interface AvailabilityResult {
  irmItemId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  available: number;
}
export async function getAvailability(irmItemId: string, warehouseId: string, actor?: AuditActor): Promise<AvailabilityResult> {
  if (!OBJECT_ID_RE.test(irmItemId) || !OBJECT_ID_RE.test(warehouseId)) throw badRequest("Select an item and warehouse.");
  assertWarehouseAccess(actor, warehouseId);
  const b = await inventoryRepo.findBalancePair(irmItemId, warehouseId);
  const onHand = b?.quantityOnHand ?? 0;
  const reserved = b?.quantityReserved ?? 0;
  return { irmItemId, warehouseId, onHand, reserved, available: onHand - reserved };
}

// ── Stock transfer (warehouse → warehouse, atomic) ─────────────────────────────────────────────
export async function transferStock(input: CreateTransferInput, actor?: AuditActor): Promise<PublicStockTransfer> {
  if (input.fromWarehouseId === input.toWarehouseId) throw badRequest("Source and destination warehouses must be different.");
  if (input.quantity <= 0) throw badRequest("Quantity must be greater than zero.");

  const fromWh = await warehouseService.requireActiveWarehouse(input.fromWarehouseId);
  const toWh = await warehouseService.requireActiveWarehouse(input.toWarehouseId);
  // A scoped user must own BOTH ends of the move (assert on the resolved canonical ids).
  assertWarehouseAccess(actor, fromWh.id);
  assertWarehouseAccess(actor, toWh.id);

  const source = await inventoryRepo.findBalancePairWithRelations(input.irmItemId, input.fromWarehouseId);
  if (!source) throw conflict("There is no stock of this item at the source warehouse.");
  const item = source.irmItem;
  if (item.trackSerialNumbers || item.trackBatchNumbers) {
    throw conflict("Serial-tracked and batch-tracked items can't be transferred yet — serial-level transfer is a future feature.");
  }
  const available = source.quantityOnHand - source.quantityReserved;
  if (input.quantity > available) throw conflict(`Only ${available} available at ${fromWh.name}. Reduce the quantity.`);

  const actorEmail = actor?.email ?? null;
  const transfer = await inventoryRepo.createTransferWithCode(
    {
      irmItemId: input.irmItemId,
      itemName: item.name,
      sku: item.sku,
      fromWarehouseId: input.fromWarehouseId,
      fromWarehouseName: fromWh.name,
      fromWarehouseCode: fromWh.code,
      toWarehouseId: input.toWarehouseId,
      toWarehouseName: toWh.name,
      toWarehouseCode: toWh.code,
      quantity: input.quantity,
      movementDate: new Date(input.movementDate),
      status: "completed",
      referenceNumber: trimToNull(input.referenceNumber),
      description: trimToNull(input.description),
      internalNotes: trimToNull(input.internalNotes),
      createdBy: actorEmail,
    },
    { irmItemId: input.irmItemId, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, quantity: input.quantity, createdBy: actorEmail },
    // Concurrency backstop: re-read the LIVE source balance inside the transaction and re-check
    // available. Throwing here rolls back the whole transfer (balances + ledger + record).
    async (tx) => {
      const live = await inventoryRepo.findBalancePairTx(tx, input.irmItemId, input.fromWarehouseId);
      const liveAvail = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
      if (input.quantity > liveAvail) throw conflict("Source stock changed — not enough available to complete the transfer.");
    },
  );
  // Audit AFTER commit, fire-and-forget: a logging failure must never roll back a real stock move.
  audit.record({ actor, action: "inventory.transfer", targetType: "stock_transfer", targetId: transfer.id, targetLabel: transfer.code });
  return toTransferDTO(transfer);
}

// ── Manual stock add (existing / opening / legacy stock straight into a warehouse) ─────────────
// Inbound-only. Validates the item is active + inventory-tracked (and not serial/batch-tracked —
// those must come through Goods In), then atomically creates an ADJ-#### header, increments the
// (item, warehouse) balance and writes ONE "manual_add" ledger row.
export async function addStock(input: AddStockInput, actor?: AuditActor): Promise<PublicStockAdjustment> {
  if (input.quantity <= 0) throw badRequest("Quantity must be greater than zero.");

  const item = await irmService.requireActiveIrmItem(input.irmItemId);
  if (item.trackInventory === false) throw badRequest(`${item.name} isn't inventory-tracked, so stock can't be added for it.`);
  if (item.trackSerialNumbers || item.trackBatchNumbers) {
    throw conflict("Serial- and batch-tracked items can't be added this way yet — receive them via Goods In.");
  }
  const wh = await warehouseService.requireActiveWarehouse(input.warehouseId);
  assertWarehouseAccess(actor, wh.id);
  const actorEmail = actor?.email ?? null;
  const notes = trimToNull(input.notes);

  const { adjustment, balanceAfter } = await inventoryRepo.createStockAdjustmentWithCode(
    {
      warehouseId: input.warehouseId,
      reason: input.reason,
      movementDate: new Date(input.movementDate),
      referenceNumber: trimToNull(input.referenceNumber),
      notes,
      createdBy: actorEmail,
    },
    { irmItemId: input.irmItemId, warehouseId: input.warehouseId, quantity: input.quantity, notes, createdBy: actorEmail },
  );

  // Audit AFTER commit, fire-and-forget — a logging failure must never roll back a real stock add.
  audit.record({
    actor,
    action: "inventory.stock_added",
    targetType: "stock_adjustment",
    targetId: adjustment.id,
    targetLabel: `${adjustment.code} · +${input.quantity} ${item.name} @ ${wh.name}`,
  });

  return {
    id: adjustment.id,
    code: adjustment.code,
    warehouseId: input.warehouseId,
    warehouseName: wh.name,
    irmItemId: input.irmItemId,
    itemName: item.name,
    quantity: input.quantity,
    balanceAfter,
    reason: adjustment.reason,
    movementDate: adjustment.movementDate.toISOString(),
    referenceNumber: adjustment.referenceNumber,
    notes: adjustment.notes,
    createdBy: adjustment.createdBy,
    createdAt: adjustment.createdAt.toISOString(),
  };
}

// ── Movement history (transfers) ───────────────────────────────────────────────────────────────
export interface ListTransfersParams {
  search?: string;
  irmItem?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
}
export interface PagedTransfers {
  transfers: PublicStockTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function listTransfers(params: ListTransfersParams = {}, actor?: AuditActor): Promise<PagedTransfers> {
  const pageSize = clamp(params.pageSize ?? 20, 1, 100);
  const filters = { search: params.search?.trim() || undefined, irmItemId: params.irmItem, warehouseId: params.warehouse, warehouseIds: warehouseScopeFilter(actor) };
  const total = await inventoryRepo.countTransfers(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(params.page ?? 1, 1, totalPages);
  const rows = await inventoryRepo.findTransfers(filters, (page - 1) * pageSize, pageSize);
  return { transfers: rows.map(toTransferDTO), total, page, pageSize, totalPages };
}

// ── CSV export ────────────────────────────────────────────────────────────────────────────────
// Formula-injection-safe cell escaping (mirrors the audit module): user-controlled values (item
// names, SKUs) starting with =,+,-,@,tab,CR are neutralised, then RFC-4180 quoted.
function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface InventoryCsvResult {
  csv: string;
  count: number;
  capped: boolean;
}

export async function exportInventoryCsv(params: ListInventoryParams = {}, actor?: AuditActor): Promise<InventoryCsvResult> {
  const all = await filteredBalanceDTOs(params, actor);
  const rows = all.slice(0, EXPORT_MAX);
  const header = ["Item Code", "Item", "SKU", "Warehouse", "Category", "Unit", "On Hand", "Reserved", "Available", "Value (GBP)", "Last Movement (UTC)", "Status"];
  const lines = [header.map(csvEscape).join(",")];
  for (const d of rows) {
    lines.push(
      [
        d.itemCode,
        d.itemName,
        d.sku ?? "",
        `${d.warehouseName} (${d.warehouseCode})`,
        d.categoryName ?? "",
        d.baseUnit ?? "",
        String(d.onHand),
        String(d.reserved),
        String(d.available),
        d.value.toFixed(2),
        d.lastMovementAt,
        d.status,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  // Audit the deliberate data extraction (NOT per page view — see plan §9).
  audit.record({ actor, action: "inventory.viewed", targetType: "inventory", targetLabel: `${rows.length} rows` });
  return { csv: lines.join("\r\n"), count: rows.length, capped: all.length > EXPORT_MAX };
}
