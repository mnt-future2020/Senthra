import type { Prisma } from "@prisma/client";

import * as inventoryRepo from "./inventory.repository.js";

// Inventory PRIMITIVES service. Goods In is the first (and, in v1, only) writer: it calls
// `applyInbound` inside its completion transaction to bump on-hand stock + append an immutable
// ledger row. The future Warehouse Inventory / Stock Transfer / Goods Out modules will add
// `applyOutbound` (−delta) + management/reporting on top of these same primitives. There is NO
// inventory UI / route in this module yet.

export interface ApplyInboundInput {
  irmItemId: string;
  warehouseId: string;
  quantity: number; // accepted (good) units only — never includes damaged
  sourceType: string; // "goods_receipt"
  sourceId: string; // e.g. the GRN id
  sourceCode?: string | null; // snapshot, e.g. GRN-0001
  createdBy?: string | null;
  notes?: string | null;
}

// Apply an inbound stock movement INSIDE a transaction: increment the (item, warehouse) balance
// and append one immutable ledger row carrying the post-apply on-hand snapshot. A zero/negative
// quantity is a no-op (e.g. a fully-damaged line contributes nothing to stock).
export async function applyInbound(tx: Prisma.TransactionClient, input: ApplyInboundInput): Promise<void> {
  if (input.quantity <= 0) return;
  const balance = await inventoryRepo.upsertBalanceTx(tx, input.irmItemId, input.warehouseId, input.quantity);
  await inventoryRepo.insertTransactionTx(tx, {
    irmItemId: input.irmItemId,
    warehouseId: input.warehouseId,
    quantityDelta: input.quantity,
    type: "goods_in",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceCode: input.sourceCode ?? null,
    balanceAfter: balance.quantityOnHand,
    notes: input.notes ?? null,
    createdBy: input.createdBy ?? null,
  });
}

// Read helpers — used by the smoke now and the Warehouse Inventory module later.
export function getBalance(irmItemId: string, warehouseId: string) {
  return inventoryRepo.findBalance(irmItemId, warehouseId);
}
export function listBalances(filters: { warehouseId?: string; irmItemId?: string } = {}) {
  return inventoryRepo.listBalances(filters);
}
export function listTransactions(filters: { sourceType?: string; sourceId?: string; irmItemId?: string; warehouseId?: string } = {}) {
  return inventoryRepo.listTransactions(filters);
}
