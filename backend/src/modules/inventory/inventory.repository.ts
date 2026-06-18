import { Prisma, type InventoryBalance, type InventoryTransaction, type StockTransfer } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";

// Data-access for the Warehouse Inventory module: the inventory PRIMITIVES (on-hand balance +
// immutable ledger) plus the StockTransfer movement records. The ONLY place Prisma is touched for
// these models. The balance is a maintained running total; the transaction log is append-only
// (insert only — never updated or deleted). Tx-aware helpers run inside the atomic transfer.

// --- balance reads (Warehouse Inventory list / detail) ---------------------------------------
const irmItemSelect = {
  id: true,
  code: true,
  name: true,
  sku: true,
  baseUnit: true,
  status: true,
  reorderLevel: true,
  standardCostPence: true,
  currency: true,
  trackSerialNumbers: true,
  trackBatchNumbers: true,
  trackInventory: true,
  irmCategory: { select: { id: true, name: true } },
} satisfies Prisma.IrmItemSelect;

const warehouseSelect = { id: true, code: true, name: true } satisfies Prisma.WarehouseSelect;

const withBalanceRelations = {
  irmItem: { select: irmItemSelect },
  warehouse: { select: warehouseSelect },
} satisfies Prisma.InventoryBalanceInclude;

export type InventoryBalanceWithRelations = Prisma.InventoryBalanceGetPayload<{ include: typeof withBalanceRelations }>;

export interface InventoryListFilters {
  search?: string;
  warehouseId?: string;
  irmCategoryId?: string;
  outOfStock?: boolean; // quantityOnHand === 0 (the one DB-expressible stock-status filter)
}

function buildBalanceWhere(filters: InventoryListFilters): Prisma.InventoryBalanceWhereInput {
  const irmItemFilter: Prisma.IrmItemWhereInput = { deletedAt: null };
  if (filters.irmCategoryId) irmItemFilter.irmCategoryId = filters.irmCategoryId;
  if (filters.search) {
    irmItemFilter.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { sku: { contains: filters.search, mode: "insensitive" } },
    ];
  }
  const where: Prisma.InventoryBalanceWhereInput = {
    irmItem: { is: irmItemFilter },
    warehouse: { is: { deletedAt: null, ...(filters.warehouseId ? { id: filters.warehouseId } : {}) } },
  };
  if (filters.outOfStock) where.quantityOnHand = 0;
  return where;
}

export function findBalances(filters: InventoryListFilters, skip: number, take: number): Promise<InventoryBalanceWithRelations[]> {
  return prisma.inventoryBalance.findMany({ where: buildBalanceWhere(filters), include: withBalanceRelations, orderBy: { updatedAt: "desc" }, skip, take });
}
export function countBalances(filters: InventoryListFilters): Promise<number> {
  return prisma.inventoryBalance.count({ where: buildBalanceWhere(filters) });
}
// All balances matching the filters (no pagination) — used by the status-filter path (Low/In Stock
// can't be expressed in a Mongo where, so the service computes + paginates) and CSV export.
export function findAllBalances(filters: InventoryListFilters): Promise<InventoryBalanceWithRelations[]> {
  return prisma.inventoryBalance.findMany({ where: buildBalanceWhere(filters), include: withBalanceRelations, orderBy: { updatedAt: "desc" } });
}
export function findBalanceById(id: string): Promise<InventoryBalanceWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.inventoryBalance.findUnique({ where: { id }, include: withBalanceRelations });
}
export function findBalancePair(irmItemId: string, warehouseId: string): Promise<InventoryBalance | null> {
  return prisma.inventoryBalance.findUnique({ where: { irmItemId_warehouseId: { irmItemId, warehouseId } } });
}
export function findBalancePairWithRelations(irmItemId: string, warehouseId: string): Promise<InventoryBalanceWithRelations | null> {
  return prisma.inventoryBalance.findUnique({ where: { irmItemId_warehouseId: { irmItemId, warehouseId } }, include: withBalanceRelations });
}

