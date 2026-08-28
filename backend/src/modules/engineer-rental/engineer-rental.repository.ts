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
 * THE TWO DOORS a hired unit can enter or leave an engineer's custody by.
 *
 * Every production write to `EngineerRentalHolding` goes through `upsertRentalHoldingTx` above or the
 * compare-and-set drain in `hireLoss.service`, and every one of them writes exactly one ledger row —
 * so these five types are the complete set of custody events, and the `type` column is the only place
 * that records WHICH DOOR a unit came through:
 *
 *   JOB door    job_issue  (+, Goods Management scan-out)
 *               job_return (−, Goods Management scan-in)
 *               job_lost   (−, hire loss declared while out with the engineer)
 *   FIELD door  van_restock (+, Field Stock collection)
 *               van_return  (−, Field Stock hand-back)
 *
 * Origin matters because the two pools have different exits. Hired kit taken for a JOB goes back
 * through that job's scan-in or is declared lost against the hire; kit collected through Field Stock
 * goes back through a Field Stock return. Letting job-origin units leave by the Field Stock door
 * drains custody while the job still believes the kit is out.
 *
 * `RENTAL_FIELD_TXN_TYPES` is deliberately the FIELD list rather than the job list: an unrecognised
 * future type then counts as NOT field-origin, so a new door defaults to "not field-returnable" and
 * the invariant fails closed instead of quietly leaking a pool nobody has classified yet.
 */
export const RENTAL_FIELD_TXN_TYPES = ["van_restock", "van_return"] as const;
export const RENTAL_JOB_TXN_TYPES = ["job_issue", "job_return", "job_lost"] as const;

/**
 * FIELD-STOCK-ORIGIN custody per hire for one engineer: `van_restock − van_return`, from the ledger.
 *
 * ONE aggregation, and it is the ledger that answers rather than a second stored counter — the whole
 * point of an append-only custody ledger is that it can be asked this without a new column to keep in
 * step. Verified against live data: for every holding row, `jobNet + fieldNet` equals
 * `quantityOnHand` exactly, and every row's `balanceAfter` matches its own running total, so the two
 * nets are a true partition of what the engineer holds.
 *
 * Keyed on `(purchaseOrderRentalLineId, engineerId)` so it rides the existing compound index — never a
 * scan of one engineer's whole history, and one round trip for however many hires they hold. A hire
 * with no field-door rows is simply ABSENT from the map (read as 0), which is the fail-closed default.
 *
 * The figure is NOT clamped here: this layer reports what the ledger says, and the caller clamps it
 * against the live holding, because custody is what decides how many units are physically there.
 */
export async function findFieldOriginByHires(engineerId: string, purchaseOrderRentalLineIds: string[]): Promise<Map<string, number>> {
  return fieldOriginByHires(prisma, engineerId, purchaseOrderRentalLineIds);
}

/**
 * The same figure, read INSIDE the caller's transaction.
 *
 * Not a convenience: it is what makes the origin rule ENFORCEABLE rather than advisory. The Field
 * Stock return posting drains custody in a transaction whose only quantity guard is the holding's
 * floor, and that floor is on TOTAL custody — job-origin plus field-origin. Read outside the
 * transaction, the field-door figure can be stale by the time the drain happens, and the floor will
 * happily let the shortfall come out of the job's units instead.
 *
 * Reading it here, in the same transaction that writes the drain, closes that: the transaction also
 * updates the holding document, so a concurrent posting that commits first turns this one into a Mongo
 * write conflict rather than letting both spend the same field-origin units.
 */
export async function findFieldOriginByHiresTx(
  tx: Prisma.TransactionClient,
  engineerId: string,
  purchaseOrderRentalLineIds: string[],
): Promise<Map<string, number>> {
  return fieldOriginByHires(tx, engineerId, purchaseOrderRentalLineIds);
}

/** One query, one classification — shared so the tx and non-tx readers can never disagree. */
async function fieldOriginByHires(
  client: Pick<Prisma.TransactionClient, "engineerRentalTransaction">,
  engineerId: string,
  purchaseOrderRentalLineIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (purchaseOrderRentalLineIds.length === 0) return out;
  const rows = await client.engineerRentalTransaction.groupBy({
    by: ["purchaseOrderRentalLineId"],
    where: { engineerId, purchaseOrderRentalLineId: { in: purchaseOrderRentalLineIds }, type: { in: [...RENTAL_FIELD_TXN_TYPES] } },
    _sum: { quantityDelta: true },
  });
  for (const r of rows) out.set(r.purchaseOrderRentalLineId, r._sum.quantityDelta ?? 0);
  return out;
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
export type RentalHoldingWithOrder = EngineerRentalHolding & { purchaseOrderRentalLine: { purchaseOrderId: string } };

export function findRentalHoldingsByEngineer(engineerId: string): Promise<RentalHoldingWithOrder[]> {
  return prisma.engineerRentalHolding.findMany({
    where: { engineerId, quantityOnHand: { gt: 0 } },
    orderBy: [{ hireEndDate: "asc" }, { updatedAt: "desc" }],
    // The ORDER id rides along. Everything else a screen needs about the hire is already snapshotted on
    // the row (`itemName`, `poCode`, `hireEndDate`), but the id is what a hire ACTION has to be
    // addressed to — declaring units lost posts to the order, not to the holding — and resolving it
    // per row afterwards would be a round trip per row on a path that already renders a whole job pack.
    include: { purchaseOrderRentalLine: { select: { purchaseOrderId: true } } },
  });
}

/**
 * Who is holding a given set of hires, in ONE query.
 *
 * Batched for the same reason `findBalanceQuantitiesByEngineers` is: the on-hire register renders a
 * page of hires at a time, and a per-row lookup is a round trip per row on a remote cluster.
 */
export async function findRentalHoldingsByHireLines(
  purchaseOrderRentalLineIds: string[],
): Promise<{ purchaseOrderRentalLineId: string; engineerId: string; engineerName: string; quantityOnHand: number }[]> {
  if (purchaseOrderRentalLineIds.length === 0) return [];
  // The engineer's NAME comes along because every screen that asks who is holding a hire has to show a
  // person, not an id — and resolving them one at a time is the round-trip-per-row this function was
  // batched to avoid in the first place.
  const rows = await prisma.engineerRentalHolding.findMany({
    where: { purchaseOrderRentalLineId: { in: purchaseOrderRentalLineIds }, quantityOnHand: { gt: 0 } },
    select: {
      purchaseOrderRentalLineId: true,
      engineerId: true,
      quantityOnHand: true,
      engineer: { select: { firstName: true, lastName: true } },
    },
  });
  return rows.map((r) => ({
    purchaseOrderRentalLineId: r.purchaseOrderRentalLineId,
    engineerId: r.engineerId,
    engineerName: `${r.engineer?.firstName ?? ""} ${r.engineer?.lastName ?? ""}`.trim() || "Unknown engineer",
    quantityOnHand: r.quantityOnHand,
  }));
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
