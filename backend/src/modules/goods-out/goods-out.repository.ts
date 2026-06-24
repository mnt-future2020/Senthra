import { Prisma, type GoodsOut, type EngineerStockBalance, type EngineerStockTransaction } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// Data-access layer for Goods Out (Dispatch). The ONLY place Prisma is touched for goods-out records
// + the engineer-stock primitive (EngineerStockBalance + EngineerStockTransaction). Soft-deleted GDNs
// (deletedAt set) are excluded from normal reads. Header + lines are written atomically; the dispatch
// transaction itself is orchestrated in the service (it also decrements the warehouse via the
// Inventory module), using dispatchTx + the engineer-stock tx writers here.

// --- read slices -----------------------------------------------------------------------------
const warehouseSelect = { id: true, code: true, name: true } satisfies Prisma.WarehouseSelect;

const engineerSelect = { id: true, firstName: true, lastName: true, email: true, employeeId: true } satisfies Prisma.UserSelect;

const irmItemSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  baseUnit: true,
  trackInventory: true,
  trackSerialNumbers: true,
  trackBatchNumbers: true,
} satisfies Prisma.IrmItemSelect;

const withRelations = {
  warehouse: { select: warehouseSelect },
  engineer: { select: engineerSelect },
  items: { orderBy: { createdAt: "asc" }, include: { irmItem: { select: irmItemSelect } } },
} satisfies Prisma.GoodsOutInclude;

export type GoodsOutWithRelations = Prisma.GoodsOutGetPayload<{ include: typeof withRelations }>;

// --- the line row shape the service builds for create / replace ------------------------------
export interface GONLineRow {
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  notes: string | null;
}

function lineCreateData(l: GONLineRow): Prisma.GoodsOutItemUncheckedCreateWithoutGoodsOutInput {
  return { irmItemId: l.irmItemId, itemName: l.itemName, sku: l.sku, baseUnit: l.baseUnit, quantity: l.quantity, notes: l.notes };
}

// --- filters / reads -------------------------------------------------------------------------
export interface GoodsOutListFilters {
  search?: string;
  status?: string;
  warehouseId?: string;
  warehouseIds?: string[];
  engineerId?: string;
}

function buildWhere(filters: GoodsOutListFilters): Prisma.GoodsOutWhereInput {
  const where: Prisma.GoodsOutWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.warehouseId && filters.warehouseIds !== undefined) {
    where.AND = [{ warehouseId: filters.warehouseId }, { warehouseId: { in: filters.warehouseIds } }];
  } else if (filters.warehouseId) {
    where.warehouseId = filters.warehouseId;
  } else if (filters.warehouseIds !== undefined) {
    where.warehouseId = { in: filters.warehouseIds };
  }
  if (filters.engineerId) where.engineerId = filters.engineerId;
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { engineerName: { contains: q, mode: "insensitive" } },
      { engineerEmail: { contains: q, mode: "insensitive" } },
      { warehouseName: { contains: q, mode: "insensitive" } },
      { referenceNumber: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.GoodsOutOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    case "dispatch":
      return { dispatchDate: "desc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(filters: GoodsOutListFilters = {}, skip = 0, take = 20, sort?: string): Promise<GoodsOutWithRelations[]> {
  return prisma.goodsOut.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}
export function count(filters: GoodsOutListFilters = {}): Promise<number> {
  return prisma.goodsOut.count({ where: buildWhere(filters) });
}
export function findById(id: string): Promise<GoodsOutWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.goodsOut.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}
export function findByCode(code: string): Promise<GoodsOutWithRelations | null> {
  return prisma.goodsOut.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}