// --- transaction ledger (Transaction History tab) --------------------------------------------
export function findTransactions(irmItemId: string, warehouseId: string, skip: number, take: number): Promise<InventoryTransaction[]> {
  return prisma.inventoryTransaction.findMany({ where: { irmItemId, warehouseId }, orderBy: { createdAt: "desc" }, skip, take });
}
export function countTransactions(irmItemId: string, warehouseId: string): Promise<number> {
  return prisma.inventoryTransaction.count({ where: { irmItemId, warehouseId } });
}
export function listTransactions(filters: { sourceType?: string; sourceId?: string; irmItemId?: string; warehouseId?: string } = {}): Promise<InventoryTransaction[]> {
  return prisma.inventoryTransaction.findMany({
    where: { sourceType: filters.sourceType, sourceId: filters.sourceId, irmItemId: filters.irmItemId, warehouseId: filters.warehouseId },
    orderBy: { createdAt: "desc" },
  });
}

// --- tx-aware primitive writers (used inside Goods In + the atomic transfer) ------------------
// Upsert the (item, warehouse) balance, applying `delta` (+ inbound / − outbound). Returns the row
// AFTER the change so the caller can snapshot `balanceAfter` onto the ledger entry.
export async function upsertBalanceTx(tx: Prisma.TransactionClient, irmItemId: string, warehouseId: string, delta: number): Promise<InventoryBalance> {
  const balance = await tx.inventoryBalance.upsert({
    where: { irmItemId_warehouseId: { irmItemId, warehouseId } },
    create: { irmItemId, warehouseId, quantityOnHand: delta, quantityReserved: 0 },
    update: { quantityOnHand: { increment: delta } },
  });
  // Hard invariant: on-hand can NEVER go negative. The per-path "available" re-checks
  // catch stale snapshots, but this is the final, atomic backstop — it runs on the
  // post-increment value inside the transaction, so any decrement that would breach
  // zero (incl. a lost concurrent-commit race that the read-then-write checks miss)
  // throws here and rolls the whole movement back. Centralised so every current and
  // future decrement path (Goods Out, transfers, adjustments) is covered.
  if (balance.quantityOnHand < 0) {
    throw conflict("Insufficient stock: this movement would take on-hand below zero. Refresh and try again.");
  }
  return balance;
}
// tx-aware: read a balance inside the transaction (the concurrency-safe source re-read for transfers).
export function findBalancePairTx(tx: Prisma.TransactionClient, irmItemId: string, warehouseId: string): Promise<InventoryBalance | null> {
  return tx.inventoryBalance.findUnique({ where: { irmItemId_warehouseId: { irmItemId, warehouseId } } });
}
export function insertTransactionTx(tx: Prisma.TransactionClient, data: Prisma.InventoryTransactionUncheckedCreateInput): Promise<InventoryTransaction> {
  return tx.inventoryTransaction.create({ data });
}

// --- delete-guard counters (Warehouse / IRM can't be deleted while stock is on-hand) ---------
export function countBalancesWithStockByWarehouse(warehouseId: string): Promise<number> {
  return prisma.inventoryBalance.count({ where: { warehouseId, quantityOnHand: { gt: 0 } } });
}
export function countBalancesWithStockByIrmItem(irmItemId: string): Promise<number> {
  return prisma.inventoryBalance.count({ where: { irmItemId, quantityOnHand: { gt: 0 } } });
}

// --- read helpers (smoke / future Warehouse Inventory features) -------------------------------
export function findBalance(irmItemId: string, warehouseId: string): Promise<InventoryBalance | null> {
  return prisma.inventoryBalance.findUnique({ where: { irmItemId_warehouseId: { irmItemId, warehouseId } } });
}
export function listBalances(filters: { warehouseId?: string; irmItemId?: string } = {}): Promise<InventoryBalance[]> {
  return prisma.inventoryBalance.findMany({ where: { warehouseId: filters.warehouseId, irmItemId: filters.irmItemId }, orderBy: { updatedAt: "desc" } });
}

// --- stock transfers (movement records) ------------------------------------------------------
export interface StockTransferListFilters {
  search?: string;
  irmItemId?: string;
  warehouseId?: string; // matches either from or to
}

