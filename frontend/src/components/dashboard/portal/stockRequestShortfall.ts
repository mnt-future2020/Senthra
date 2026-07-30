// Shortfall summary for a customer's own submission.
//
// A submission whose warehouse legs are all finished reads "Completed" in the portal even when some
// of what the customer declared never turned up — "completed" means there is no receiving left to
// do, which is true, and is the right word for the status. But on its own it tells the customer
// their stock arrived. This is the line that says otherwise, next to the chip.
//
// Pure and separate from the view so it can be tested (the frontend suite has no DOM), mirroring
// stockSubmissionFilter.ts on the admin side.

import type { PortalWarehouseAssignment } from "@/types/customer";

export interface Shortfall {
  /** Units declared but never received, totalled across every short-closed leg. Always > 0. */
  units: number;
  /** Units that DID arrive, across every leg — not just the short-closed ones. Reported alongside
   *  `units` so the reader is never left subtracting one number in the status column from another
   *  in the quantity column to work out what they actually have. */
  received: number;
  /** Units assigned to warehouses across every leg. Equal to the submission's own quantity: the
   *  server rejects an assignment whose parts don't add up to it (assignStockRequestWarehouses). */
  total: number;
  /** Distinct closure reasons in leg order — a submission split across warehouses can have more
   *  than one, and de-duplicating keeps the common "same reason twice" case readable. */
  reasons: string[];
}

// Only `closed_short` legs count TOWARDS THE SHORTFALL. A leg still open is not a shortfall — the
// stock may yet arrive, and saying "3 not received" about a delivery still in transit would be
// wrong. `received` and `total`, by contrast, span every leg: they describe the whole submission.
export function summariseShortfall(
  assignments: readonly Pick<PortalWarehouseAssignment, "status" | "quantity" | "receivedQuantity" | "closureReason">[],
): Shortfall | null {
  let units = 0;
  let received = 0;
  let total = 0;
  const reasons: string[] = [];

  for (const a of assignments) {
    total += a.quantity;
    received += a.receivedQuantity;
    if (a.status !== "closed_short") continue;
    // Guard the subtraction: a leg that somehow received MORE than assigned would otherwise
    // subtract from the total and understate a genuine shortfall elsewhere in the submission.
    units += Math.max(0, a.quantity - a.receivedQuantity);
    const reason = a.closureReason?.trim();
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }

  // A leg closed short with nothing outstanding (closed at the moment the last unit landed) is not
  // something to report — there is no missing stock to explain.
  if (units === 0) return null;
  return { units, received, total, reasons };
}
