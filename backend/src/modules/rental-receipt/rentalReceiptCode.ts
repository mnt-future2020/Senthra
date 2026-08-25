// Hire movement note codes. Isolated from the repository so the formatting rule is unit-testable
// without a database — the same split rentalCode.ts and the GRN allocator use.

/** What a note records. One table, because the facts and the evidence are identical either way. */
export const RECEIPT_DIRECTIONS = ["in", "out", "damage", "loss"] as const;
export type ReceiptDirection = (typeof RECEIPT_DIRECTIONS)[number];

/**
 * The Counter key each direction numbers under. Fixed, and NOT settings.
 *
 * Three sequences rather than one, so the code says what the note IS: a delivery note and a return
 * note sitting next to each other as HDN-0007 and HDN-0008 would be two records nobody could tell
 * apart at a glance, and the glance is the whole job of a code.
 */
export const DIRECTION_COUNTER_KEY: Record<ReceiptDirection, string> = {
  in: "HDN", // hire delivery note
  out: "HRN", // hire return note
  damage: "HDM", // hire damage report
  // Equipment that is never coming back, and what the provider is charging to replace it.
  //
  // Its own direction rather than a flavour of `damage`, and the separation is load-bearing. A damage
  // note is about a unit we still have and will hand back; this is about one that is gone. They are
  // capped by different quantities, they settle different records, and a lost unit is deliberately
  // barred from the damage note's cap — so folding the money for one into the document for the other
  // would state on a supplier-facing record that a missing tester was merely broken.
  loss: "HLS", // hire loss settlement
};

/**
 * `HDN-0001` / `HRN-0001` / `HDM-0001` / `HLS-0001`.
 *
 * A fixed prefix, unlike the rental ITEM code: an item code is a label somebody sticks on equipment
 * and reads aloud to a supplier, which is why it is configurable. A note number is internal plumbing
 * that exists so two people can name the same event. GRN does the same.
 *
 * Padded to four digits and left to GROW past 9999 rather than wrapping: a wrapped code would collide
 * with a live one, and `code` is uniquely indexed, so the create would simply fail.
 */
export function formatRentalReceiptCode(direction: ReceiptDirection, seq: number): string {
  return `${DIRECTION_COUNTER_KEY[direction]}-${String(seq).padStart(4, "0")}`;
}
