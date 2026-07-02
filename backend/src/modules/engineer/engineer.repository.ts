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

// All engineer balances (Inventory Hub aggregation) — across all engineers, non-zero only. Ordered
// newest-first so the item-detail path (which returns raw pool order) is deterministic; the Hub/CSV
// re-sort downstream, so this orderBy is invisible to them.
export function findAllBalances() {
  return prisma.engineerStockBalance.findMany({
    where: { quantityOnHand: { gt: 0 } },
    include: {
      irmItem: { select: { id: true, code: true, name: true, baseUnit: true } },
      engineer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
}

// Engineer van balances for ONE IRM item — the item-scoped slice of findAllBalances above (identical
// where/include/order, plus the irmItemId equality). Index-backed by @@unique([irmItemId, engineerId])
// whose leading key is irmItemId, so the item-detail path reads only this item's rows, not every engineer's.
export function findBalancesByIrmItem(irmItemId: string) {
  return prisma.engineerStockBalance.findMany({
    where: { irmItemId, quantityOnHand: { gt: 0 } },
    include: {
      irmItem: { select: { id: true, code: true, name: true, baseUnit: true } },
      engineer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
}

// ── Stock Movement History — keyset-paginated EngineerStockTransaction page (the engineer-van company leg) ──
export interface EngineerTxnFilters {
  dateFrom?: Date;
  dateTo?: Date;
  irmItemId?: string;
  engineerId?: string;
  type?: string;
  sourceType?: string;
}
export interface MovementKeyset { createdAt: Date; id: string }

export function findEngineerTxnPage(f: EngineerTxnFilters, before: MovementKeyset | null, take: number) {
  const and: Prisma.EngineerStockTransactionWhereInput[] = [];
  if (f.dateFrom) and.push({ createdAt: { gte: f.dateFrom } });
  if (f.dateTo) and.push({ createdAt: { lte: f.dateTo } });
  if (f.irmItemId) and.push({ irmItemId: f.irmItemId });
  if (f.engineerId) and.push({ engineerId: f.engineerId });
  if (f.type) and.push({ type: f.type });
  if (f.sourceType) and.push({ sourceType: f.sourceType });
  if (before) and.push({ OR: [{ createdAt: { lt: before.createdAt } }, { AND: [{ createdAt: before.createdAt }, { id: { lt: before.id } }] }] });
  return prisma.engineerStockTransaction.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    include: { irmItem: { select: { code: true, name: true } } },
  });
}

// Resolve engineer display names by id (the customer-consignment ledger has no engineer relation).
export async function findEngineerNamesByIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true } });
  for (const r of rows) out.set(r.id, [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "Engineer");
  return out;
}

// All active field engineers — for the Inventory Hub "Engineer" lens overview.
export function findEngineers() {
  return prisma.user.findMany({
    where: { deletedAt: null, status: "active", role: { is: { key: "field_engineer" } } },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}
