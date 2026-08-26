/**
 * Only the two fields the sentence needs.
 *
 * Structural rather than the whole `rentalOutstanding` row on purpose: this formats a phrase, and
 * tying it to the full payload shape would make every field added there a change to every one of this
 * function's test fixtures for no gain.
 */
type OutstandingHire = { itemName: string; qty: number };

/**
 * Name the hired kit that is keeping a job open, for the message that says so.
 *
 * Its own function because three screens ask the same question and all three used to get it wrong in
 * the same way — they read `unaccounted`, found it empty, and reported success. Hired kit never lands
 * in `unaccounted`: it is the provider's equipment, so it is never written off as our loss, and the
 * request succeeds whatever else it wrote. The job simply does not close.
 *
 * QUANTITY FIRST, item second — "2 × Fibre Tester" — matching how the on-hire board and the reconcile
 * refusal that preceded this both phrased it, so the same fact reads the same wherever it appears.
 *
 * Capped, because this goes into a toast: an engineer holding six different hired items would otherwise
 * produce a sentence nobody finishes reading, and the queue row behind it carries the full list anyway.
 */
export function hireList(rows: readonly OutstandingHire[], max = 3): string {
  if (rows.length === 0) return "";
  const named = rows.slice(0, max).map((r) => `${r.qty} × ${r.itemName}`).join(", ");
  const rest = rows.length - max;
  // "and 2 more", never a bare "+2": the sentence has to survive being read aloud down a warehouse
  // phone, which is how most of these get relayed.
  return rest > 0 ? `${named} and ${rest} more` : named;
}
