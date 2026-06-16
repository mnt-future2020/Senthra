import { Prisma, type InventoryBalance, type InventoryTransaction } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access for the inventory PRIMITIVES (current on-hand balance + immutable ledger).
// Introduced by Goods In; the future Warehouse Inventory module owns/extends them. The
// balance is a maintained running total; the transaction log is append-only (never updated
// or deleted). The tx-aware helpers are used inside the Goods In completion transaction.

// --- balances ---------------------------------------------------------------
export function findBalance(irmItemId: string, warehouseId: string): Promise<InventoryBalance | null> {
  return prisma.inventoryBalance.findUnique({ where: { irmItemId_warehouseId: { irmItemId, warehouseId } } });
}

export function listBalances(filters: { warehouseId?: string; irmItemId?: string } = {}): Promise<InventoryBalance[]> {
  return prisma.inventoryBalance.findMany({
    where: { warehouseId: filters.warehouseId, irmItemId: filters.irmItemId },
    orderBy: { updatedAt: "desc" },
  });
}

// tx-aware: upsert the (item, warehouse) balance, incrementing on-hand by `delta`. Returns the
// row AFTER the change so the caller can snapshot `balanceAfter` onto the ledger entry.
export function upsertBalanceTx(
  tx: Prisma.TransactionClient,
  irmItemId: string,
  warehouseId: string,
  delta: number,
): Promise<InventoryBalance> {
  return tx.inventoryBalance.upsert({
    where: { irmItemId_warehouseId: { irmItemId, warehouseId } },
    create: { irmItemId, warehouseId, quantityOnHand: delta, quantityReserved: 0 },
    update: { quantityOnHand: { increment: delta } },
  });
}

// --- ledger -----------------------------------------------------------------
export function insertTransactionTx(
  tx: Prisma.TransactionClient,
  data: Prisma.InventoryTransactionUncheckedCreateInput,
): Promise<InventoryTransaction> {
  return tx.inventoryTransaction.create({ data });
}

export function listTransactions(filters: { sourceType?: string; sourceId?: string; irmItemId?: string; warehouseId?: string } = {}): Promise<InventoryTransaction[]> {
  return prisma.inventoryTransaction.findMany({
    where: {
      sourceType: filters.sourceType,
      sourceId: filters.sourceId,
      irmItemId: filters.irmItemId,
      warehouseId: filters.warehouseId,
    },
    orderBy: { createdAt: "desc" },
  });
}