function buildTransferWhere(filters: StockTransferListFilters): Prisma.StockTransferWhereInput {
  const and: Prisma.StockTransferWhereInput[] = [{ deletedAt: null }];
  if (filters.irmItemId) and.push({ irmItemId: filters.irmItemId });
  if (filters.warehouseId) and.push({ OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] });
  if (filters.search) {
    const s = filters.search;
    and.push({
      OR: [
        { code: { contains: s, mode: "insensitive" } },
        { itemName: { contains: s, mode: "insensitive" } },
        { sku: { contains: s, mode: "insensitive" } },
        { referenceNumber: { contains: s, mode: "insensitive" } },
        { fromWarehouseName: { contains: s, mode: "insensitive" } },
        { toWarehouseName: { contains: s, mode: "insensitive" } },
      ],
    });
  }
  return { AND: and };
}

export function findTransfers(filters: StockTransferListFilters, skip: number, take: number): Promise<StockTransfer[]> {
  return prisma.stockTransfer.findMany({ where: buildTransferWhere(filters), orderBy: { createdAt: "desc" }, skip, take });
}
export function countTransfers(filters: StockTransferListFilters): Promise<number> {
  return prisma.stockTransfer.count({ where: buildTransferWhere(filters) });
}
export function findTransferById(id: string): Promise<StockTransfer | null> {
  if (!id) return Promise.resolve(null);
  return prisma.stockTransfer.findFirst({ where: { id, deletedAt: null } });
}

// --- TRF code allocation (atomic Counter, prefix "TRF") --------------------------------------
const TRF_CODE_PREFIX = "TRF";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestTransferNumber(): Promise<number> {
  const head = `${TRF_CODE_PREFIX}-`;
  const rows = await prisma.stockTransfer.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: TRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestTransferNumber();
  try {
    await prisma.counter.create({ data: { key: TRF_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: TRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardCounter(): Promise<void> {
  const start = await highestTransferNumber();
  try {
    await prisma.counter.upsert({ where: { key: TRF_CODE_PREFIX }, create: { key: TRF_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort; the next nextSequence() increments anyway */
  }
}

export interface TransferLedgerInputs {
  irmItemId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  createdBy: string | null;
}

// The ATOMIC transfer: re-validate (inside the tx), decrement source, increment destination, write
// two immutable ledger rows, and create the StockTransfer — all in ONE transaction with a unique
// TRF-#### code. Any failure (incl. the in-tx validate) rolls back EVERYTHING. deletedAt: null is
// written EXPLICITLY (Prisma+Mongo `{deletedAt:null}` reads don't match an absent field).
export async function createTransferWithCode(
  header: Omit<Prisma.StockTransferUncheckedCreateInput, "code">,
  ledger: TransferLedgerInputs,
  validate: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<StockTransfer> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${TRF_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        await validate(tx); // concurrency-safe available re-check (throws → full rollback)
        const fromBal = await upsertBalanceTx(tx, ledger.irmItemId, ledger.fromWarehouseId, -ledger.quantity);
        const toBal = await upsertBalanceTx(tx, ledger.irmItemId, ledger.toWarehouseId, ledger.quantity);
        const created = await tx.stockTransfer.create({ data: { deletedAt: null, ...header, code } });
        await insertTransactionTx(tx, {
          irmItemId: ledger.irmItemId, warehouseId: ledger.fromWarehouseId, quantityDelta: -ledger.quantity,
          type: "transfer_out", sourceType: "stock_transfer", sourceId: created.id, sourceCode: code,
          balanceAfter: fromBal.quantityOnHand, createdBy: ledger.createdBy,
        });
        await insertTransactionTx(tx, {
          irmItemId: ledger.irmItemId, warehouseId: ledger.toWarehouseId, quantityDelta: ledger.quantity,
          type: "transfer_in", sourceType: "stock_transfer", sourceId: created.id, sourceCode: code,
          balanceAfter: toBal.quantityOnHand, createdBy: ledger.createdBy,
        });
        return created;
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique stock-transfer code.");
}
