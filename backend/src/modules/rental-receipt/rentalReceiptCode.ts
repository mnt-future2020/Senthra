// Hire movement note codes. Isolated from the repository so the formatting rule is unit-testable
// without a database — the same split rentalCode.ts and the GRN allocator use.

/** What a note records. One table, because the facts and the evidence are identical either way. */
export const RECEIPT_DIRECTIONS = ["in", "out", "damage"] as const;
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
};

/**
 * `HDN-0001` / `HRN-0001` / `HDM-0001`.
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
