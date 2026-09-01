import { Prisma, type InventoryBalance, type InventoryTransaction, type StockTransfer, type StockAdjustment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";
import { isEmptyWindow, type DayWindow } from "../../utils/filter-date.js";
import { positionStatus } from "./stock-position.js";

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
  // Full reorder policy — the Reorder workbench computes suggestions from these; the extra ints are
  // negligible on the list payloads that share this select.
  reorderLevel: true,
  criticalLevel: true,
  maximumStock: true,
  packSize: true,
  standardCostPence: true,
  currency: true,
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
  irmItemId?: string; // exact item — used by the job kit picker to list only the warehouses holding it
  irmCategoryId?: string;
  outOfStock?: boolean; // quantityOnHand === 0 (the one DB-expressible stock-status filter)
  // Warehouse-access scope: undefined = unrestricted; otherwise constrain to exactly these ids
  // (ANDed with any single `warehouseId` filter — the actor may never see beyond their assigned set).
  warehouseIds?: string[];
  // Reorder workbench only: keep just the rows the reorder maths can ever surface — stock-managed,
  // catalogue-active items. The service discards exactly these rows in JS anyway, so pushing the
  // predicate into the query is behaviour-identical (both fields are non-null with DB defaults) and
  // stops an unfiltered read of the whole item × warehouse cross-product.
  reorderManagedOnly?: boolean;
}

