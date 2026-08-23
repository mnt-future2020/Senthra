import { Prisma, type EngineerRentalHolding, type EngineerRentalTransaction } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";

// Data-access for the engineer RENTAL-CUSTODY primitive: EngineerRentalHolding (what hired kit an
// engineer is physically holding) + EngineerRentalTransaction (append-only ledger). The rental twin
// of engineer-stock.repository.ts, written by the Goods-Management issue/return flow and read by the
// hire register and the engineer/user delete-guards. The ONLY place Prisma is touched for these two
// models.
//
// WHY THE HIRE AND NOT THE CATALOGUE ITEM. Every function here keys on `purchaseOrderRentalLineId`,
// never on `rentalItemId`. Two testers of the same catalogue model can sit on two orders, from two
// providers, with two different return deadlines; collapsed onto the catalogue item they become one
// number belonging to neither deadline, and the module's whole reason for existing — chasing the
// return — loses the thread. `rentalItemId` is carried as a SNAPSHOT for filtering, never as a key.
//
// This is CUSTODY, not inventory. A hire never becomes an InventoryBalance and never reaches the
// reorder engine (see the RentalItem schema comment); nothing here changes that — the reorder engine
// reads InventoryBalance and never this table.

// --- tx-aware writers (used inside the caller's transaction) ----------------------------------

/** Snapshot fields stamped on first write, so an engineer's list renders without the order chain. */
export interface RentalHoldingSnapshot {
  rentalItemId?: string | null;
  itemName: string;
  poCode?: string | null;
  hireEndDate?: Date | null;
}

/**
 * Upsert the (hire, engineer) holding, applying `delta` (+ issue / − return). Returns the row AFTER
 * the change so the caller can snapshot `balanceAfter` onto the ledger entry.
 *
 * The snapshot is written on create and REFRESHED on every update: a hire that gets extended moves
 * its own `hireEndDate`, and an engineer looking at "what am I holding and when is it due" must not
 * be shown the deadline as it stood the day they collected it.
 */
export async function upsertRentalHoldingTx(
  tx: Prisma.TransactionClient,
  purchaseOrderRentalLineId: string,
  engineerId: string,
  delta: number,
  snapshot: RentalHoldingSnapshot,
): Promise<EngineerRentalHolding> {
  const held = await tx.engineerRentalHolding.upsert({
    where: { purchaseOrderRentalLineId_engineerId: { purchaseOrderRentalLineId, engineerId } },
    create: {
      purchaseOrderRentalLineId,
      engineerId,
      quantityOnHand: delta,
      rentalItemId: snapshot.rentalItemId ?? null,
      itemName: snapshot.itemName,
      poCode: snapshot.poCode ?? null,
      hireEndDate: snapshot.hireEndDate ?? null,
    },
    update: {
      quantityOnHand: { increment: delta },
      rentalItemId: snapshot.rentalItemId ?? null,
      itemName: snapshot.itemName,
      poCode: snapshot.poCode ?? null,
      hireEndDate: snapshot.hireEndDate ?? null,
    },
  });
  // Floor guard — mirrors upsertEngineerBalanceTx / upsertCustomerHoldingTx. A return that would take
  // the engineer below zero rolls the whole transaction back rather than persisting a negative
  // custody row that then feeds the delete-guards and the hire register.
  if (held.quantityOnHand < 0) throw conflict("This engineer isn't holding that many of this hire. Refresh and try again.");
  return held;
}

export function findRentalHoldingTx(
  tx: Prisma.TransactionClient,
  purchaseOrderRentalLineId: string,
  engineerId: string,
): Promise<EngineerRentalHolding | null> {
  return tx.engineerRentalHolding.findUnique({
    where: { purchaseOrderRentalLineId_engineerId: { purchaseOrderRentalLineId, engineerId } },
  });
}

/**
 * Non-tx read of one engineer's holding of one hire — used to cap returns, so the scan panel's
 * "Held" figure matches what the server will actually accept.
 */
export function findRentalHolding(purchaseOrderRentalLineId: string, engineerId: string): Promise<EngineerRentalHolding | null> {
  return prisma.engineerRentalHolding.findUnique({
    where: { purchaseOrderRentalLineId_engineerId: { purchaseOrderRentalLineId, engineerId } },
  });
}

export function insertRentalTxnTx(
  tx: Prisma.TransactionClient,
  data: Prisma.EngineerRentalTransactionUncheckedCreateInput,
): Promise<EngineerRentalTransaction> {
  return tx.engineerRentalTransaction.create({ data });
}

