// Rental item codes. Isolated from the repository so the formatting rule is unit-testable without
// a database.

/** The Counter key the numeric sequence lives under. Fixed — never derived from a setting. */
export const RENTAL_COUNTER_KEY = "RNT";

/**
 * `RNT-0001`, or whatever prefix Settings carries — `EQP-0001`, `HIRE-0001`.
 *
 * The PREFIX is configurable and the COUNTER KEY above is not, and that asymmetry is the whole point:
 * deriving the key from the setting would restart numbering at 1 the first time anyone changed it,
 * then collide with live codes the moment they changed it back. Existing codes never move either,
 * which is what keeps a barcode already printed and stuck to hired kit readable — the label encodes
 * the code.
 *
 * Padded to four digits and left to GROW past 9999 rather than wrapping: a wrapped code would
 * collide with a live one, and `code` is uniquely indexed, so the create would simply fail.
 */
export function formatRentalCode(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}
