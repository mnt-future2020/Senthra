import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Read-only data access for the Engineer Portal. It READS the shared engineer-stock primitives
// (EngineerStockBalance / EngineerStockTransaction, keyed by engineerId = User.id) — the WRITE path
// stays solely in the Goods Out module. Every query is scoped to one engineerId by the caller.

const irmItemSelect = { id: true, code: true, name: true, baseUnit: true } satisfies Prisma.IrmItemSelect;

export type EngineerBalanceRow = Prisma.EngineerStockBalanceGetPayload<{
  include: { irmItem: { select: typeof irmItemSelect } };
}>;
export type EngineerTxnRow = Prisma.EngineerStockTransactionGetPayload<{
  include: { irmItem: { select: typeof irmItemSelect } };
}>;

// The engineer's CURRENT holdings (on-hand > 0), most-recently-moved first.
export function findBalancesByEngineer(engineerId: string): Promise<EngineerBalanceRow[]> {
  return prisma.engineerStockBalance.findMany({
    where: { engineerId, quantityOnHand: { gt: 0 } },
    include: { irmItem: { select: irmItemSelect } },
    orderBy: { updatedAt: "desc" },
  });
}

// The engineer's recent stock-ledger entries (collected / future usage / return / transfer).
export function findRecentTransactions(engineerId: string, take = 15): Promise<EngineerTxnRow[]> {
  return prisma.engineerStockTransaction.findMany({
    where: { engineerId },
    include: { irmItem: { select: irmItemSelect } },
    orderBy: { createdAt: "desc" },
    take,
  });
}
