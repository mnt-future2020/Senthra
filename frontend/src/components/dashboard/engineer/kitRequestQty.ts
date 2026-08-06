// Quantity clamping for the kit-request modal.
//
// Extracted from the component because it is pure arithmetic guarding a real mistake: a quantity can
// outlive the availability figure it was typed against — set before the lookup landed, or left
// standing when a refetch comes back smaller — so the modal clamps at READ time rather than writing
// corrected values back into state. That means the box the engineer sees and the payload the planner
// receives are the same number by construction, and neither can be a value the screen calls
// impossible.

/**
 * A requested quantity, clamped to what is actually free.
 *
 * @param qty  what the engineer typed / the job planned
 * @param free how many can actually be sourced, or `null` when there is no figure
 * @param min  the row's own floor — 0 for a planned line, 1 for a cart row (a cart row exists because
 *             the engineer added it, so it can't sit at zero; they remove the row instead)
 *
 * `free === null` stays UNCAPPED by design: misc lines are free text with nothing to run out of, and
 * a failed availability lookup must not cap anyone on a guess (approve() re-checks before stock moves).
 *
 * `free <= 0` returns 0 and **ignores `min`**. That is the whole point of this function existing
 * separately: the obvious `Math.max(min, Math.min(qty, free))` returns 1 for a cart row with nothing
 * free, so a row rendering "None free to request" still shipped a quantity of 1 to the planner. The
 * floor is there to stop a row collapsing to zero while stock exists — not to invent stock that
 * doesn't. A zero here fails the caller's `qty > 0` check and the line drops out of the request.
 */
export function capQty(qty: number, free: number | null, min = 0): number {
  if (free === null) return qty;
  if (free <= 0) return 0;
  return Math.max(min, Math.min(qty, free));
}
