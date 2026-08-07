// Shortfall summary for a customer's own submission, and the words the portal says it in.
//
// A submission whose warehouse legs are all finished reads "Completed" in the portal even when some
// of what the customer declared never turned up — "completed" means there is no receiving left to
// do, which is true, and is the right word for the status. But on its own it tells the customer
// their stock arrived. This is what says otherwise, next to the chip.
//
// Pure and separate from the view so it can be tested (the frontend suite has no DOM), mirroring
// stockSubmissionFilter.ts on the admin side. The WORDING lives here too, not in the component:
// getting it wrong is what caused the confusion this file exists to prevent, so it belongs
// somewhere a test can hold it still.

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

/**
 * The badge beside the status chip: what ARRIVED, as a fraction of what was submitted.
 *
 * It used to read "23 not received", which put a denial next to a chip saying "Completed" — two
 * halves of one cell contradicting each other, leaving the customer to work out which to believe.
 * They are both true and about different things (the chip is the PROCESS, this is the GOODS), so
 * the fix is to stop phrasing this one as a negative: "Completed · 2 of 25 received" reads as one
 * statement, and nothing has to be un-said.
 *
 * "2 of 25 received" is also the number the customer can act on. The 23 is closed — the account
 * team has already dealt with it — whereas the 2 is what they actually hold and plan around.
 *
 * And it is the wording the rest of this screen already uses: the detail panel prints exactly this
 * per warehouse leg. The badge was the only place speaking differently about the same fact.
 */
export function shortfallBadgeText(short: Pick<Shortfall, "received" | "total">): string {
  return `${short.received} of ${short.total} received`;
}

/**
 * The badge's hover. Carries what the badge no longer says out loud — the missing count — plus the
 * warehouse's reason, so hovering ADDS information rather than repeating the label.
 *
 * "not received", NOT "short". "Short" is warehouse trade language (short shipment, picking short)
 * and the reader is a customer; on its own "23 short" can even parse as an adjective. Unlike
 * "missing" it states the fact without implying a cause, which matters when the commonest cause is
 * that the customer simply shipped fewer than they declared. Nothing was lost; it never arrived.
 * Used verbatim in the detail panel too, so opening a row never renames what the hover just said.
 */
export function shortfallTooltip(short: Pick<Shortfall, "units" | "reasons">): string {
  const missing = `${short.units} not received`;
  return short.reasons.length > 0 ? `${missing} — ${short.reasons.join(" · ")}` : missing;
}