function buildBalanceWhere(filters: InventoryListFilters): Prisma.InventoryBalanceWhereInput {
  const irmItemFilter: Prisma.IrmItemWhereInput = { deletedAt: null };
  if (filters.irmCategoryId) irmItemFilter.irmCategoryId = filters.irmCategoryId;
  if (filters.reorderManagedOnly) {
    irmItemFilter.trackInventory = true;
    irmItemFilter.status = "active";
  }
  if (filters.search) {
    const term = escapeRegex(filters.search);
    irmItemFilter.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { sku: { contains: term, mode: "insensitive" } },
    ];
  }
  const warehouseFilter: Prisma.WarehouseWhereInput = { deletedAt: null };
  if (filters.warehouseId) warehouseFilter.id = filters.warehouseId;
  // Scope `in` is ALWAYS ANDed on top of any single-warehouse filter (combine via `is`).
  if (filters.warehouseIds !== undefined) warehouseFilter.id = { in: filters.warehouseIds, ...(filters.warehouseId ? { equals: filters.warehouseId } : {}) };
  const where: Prisma.InventoryBalanceWhereInput = {
    irmItem: { is: irmItemFilter },
    warehouse: { is: warehouseFilter },
  };
  if (filters.irmItemId) where.irmItemId = filters.irmItemId;
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
// Batch balance lookup for the goods-management queue page — ONE query for many (item, warehouse)
// combos (the caller maps results by `${irmItemId}|${warehouseId}`). Over-fetches the cartesian
// product of the given items × warehouses, which is negligible for a single page of kit lines.
export function findBalancesByItemsAndWarehouses(irmItemIds: string[], warehouseIds: string[]): Promise<InventoryBalance[]> {
  if (irmItemIds.length === 0 || warehouseIds.length === 0) return Promise.resolve([]);
  return prisma.inventoryBalance.findMany({ where: { irmItemId: { in: irmItemIds }, warehouseId: { in: warehouseIds } } });
}
// In-stock (on-hand > 0) balances at ONE warehouse for a live, non-deleted item — powers the walk-in
// composer's default browse list (what the counter can hand out WITHOUT typing a search). Item
// relation included so the caller has code/name/reorder policy in one query; capped by `take`.
export function findInStockBalancesByWarehouse(warehouseId: string, take: number): Promise<InventoryBalanceWithRelations[]> {
  return prisma.inventoryBalance.findMany({
    // Exclude serial/batch-tracked items IN THE QUERY (not just in the caller) so `take` applies AFTER
    // they're filtered out — otherwise a warehouse whose most-recent balances are serial/batch could
    // return a short/empty browse list even with plenty of issuable non-serial stock on the shelf.
    where: { warehouseId, quantityOnHand: { gt: 0 }, irmItem: { is: { deletedAt: null, status: "active" } } },
    include: withBalanceRelations,
    orderBy: { updatedAt: "desc" },
    take,
  });
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

// --- aggregation helpers (Inventory Hub) ---------------------------------------------
export function findAllBalancesForAggregation(filters: { warehouseId?: string } = {}): Promise<InventoryBalanceWithRelations[]> {
  return findAllBalances({ warehouseId: filters.warehouseId });
}
export function findRecentInventoryTransactions(skip: number, take: number) {
  return prisma.inventoryTransaction.findMany({
    orderBy: { createdAt: "desc" }, skip, take,
    include: { irmItem: { select: { code: true, name: true } }, warehouse: { select: { name: true } } },
  });
}

// ── Stock Movement History — keyset-paginated InventoryTransaction page (the warehouse/company leg) ──
// Part of the unified Stock Ledger. The (createdAt DESC, id DESC) keyset gives a stable total order the
// movement service merges across all four delta ledgers; the boundary is the previous page's last row.
export interface MovementLedgerFilters {
  dateFrom?: Date;
  dateTo?: Date;
  irmItemId?: string;
  warehouseId?: string;
  /** The caller's warehouse ACCESS SCOPE — `undefined` is unrestricted, an array constrains to those
   *  warehouses (an empty array correctly matches nothing). Applied ALONGSIDE `warehouseId`, never
   *  instead of it: `warehouseId` is what the user asked for, this is what they're allowed. */
  scopeWarehouseIds?: string[];
  type?: string;
  sourceType?: string;
}
export interface MovementKeyset { createdAt: Date; id: string }

function keysetClause<T extends { OR?: unknown }>(before: MovementKeyset | null): T[] {
  if (!before) return [];
  return [{ OR: [{ createdAt: { lt: before.createdAt } }, { AND: [{ createdAt: before.createdAt }, { id: { lt: before.id } }] }] }] as unknown as T[];
}

export function findInventoryTxnPage(f: MovementLedgerFilters, before: MovementKeyset | null, take: number) {
  const and: Prisma.InventoryTransactionWhereInput[] = [];
  if (f.dateFrom) and.push({ createdAt: { gte: f.dateFrom } });
  if (f.dateTo) and.push({ createdAt: { lte: f.dateTo } });
  if (f.irmItemId) and.push({ irmItemId: f.irmItemId });
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId });
  if (f.scopeWarehouseIds !== undefined) and.push({ warehouseId: { in: f.scopeWarehouseIds } });
  if (f.type) and.push({ type: f.type });
  if (f.sourceType) and.push({ sourceType: f.sourceType });
  and.push(...keysetClause<Prisma.InventoryTransactionWhereInput>(before));
  return prisma.inventoryTransaction.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { irmItem: { select: { code: true, name: true, sku: true } }, warehouse: { select: { name: true } } },
  });
}

// Batch metadata resolvers used by the movement service to enrich ledger rows that carry only ids
// (the customer/damaged ledgers have no item/warehouse relation). One query each, per page.
export async function findIrmMetaByIds(ids: string[]): Promise<Map<string, { code: string; name: string; sku: string | null }>> {
  const out = new Map<string, { code: string; name: string; sku: string | null }>();
  if (!ids.length) return out;
  const rows = await prisma.irmItem.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, sku: true } });
  for (const r of rows) out.set(r.id, { code: r.code, name: r.name, sku: r.sku ?? null });
  return out;
}
export async function findWarehouseNamesByIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await prisma.warehouse.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

// --- stock transfers (movement records) ------------------------------------------------------
export interface StockTransferListFilters {
  search?: string;
  irmItemId?: string;
  warehouseId?: string; // matches either from or to
  /** Source warehouse only. Distinct from `warehouseId`, which matches either end — "what left
   *  London" and "anything London touched" are different questions and the list offers both. */
  fromWarehouseId?: string;
  /** Destination warehouse only. */
  toWarehouseId?: string;
  /** Half-open window on `movementDate` — a CALENDAR DAY, so built with `calendarDayWindow`. */
  movedWindow?: DayWindow;
  // Warehouse-access scope: undefined = unrestricted; otherwise the row must touch (from OR to) an
  // assigned warehouse. ANDed on top of any single-warehouse filter.
  warehouseIds?: string[];
}