// tx-aware read for the dispatch transaction — re-reads the GDN (status + live items) INSIDE the tx
// so dispatch never trusts a snapshot taken before the transaction began.
export function findByIdTx(tx: Prisma.TransactionClient, id: string): Promise<GoodsOutWithRelations | null> {
  return tx.goodsOut.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

// --- header / status writes ------------------------------------------------------------------
export function update(id: string, data: Prisma.GoodsOutUncheckedUpdateInput): Promise<GoodsOutWithRelations> {
  return prisma.goodsOut.update({ where: { id }, data, include: withRelations });
}
export function softDelete(id: string): Promise<GoodsOut> {
  return prisma.goodsOut.update({ where: { id }, data: { deletedAt: new Date() } });
}
// tx-aware: mark a GDN dispatched inside the dispatch transaction (alongside the stock movements).
export function dispatchTx(tx: Prisma.TransactionClient, id: string, dispatchedBy: string | null) {
  return tx.goodsOut.update({ where: { id }, data: { status: "dispatched", dispatchedBy, dispatchedAt: new Date() } });
}

// Replace ALL lines + patch the header, atomically (draft edit).
export async function replaceItemsAndChildren(
  id: string,
  lines: GONLineRow[],
  headerPatch: Prisma.GoodsOutUncheckedUpdateInput,
): Promise<GoodsOutWithRelations> {
  return withTransaction(async (tx) => {
    await tx.goodsOutItem.deleteMany({ where: { goodsOutId: id } });
    for (const line of lines) {
      await tx.goodsOutItem.create({ data: { goodsOutId: id, ...lineCreateData(line) } });
    }
    await tx.goodsOut.update({ where: { id }, data: headerPatch });
    return tx.goodsOut.findUniqueOrThrow({ where: { id }, include: withRelations });
  });
}

// --- engineer-stock primitive (tx-aware writers, used inside the dispatch transaction) -------
// Upsert the (item, engineer) balance, applying `delta` (+ on dispatch). Returns the row AFTER the
// change so the caller can snapshot `balanceAfter` onto the engineer ledger entry.
export function upsertEngineerBalanceTx(tx: Prisma.TransactionClient, irmItemId: string, engineerId: string, delta: number): Promise<EngineerStockBalance> {
  return tx.engineerStockBalance.upsert({
    where: { irmItemId_engineerId: { irmItemId, engineerId } },
    create: { irmItemId, engineerId, quantityOnHand: delta },
    update: { quantityOnHand: { increment: delta } },
  });
}
export function findEngineerBalanceTx(tx: Prisma.TransactionClient, irmItemId: string, engineerId: string): Promise<EngineerStockBalance | null> {
  return tx.engineerStockBalance.findUnique({ where: { irmItemId_engineerId: { irmItemId, engineerId } } });
}
export function insertEngineerTxnTx(tx: Prisma.TransactionClient, data: Prisma.EngineerStockTransactionUncheckedCreateInput): Promise<EngineerStockTransaction> {
  return tx.engineerStockTransaction.create({ data });
}

// --- engineer-stock reads (minimal; the future Van Inventory module owns the full surface) ----
export function findEngineerBalances(engineerId: string) {
  return prisma.engineerStockBalance.findMany({
    where: { engineerId, quantityOnHand: { gt: 0 } },
    include: { irmItem: { select: irmItemSelect } },
    orderBy: { updatedAt: "desc" },
  });
}

// --- delete-guard counters (Warehouse / IRM can't be deleted while referenced) ---------------
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.goodsOut.count({ where: { warehouseId, deletedAt: null } });
}
export function countEngineerStockWithStockByIrmItem(irmItemId: string): Promise<number> {
  return prisma.engineerStockBalance.count({ where: { irmItemId, quantityOnHand: { gt: 0 } } });
}
// How many distinct items an engineer still HOLDS (quantityOnHand > 0). Used to block
// deactivating an engineer who hasn't returned their stock (User status guard).
export function countEngineerHeldStock(engineerId: string): Promise<number> {
  return prisma.engineerStockBalance.count({ where: { engineerId, quantityOnHand: { gt: 0 } } });
}

// --- code allocation (atomic Counter, prefix "GDN") -----------------------------------------
const GDN_CODE_PREFIX = "GDN";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestGdnNumber(): Promise<number> {
  const head = `${GDN_CODE_PREFIX}-`;
  const rows = await prisma.goodsOut.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
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
    const c = await prisma.counter.update({ where: { key: GDN_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGdnNumber();
  try {
    await prisma.counter.create({ data: { key: GDN_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: GDN_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardCounter(): Promise<void> {
  const start = await highestGdnNumber();
  try {
    await prisma.counter.upsert({ where: { key: GDN_CODE_PREFIX }, create: { key: GDN_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort; the next nextSequence() increments anyway */
  }
}

// Create a GDN + its lines atomically with a unique GDN-#### code. deletedAt: null is written
// EXPLICITLY — Prisma+Mongo `{deletedAt:null}` reads don't match an absent field, so without this a
// freshly-created GDN would be invisible to findById/list.
export async function createWithCode(
  header: Omit<Prisma.GoodsOutUncheckedCreateInput, "code" | "items">,
  lines: GONLineRow[],
): Promise<GoodsOutWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${GDN_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const gdn = await tx.goodsOut.create({
          data: { deletedAt: null, ...header, code, items: { create: lines.map(lineCreateData) } },
        });
        return tx.goodsOut.findUniqueOrThrow({ where: { id: gdn.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique goods-out code.");
}
