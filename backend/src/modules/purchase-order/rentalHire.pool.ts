// ── Hire availability and return-binding, shared by every flow that moves hired kit ─────────────
//
// `rentalHire.allocation.ts` next door answers "given these hires, which units come off which" — pure
// arithmetic over rows somebody else fetched. THIS module is the layer above it: it FETCHES the right
// hires for a question and reduces them to the shape a caller needs. It is impure (it reads the
// purchase-order repository) which is exactly why it is a separate file — the allocation maths stays
// unit-testable without a database.
//
// WHY IT EXISTS AT ALL. Goods Management (job scans) and Van Stock Request (Field Stock) both have to
// answer the same two questions about hired equipment, and they must answer them IDENTICALLY:
//
//   "what can this depot hand out today?"     → rentalPoolByItemAndWarehouse
//   "which hire do these returning units go back on?" → pickReturnableHoldings + allocateAcrossHoldings
//
// Two implementations would drift, and the drift is not cosmetic. A Field Stock issue that computed
// availability differently from the job planner would hand out a tester a job had already counted on;
// a return that picked a different hire from the one the issue drew from would credit the wrong
// provider and leave the real hire overdue. One module, one answer, both callers.
//
// The functions here deliberately do NOT filter for the caller. Which hires are even candidates is
// decided by the QUERY (issuable-vs-live is the whole distinction below), so a caller passes the set
// it means and these reduce it — they never widen it back out.

import * as poRepo from "./purchase-order.repository.js";
import { hireIssuable } from "./rentalHire.allocation.js";

/**
 * Free hired units per `${rentalItemId}|${warehouseId}`, summed from the ISSUABLE hires of those items.
 *
 * The rental analogue of `inventoryRepo.findBalancesByItemsAndWarehouses`, and the reason it has to be
 * computed rather than read: a hire has no stock balance row, deliberately. What a depot can hand out
 * is `received − returned − lost − issued`, minus anything reported damaged, totalled across every
 * live hire delivered there — which is precisely `hireIssuable`.
 *
 * One query for the whole page, matching how every other lookup on these paths is batched.
 *
 * `warehouseIds` behaves as it does on the repository call it composes: an empty/absent array means
 * EVERY depot (which the composers want, so they can offer a choice), not a scope of none.
 */
export async function rentalPoolByItemAndWarehouse(
  rentalItemIds: string[],
  warehouseIds: string[],
  // Company-timezone start of today, resolved ONCE by the caller. Present because this pool answers
  // "what can this depot hand out", so an EXPIRED hire does not belong in it however many units of it
  // are physically on the shelf — see `issuableWhere`. Resolving it per call would let a scan posted
  // at 23:59:59.9 judge one line against yesterday and the next against today.
  todayStart: Date,
): Promise<Map<string, number>> {
  const pool = new Map<string, number>();
  if (rentalItemIds.length === 0) return pool;
  for (const h of await poRepo.findIssuableHiresByRentalItems(rentalItemIds, todayStart, warehouseIds)) {
    const key = `${h.rentalItemId}|${h.warehouseId}`;
    pool.set(key, (pool.get(key) ?? 0) + hireIssuable(h));
  }
  return pool;
}

/** The shape both callers' custody rows share. Structural, so neither has to import the other's type. */
export interface ReturnableHolding {
  purchaseOrderRentalLineId: string;
  rentalItemId: string | null;
  quantityOnHand: number;
  hireEndDate: Date | null;
  poCode: string | null;
  itemName: string;
}

/**
 * Which of an engineer's holdings a RETURN of `rentalItemId` at this warehouse may bind to,
 * soonest deadline first.
 *
 * SOONEST FIRST is a real rule, not a tie-break: returning against the most urgent hire first is what
 * gets it off the overdue badge. An UNDATED holding sorts LAST, not first — `?? 0` would put it at the
 * epoch, so a hire with no deadline snapshot would beat every real one and always be the hire picked.
 *
 * NARROWED TO THIS DEPOT, because custody rows carry no warehouse of their own (see the model). An
 * engineer can hold the same tester on hires from two depots — an ordinary state, each collected
 * against its own request — and picking purely by deadline then binds the scan to the OTHER depot's
 * hire, which the posting guard refuses with no second option to scan. `liveHireIdsHere` is the
 * caller's already-fetched set of hires live AT the receiving warehouse.
 *
 * THE FALLBACK offers exactly ONE holding when none is live here, and that asymmetry is deliberate.
 * Kit already in someone's hands has to be able to come back whatever happened to the paperwork
 * behind it, and such a hire may no longer appear in the live set at all. A holding whose hire is not
 * live here may well belong to another depot, and the posting guard refuses precisely that — so
 * listing the whole set would stage rows that can only fail on Post, which is worse than the single
 * row that at least stands a chance of being the right one.
 */
export function pickReturnableHoldings<T extends ReturnableHolding>(
  holdings: readonly T[],
  rentalItemId: string,
  liveHireIdsHere: ReadonlySet<string>,
): T[] {
  const forThisItem = holdings
    .filter((h) => h.rentalItemId === rentalItemId && h.quantityOnHand > 0)
    .sort((a, b) => (a.hireEndDate?.getTime() ?? Infinity) - (b.hireEndDate?.getTime() ?? Infinity));
  const here = forThisItem.filter((h) => liveHireIdsHere.has(h.purchaseOrderRentalLineId));
  return here.length > 0 ? here : forThisItem.slice(0, 1);
}

/** One holding, and how many of the returning units go back on its hire. */
export interface HoldingAllocation<T> {
  holding: T;
  qty: number;
}

/**
 * Spend `budget` returning units across the given holdings, in the order they are handed over
 * (`pickReturnableHoldings` has already put the soonest deadline first).
 *
 * Each allocation is capped at the HOLDING it names, never at everything the engineer holds of the
 * item: a posting commits to exactly one hire per row, so offering the global figure against one hire
 * lets a warehouse type 5 and the post then reject at 3 with no explanation — the remaining 2 belong
 * to a different order.
 *
 * And the SUM is capped at `budget`, which is the other half of the same rule. Two hires holding 3
 * each against a line that owes 3 must offer 3, not 6; the running budget is what makes a panel free
 * to stage every row it is given without the till refusing the surplus.
 */
export function allocateAcrossHoldings<T extends { quantityOnHand: number }>(
  holdings: readonly T[],
  budget: number,
): HoldingAllocation<T>[] {
  const out: HoldingAllocation<T>[] = [];
  let left = Math.max(0, budget);
  for (const holding of holdings) {
    const qty = Math.min(holding.quantityOnHand, left);
    if (qty <= 0) break; // holdings are already `quantityOnHand > 0`, so this is the budget running out
    left -= qty;
    out.push({ holding, qty });
  }
  return out;
}