function buildTransferWhere(filters: StockTransferListFilters): Prisma.StockTransferWhereInput {
  const and: Prisma.StockTransferWhereInput[] = [{ deletedAt: null }];
  if (filters.irmItemId) and.push({ irmItemId: filters.irmItemId });
  if (filters.warehouseId) and.push({ OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] });
  if (filters.fromWarehouseId) and.push({ fromWarehouseId: filters.fromWarehouseId });
  if (filters.toWarehouseId) and.push({ toWarehouseId: filters.toWarehouseId });
  if (filters.movedWindow && !isEmptyWindow(filters.movedWindow)) and.push({ movementDate: filters.movedWindow });
  if (filters.warehouseIds !== undefined) and.push({ OR: [{ fromWarehouseId: { in: filters.warehouseIds } }, { toWarehouseId: { in: filters.warehouseIds } }] });
  if (filters.search) {
    const s = escapeRegex(filters.search);
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

// --- ADJ code allocation + the atomic manual stock-add (prefix "ADJ") -------------------------
// Mirrors the TRF allocation exactly, against the StockAdjustment table. The counter key "ADJ" is
// its own namespace, independent of the displayed value — numbering never resets.
const ADJ_CODE_PREFIX = "ADJ";

async function highestAdjustmentNumber(): Promise<number> {
  const head = `${ADJ_CODE_PREFIX}-`;
  const rows = await prisma.stockAdjustment.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextAdjustmentSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: ADJ_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestAdjustmentNumber();
  try {
    await prisma.counter.create({ data: { key: ADJ_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: ADJ_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardAdjustmentCounter(): Promise<void> {
  const start = await highestAdjustmentNumber();
  try {
    await prisma.counter.upsert({ where: { key: ADJ_CODE_PREFIX }, create: { key: ADJ_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort; the next nextAdjustmentSequence() increments anyway */
  }
}

export interface StockAdjustmentHeaderInput {
  warehouseId: string;
  reason: string;
  movementDate: Date;
  referenceNumber: string | null;
  notes: string | null;
  createdBy: string | null;
}
export interface StockAdjustmentLedgerInput {
  irmItemId: string;
  warehouseId: string;
  quantity: number; // POSITIVE magnitude
  notes: string | null;
  createdBy: string | null;
}

// The ATOMIC manual add: create the ADJ-#### header, upsert the (item, warehouse) balance (+qty)
// and append ONE "manual_add" ledger row — all in one transaction with a unique code. Any failure
// rolls back EVERYTHING. The upsertBalanceTx zero-floor backstop also runs here.
export async function createStockAdjustmentWithCode(
  header: StockAdjustmentHeaderInput,
  ledger: StockAdjustmentLedgerInput,
): Promise<{ adjustment: StockAdjustment; balanceAfter: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextAdjustmentSequence();
    const code = `${ADJ_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const adjustment = await tx.stockAdjustment.create({ data: { ...header, code } });
        const bal = await upsertBalanceTx(tx, ledger.irmItemId, ledger.warehouseId, ledger.quantity);
        await insertTransactionTx(tx, {
          irmItemId: ledger.irmItemId, warehouseId: ledger.warehouseId, quantityDelta: ledger.quantity,
          type: "manual_add", sourceType: "stock_adjustment", sourceId: adjustment.id, sourceCode: code,
          balanceAfter: bal.quantityOnHand, notes: ledger.notes, createdBy: ledger.createdBy,
        });
        return { adjustment, balanceAfter: bal.quantityOnHand };
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardAdjustmentCounter();
    }
  }
  throw new Error("Could not allocate a unique stock-adjustment code.");
}

// The ATOMIC downward correction (damage / shrinkage / miscount): re-read the balance INSIDE the tx,
// guard available (on-hand − reserved) ≥ qty, create the ADJ-#### header, decrement the balance (−qty)
// and append ONE "manual_adjust" ledger row. `ledger.quantity` is the POSITIVE magnitude to REMOVE.
// Any failure rolls back EVERYTHING; the upsertBalanceTx zero-floor backstop is the final guard.
export async function createNegativeAdjustmentWithCode(
  header: StockAdjustmentHeaderInput,
  ledger: StockAdjustmentLedgerInput,
): Promise<{ adjustment: StockAdjustment; balanceAfter: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextAdjustmentSequence();
    const code = `${ADJ_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const bal = await findBalancePairTx(tx, ledger.irmItemId, ledger.warehouseId);
        const onHand = bal?.quantityOnHand ?? 0;
        const reserved = bal?.quantityReserved ?? 0;
        if (onHand - reserved < ledger.quantity) {
          throw conflict("Not enough available stock to adjust down. Refresh and try again.");
        }
        const adjustment = await tx.stockAdjustment.create({ data: { ...header, code } });
        const updated = await upsertBalanceTx(tx, ledger.irmItemId, ledger.warehouseId, -ledger.quantity);
        await insertTransactionTx(tx, {
          irmItemId: ledger.irmItemId, warehouseId: ledger.warehouseId, quantityDelta: -ledger.quantity,
          type: "manual_adjust", sourceType: "stock_adjustment", sourceId: adjustment.id, sourceCode: code,
          balanceAfter: updated.quantityOnHand, notes: ledger.notes, createdBy: ledger.createdBy,
        });
        return { adjustment, balanceAfter: updated.quantityOnHand };
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardAdjustmentCounter();
    }
  }
  throw new Error("Could not allocate a unique stock-adjustment code.");
}

// --- Dashboard read-model — not a generic reporting API ---

/**
 * Low-stock + critical counts for the Overview KPI.
 *
 * Counts STOCK POSITIONS — one row per item × warehouse — exactly as the Inventory Hub's stock
 * table renders them, through the same `positionStatus` rule. "Low" is `positionStatus !== in_stock`
 * against the item's reorderLevel, i.e. at-or-below the level INCLUDING out of stock, which is what
 * `?status=below_reorder` opens. "Critical" is the same rows tested against criticalLevel, and keeps
 * the `!= null` guard so an item with no critical level set never turns an empty shelf red.
 *
 * IT USED TO COUNT ITEMS, summing on-hand across the scoped warehouses first, and that was wrong in
 * both directions:
 *   • It counted every active tracked item with NO balance row anywhere as out of stock, so for an
 *     unscoped admin the number was dominated by catalogue entries the company has simply never
 *     stocked — none of which any list can show. That is the same defect the attention catalog
 *     records for "Critical stock · 1" opening an empty list.
 *   • Summing across warehouses hid real replenishment work: two depots each three units under the
 *     level netted to "fine", while the Reorder workbench — which applies reorderLevel PER
 *     item|warehouse, as does the stock table and the inventory list — flagged both.
 * Every other surface in this codebase reads reorderLevel as a per-warehouse threshold. This one was
 * the outlier, and the outlier was also the one with no list behind it.
 *
 * The base predicate is `findAllBalancesForAggregation`'s (live item, live warehouse) so the count
 * and the positions list select from the same population. Warehouse-scoped: undefined = all.
 */
export async function lowStockCounts(warehouseIds?: string[]): Promise<{ count: number; criticalCount: number }> {
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      irmItem: { is: { deletedAt: null } },
      warehouse: { is: { deletedAt: null, ...(warehouseIds ? { id: { in: warehouseIds } } : {}) } },
    },
    select: { quantityOnHand: true, irmItem: { select: { reorderLevel: true, criticalLevel: true } } },
  });

  let count = 0;
  let criticalCount = 0;
  for (const b of balances) {
    const qty = b.quantityOnHand ?? 0;
    // low = low_stock OR out_of_stock — the canonical rule, and the one the row badge renders.
    if (positionStatus(qty, b.irmItem?.reorderLevel ?? null) !== "in_stock") count += 1;
    const critical = b.irmItem?.criticalLevel ?? null;
    if (critical != null && qty <= critical) criticalCount += 1;
  }
  return { count, criticalCount };
}
