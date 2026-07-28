import { Prisma, type EngineerStockBalance, type EngineerStockTransaction } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";

// Data-access for the engineer-stock primitive: EngineerStockBalance (per-engineer, per-item van
// holdings) + EngineerStockTransaction (append-only ledger). This is shared infrastructure — the
// canonical record of what an engineer is holding in their van — written by the Job Pack issue/return
// flow (goods-management) and engineer-to-engineer transfers, and read by the IRM/User delete-guards.
// The ONLY place Prisma is touched for these two models.

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

// --- engineer-stock primitive (tx-aware writers, used inside the caller's transaction) -------
// Upsert the (item, engineer) balance, applying `delta` (+ credit / − drain). Returns the row AFTER
// the change so the caller can snapshot `balanceAfter` onto the engineer ledger entry.
export async function upsertEngineerBalanceTx(tx: Prisma.TransactionClient, irmItemId: string, engineerId: string, delta: number): Promise<EngineerStockBalance> {
  const bal = await tx.engineerStockBalance.upsert({
    where: { irmItemId_engineerId: { irmItemId, engineerId } },
    create: { irmItemId, engineerId, quantityOnHand: delta },
    update: { quantityOnHand: { increment: delta } },
  });
  // Floor guard — mirrors upsertCustomerHoldingTx / adjustCustomerStockEntryQtyTx. A drain that would
  // take the van below zero rolls the whole transaction back rather than persisting negative stock that
  // then feeds the delete-guards and movement history.
  if (bal.quantityOnHand < 0) throw conflict("Engineer doesn't hold that much of this item. Refresh and try again.");
  return bal;
}
export function findEngineerBalanceTx(tx: Prisma.TransactionClient, irmItemId: string, engineerId: string): Promise<EngineerStockBalance | null> {
  return tx.engineerStockBalance.findUnique({ where: { irmItemId_engineerId: { irmItemId, engineerId } } });
}
// Non-tx read of one engineer's holding of an IRM item — used to cap returns (same source the
// post-return guard checks), so the scan panel's "Held" matches what the server will accept.
export function findEngineerBalance(irmItemId: string, engineerId: string): Promise<EngineerStockBalance | null> {
  return prisma.engineerStockBalance.findUnique({ where: { irmItemId_engineerId: { irmItemId, engineerId } } });
}
export function insertEngineerTxnTx(tx: Prisma.TransactionClient, data: Prisma.EngineerStockTransactionUncheckedCreateInput): Promise<EngineerStockTransaction> {
  return tx.engineerStockTransaction.create({ data });
}

// --- engineer-stock reads --------------------------------------------------------------------
export function findEngineerBalances(engineerId: string) {
  return prisma.engineerStockBalance.findMany({
    where: { engineerId, quantityOnHand: { gt: 0 } },
    include: { irmItem: { select: irmItemSelect } },
    orderBy: { updatedAt: "desc" },
  });
}

// --- delete-guard counters (IRM item / engineer-user can't be deleted while holding stock) ----
export function countEngineerStockWithStockByIrmItem(irmItemId: string): Promise<number> {
  return prisma.engineerStockBalance.count({ where: { irmItemId, quantityOnHand: { gt: 0 } } });
}
// How many distinct items an engineer still HOLDS (quantityOnHand > 0). Used to block
// deactivating an engineer who hasn't returned their stock (User status guard).
export function countEngineerHeldStock(engineerId: string): Promise<number> {
  return prisma.engineerStockBalance.count({ where: { engineerId, quantityOnHand: { gt: 0 } } });
}
// The same question across a group of engineers, in one query. Used to block revoking a ROLE's
// field-operations capability while any of its holders still has stock on the van — the role-level
// mirror of the per-user deactivation guard.
export function countHeldStockForEngineers(engineerIds: string[]): Promise<number> {
  if (engineerIds.length === 0) return Promise.resolve(0);
  return prisma.engineerStockBalance.count({
    where: { engineerId: { in: engineerIds }, quantityOnHand: { gt: 0 } },
  });
}