/**
 * Push a hire's NEW deadline onto every engineer currently holding units of it.
 *
 * `upsertRentalHoldingTx` above promises the snapshot is "REFRESHED on every update" — but the only
 * thing that calls it is a job scan, so the promise held only for an engineer whose kit happened to
 * move after the hire was extended. Extend a hire on a Friday and the engineer carrying it kept
 * seeing last week's date all weekend: the one screen built to stop a hire running over was quietly
 * showing the deadline it had already passed.
 *
 * `updateMany` because a hire can be split across several engineers, and all of them are now working
 * to the new date. Called INSIDE the extend transaction, so the deadline the engineer sees and the
 * deadline on the order can never disagree — if the extension rolls back, so does this.
 */
export async function refreshHoldingDeadlinesForHireTx(
  tx: Prisma.TransactionClient,
  purchaseOrderRentalLineId: string,
  hireEndDate: Date,
): Promise<number> {
  const res = await tx.engineerRentalHolding.updateMany({
    // Only the rows that still carry units. A holding drained to 0 is history; rewriting its deadline
    // would state that somebody is working to a date for kit they already handed back.
    where: { purchaseOrderRentalLineId, quantityOnHand: { gt: 0 } },
    data: { hireEndDate },
  });
  return res.count;
}

// --- reads -------------------------------------------------------------------------------------

/**
 * Everything one engineer is currently holding on hire. Powers the engineer's own "hired kit"
 * list and the office-side "who has this hire" pane.
 *
 * Ordered by the DEADLINE, not by when it was collected: the only urgent question about hired kit is
 * which piece has to go back first.
 */
export function findRentalHoldingsByEngineer(engineerId: string): Promise<EngineerRentalHolding[]> {
  return prisma.engineerRentalHolding.findMany({
    where: { engineerId, quantityOnHand: { gt: 0 } },
    orderBy: [{ hireEndDate: "asc" }, { updatedAt: "desc" }],
  });
}

/**
 * Who is holding a given set of hires, in ONE query.
 *
 * Batched for the same reason `findBalanceQuantitiesByEngineers` is: the on-hire register renders a
 * page of hires at a time, and a per-row lookup is a round trip per row on a remote cluster.
 */
export function findRentalHoldingsByHireLines(
  purchaseOrderRentalLineIds: string[],
): Promise<{ purchaseOrderRentalLineId: string; engineerId: string; quantityOnHand: number }[]> {
  if (purchaseOrderRentalLineIds.length === 0) return Promise.resolve([]);
  return prisma.engineerRentalHolding.findMany({
    where: { purchaseOrderRentalLineId: { in: purchaseOrderRentalLineIds }, quantityOnHand: { gt: 0 } },
    select: { purchaseOrderRentalLineId: true, engineerId: true, quantityOnHand: true },
  });
}

/** Hired quantities held across MANY engineers, for queue/dashboard roll-ups. One query. */
export function findRentalHoldingQuantitiesByEngineers(
  engineerIds: string[],
): Promise<{ engineerId: string; purchaseOrderRentalLineId: string; rentalItemId: string | null; quantityOnHand: number }[]> {
  if (engineerIds.length === 0) return Promise.resolve([]);
  return prisma.engineerRentalHolding.findMany({
    where: { engineerId: { in: engineerIds }, quantityOnHand: { gt: 0 } },
    select: { engineerId: true, purchaseOrderRentalLineId: true, rentalItemId: true, quantityOnHand: true },
  });
}

// --- delete / deactivate guards ----------------------------------------------------------------

/**
 * How many distinct hires this engineer still holds. Blocks deactivating an engineer who is still
 * carrying kit we do not own — the rental mirror of `countEngineerHeldStock`, and a harder rule than
 * its IRM twin deserves to be read as: unreturned hired kit keeps costing money and is owed to a
 * third party.
 */
export function countHeldRentalsForEngineer(engineerId: string): Promise<number> {
  return prisma.engineerRentalHolding.count({ where: { engineerId, quantityOnHand: { gt: 0 } } });
}

/** The same question across a group of engineers, in one query (role-capability revoke guard). */
export function countHeldRentalsForEngineers(engineerIds: string[]): Promise<number> {
  if (engineerIds.length === 0) return Promise.resolve(0);
  return prisma.engineerRentalHolding.count({
    where: { engineerId: { in: engineerIds }, quantityOnHand: { gt: 0 } },
  });
}

/** Blocks retiring a rental catalogue item while any unit of it is out with an engineer. */
export function countHeldRentalsByRentalItem(rentalItemId: string): Promise<number> {
  return prisma.engineerRentalHolding.count({ where: { rentalItemId, quantityOnHand: { gt: 0 } } });
}
