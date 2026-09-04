import type { AttentionEntityRow } from "@/services/attention.service";

// ── Copy for the "you are about to deactivate a warehouse" confirmation ────────────────────────
//
// Deactivating a warehouse is REVERSIBLE (the same control flips back to Activate), so this dialog
// does not exist to make anyone hesitate — it exists because the consequence is invisible from the
// screen you click on. `requireActiveWarehouse` is asserted from eleven places in the API: both legs
// of a stock transfer, two goods adjustments, three purchase-order receipt/delivery steps, and five
// purchase-request steps including CONVERT. That last one is the reason for the dialog: an already
// approved PRF pointing at a warehouse someone deactivated does not fail now, it fails days later
// when a different person tries to turn it into a PO, with a 409 that names the warehouse but not
// the decision that caused it. Nothing on the warehouse row hints at that.
//
// It is deliberately NOT applied to the reversible deactivates on IRM items, rental items or
// suppliers. Those only drop a record out of the pickers, and a confirmation on every status toggle
// is how people learn to dismiss confirmations without reading them — which spends the attention the
// delete dialogs need.
// Verified against the API rather than assumed, and one clause of the first draft was WRONG:
// goods receipts are not blocked. createGoodsReceipt / completeGoodsReceipt assert warehouse ACCESS
// only, never status, and post inventory through applyInbound, which has no status check either —
// so a delivery already on its way against an issued PO still books in. Saying otherwise would have
// had a warehouse manager chasing a supplier over a delivery that was never at risk. The last
// sentence is the one they actually want, and it is the reassuring half that is true.
export const WAREHOUSE_DEACTIVATE_CONSEQUENCE =
  "New stock movements, purchase requests and purchase orders for this warehouse will be blocked until it is reactivated, including converting an approved purchase request. Deliveries already on their way can still be received.";

/**
 * The awaiting-work sentence, or "" when there is no count worth stating.
 *
 * The count is NOT computed here and no new definition of "awaiting action" was invented for this
 * dialog: it is the row this screen already renders in its "Needs attention here" column, from
 * `useEntityAttention("warehouse")` — the same server-side query, already permission-filtered per
 * actor, already on screen a few pixels away. The dialog and the column must never disagree.
 *
 * Only a POSITIVE count is ever stated. A missing row means "nothing outstanding" under the
 * service's contract, but it is also what an actor without attention permission sees, what is on
 * screen before the first response lands, and what a silently swallowed fetch failure leaves behind
 * (all three by design — see useEntityAttention). Those are indistinguishable here, so the choice is
 * between a number that is sometimes a lie and one sentence less. The consequence is the part that
 * changes the decision anyway; the count only sharpens it.
 */
export function awaitingActionSentence(row: AttentionEntityRow | undefined): string {
  const count = row?.count;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return "";
  return `${count} ${count === 1 ? "item is" : "items are"} awaiting action here.`;
}

/** Everything after "Deactivate <name>? " — the optional count sentence plus the consequence. */
export function warehouseDeactivateDetail(row: AttentionEntityRow | undefined): string {
  const awaiting = awaitingActionSentence(row);
  return awaiting ? `${awaiting} ${WAREHOUSE_DEACTIVATE_CONSEQUENCE}` : WAREHOUSE_DEACTIVATE_CONSEQUENCE;
}
