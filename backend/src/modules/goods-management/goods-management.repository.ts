import { Prisma, type EngineerCustomerStockHolding, type EngineerCustomerStockTransaction, type DamagedStockBalance, type DamagedStockTransaction, type CustomerStockEntry, type JobStockSummary } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";

const GM_CODE_PREFIX = "GM";

const withRelations = {
  items: { include: { irmItem: { select: { id: true, code: true, name: true, baseUnit: true } } } },
  job: { select: { id: true, jobNumber: true, name: true, customerId: true, customerName: true } },
} satisfies Prisma.JobStockMovementInclude;
export type JobStockMovementWithRelations = Prisma.JobStockMovementGetPayload<{ include: typeof withRelations }>;

export interface MovementLineRow {
  source: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  condition: string;
  jobKitLineId: string | null;
  scannedCode: string | null;
  damagePhotoUrl: string | null;
  damageReason: string | null;
  notes: string | null;
}

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
async function highestGmNumber(): Promise<number> {
  const head = `${GM_CODE_PREFIX}-`;
  const rows = await prisma.jobStockMovement.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const s = code.slice(head.length);
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}
async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGmNumber();
  try {
    await prisma.counter.create({ data: { key: GM_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}
async function fastForwardCounter(): Promise<void> {
  const start = await highestGmNumber();
  try {
    await prisma.counter.upsert({ where: { key: GM_CODE_PREFIX }, create: { key: GM_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch { /* best-effort */ }
}

// Create a posted movement + its lines atomically with a unique GM-#### code, running the caller's
// balance/ledger writes inside the SAME transaction via the `apply` callback.
export async function createMovementWithCode(
  header: Omit<Prisma.JobStockMovementUncheckedCreateInput, "code" | "items">,
  lines: MovementLineRow[],
  apply: (tx: Prisma.TransactionClient, movementId: string, code: string) => Promise<void>,
): Promise<JobStockMovementWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${GM_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const m = await tx.jobStockMovement.create({
          data: { deletedAt: null, ...header, code, items: { create: lines.map((l) => ({ ...l })) } },
        });
        await apply(tx, m.id, code);
        return tx.jobStockMovement.findUniqueOrThrow({ where: { id: m.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique goods-management code.");
}

export function findMovementsByJob(jobId: string): Promise<JobStockMovementWithRelations[]> {
  return prisma.jobStockMovement.findMany({ where: { jobId, deletedAt: null }, include: withRelations, orderBy: { createdAt: "asc" } });
}

// --- per-job summary -------------------------------------------------------------------------
export function getSummary(jobId: string): Promise<JobStockSummary | null> {
  return prisma.jobStockSummary.findUnique({ where: { jobId } });
}
export function upsertSummaryTx(tx: Prisma.TransactionClient, jobId: string, data: Prisma.JobStockSummaryUncheckedUpdateInput & { goodsStatus?: string }): Promise<JobStockSummary> {
  return tx.jobStockSummary.upsert({
    where: { jobId },
    create: { jobId, goodsStatus: (data.goodsStatus as string) ?? "not_issued", workSummary: (data.workSummary as string) ?? null, lastMovementAt: new Date() },
    update: { ...data, lastMovementAt: new Date() },
  });
}

// --- engineer customer-stock holding (tx-aware) ----------------------------------------------
export async function upsertCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string, delta: number, snap: { customerId: string | null; customerName?: string | null; itemName: string }): Promise<EngineerCustomerStockHolding> {
  const bal = await tx.engineerCustomerStockHolding.upsert({
    where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } },
    create: { customerStockEntryId, engineerId, quantityOnHand: delta, customerId: snap.customerId, customerName: snap.customerName ?? null, itemName: snap.itemName },
    update: { quantityOnHand: { increment: delta } },
  });
  if (bal.quantityOnHand < 0) throw conflict("Engineer doesn't hold that much of this customer item. Refresh and try again.");
  return bal;
}
export function findCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string): Promise<EngineerCustomerStockHolding | null> {
  return tx.engineerCustomerStockHolding.findUnique({ where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } } });
}
export function insertCustomerHoldingTxnTx(tx: Prisma.TransactionClient, data: Prisma.EngineerCustomerStockTransactionUncheckedCreateInput): Promise<EngineerCustomerStockTransaction> {
  return tx.engineerCustomerStockTransaction.create({ data });
}
export function findCustomerHoldingsByEngineer(engineerId: string) {
  return prisma.engineerCustomerStockHolding.findMany({ where: { engineerId, quantityOnHand: { gt: 0 } }, orderBy: { updatedAt: "desc" } });
}

// --- customer stock entry quantity (warehouse pool) ------------------------------------------
export async function adjustCustomerStockEntryQtyTx(tx: Prisma.TransactionClient, entryId: string, delta: number): Promise<CustomerStockEntry> {
  const e = await tx.customerStockEntry.update({ where: { id: entryId }, data: { quantity: { increment: delta } } });
  if (e.quantity < 0) throw conflict("Insufficient customer stock for this movement. Refresh and try again.");
  return e;
}
export function findCustomerStockEntryById(entryId: string) {
  return prisma.customerStockEntry.findFirst({
    where: { id: entryId, status: "active" },
    include: { customer: { select: { name: true } } },
  });
}
export function findCustomerStockEntryQtyTx(tx: Prisma.TransactionClient, entryId: string) {
  return tx.customerStockEntry.findUnique({ where: { id: entryId }, select: { quantity: true } });
}
export function findCustomerStockEntryByBarcode(barcode: string) {
  return prisma.customerStockEntry.findFirst({ where: { barcode, status: "active" } });
}

// --- damaged pool (tx-aware) -----------------------------------------------------------------
export interface DamagedKey { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null; customerId: string | null; itemName: string; }
export async function upsertDamagedBalanceTx(tx: Prisma.TransactionClient, key: DamagedKey, delta: number): Promise<DamagedStockBalance> {
  // No compound unique (owner mix) — find-or-create by the natural key, then increment.
  const existing = await tx.damagedStockBalance.findFirst({
    where: { warehouseId: key.warehouseId, ownerType: key.ownerType, irmItemId: key.irmItemId, customerStockEntryId: key.customerStockEntryId },
  });
  if (!existing) {
    return tx.damagedStockBalance.create({ data: { ...key, quantity: delta } });
  }
  return tx.damagedStockBalance.update({ where: { id: existing.id }, data: { quantity: { increment: delta } } });
}
export function insertDamagedTxnTx(tx: Prisma.TransactionClient, data: Prisma.DamagedStockTransactionUncheckedCreateInput): Promise<DamagedStockTransaction> {
  return tx.damagedStockTransaction.create({ data });
}
const damagedBalanceInclude = {
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.DamagedStockBalanceInclude;

export type DamagedBalanceWithWarehouse = Prisma.DamagedStockBalanceGetPayload<{
  include: typeof damagedBalanceInclude;
}>;

export function findDamagedByWarehouse(warehouseId: string): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { warehouseId, quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}
export function findDamagedByCustomer(customerId: string): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { customerId, quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}
export function findAllDamaged(): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}

/** Returns the most-recent DamagedStockTransaction for each balance row, keyed by balanceId.
 *  We match on warehouseId + ownerType + irmItemId + customerStockEntryId (the natural key).
 */
export async function findLatestDamagedTxnsByBalances(
  balances: Pick<DamagedBalanceWithWarehouse, "id" | "warehouseId" | "ownerType" | "irmItemId" | "customerStockEntryId">[],
): Promise<Map<string, { reason: string; photoUrl: string | null }>> {
  const result = new Map<string, { reason: string; photoUrl: string | null }>();
  if (balances.length === 0) return result;

  // Fetch the latest transaction per natural key via a single query, then pick the max.
  // We fetch all matching transactions (in practice each balance has few txns) and reduce in-memory.
  const txns = await prisma.damagedStockTransaction.findMany({
    where: {
      OR: balances.map((b) => ({
        warehouseId: b.warehouseId,
        ownerType: b.ownerType,
        irmItemId: b.irmItemId ?? null,
        customerStockEntryId: b.customerStockEntryId ?? null,
      })),
    },
    select: { warehouseId: true, ownerType: true, irmItemId: true, customerStockEntryId: true, reason: true, photoUrl: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Build a lookup: natural-key → latest txn seen (since query is desc, first hit wins).
  const seen = new Set<string>();
  const latestByKey = new Map<string, { reason: string; photoUrl: string | null }>();
  for (const t of txns) {
    const key = `${t.warehouseId}|${t.ownerType}|${t.irmItemId ?? ""}|${t.customerStockEntryId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      latestByKey.set(key, { reason: t.reason, photoUrl: t.photoUrl });
    }
  }

  // Map balanceId → latest txn data.
  for (const b of balances) {
    const key = `${b.warehouseId}|${b.ownerType}|${b.irmItemId ?? ""}|${b.customerStockEntryId ?? ""}`;
    const txn = latestByKey.get(key);
    if (txn) result.set(b.id, txn);
  }

  return result;
}

// --- overdue holdings (jobs whose stock is still out > N days) --------------------------------
export function findRecentMovementsForOverdue(cutoff: Date) {
  return prisma.jobStockMovement.findMany({
    where: { direction: "issue", status: "posted", deletedAt: null, createdAt: { lt: cutoff } },
    include: withRelations,
    orderBy: { createdAt: "asc" },
  });
}
