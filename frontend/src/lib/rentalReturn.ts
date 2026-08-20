// ── What the "Back to:" line says beside an address already on screen ──────────────────────────
//
// WHERE a hire is collected from is resolved on the server — `backend/src/modules/purchase-order/
// rentalReturn.ts`, one function shared by the order PDF, the API DTO and every screen — and arrives
// as `{ label, address }`. Nothing here re-resolves it; this is only about how much of that answer a
// DETAIL PAGE needs to repeat.
//
// Printing the resolved address unconditionally put the same string on screen twice: a line with its
// own delivery address showed
//
//     12 Site Road, Leeds
//     Back to: 12 Site Road, Leeds
//
// and a line without one showed the delivery warehouse's full address under the words "Delivery
// warehouse", while the page header already names that warehouse and its address. The address is only
// news when the collection point is somewhere the page has not already said.
//
// The order PDF keeps the full address in every mode: it is read by the supplier who has to send a
// van, "same as above" on paperwork is how the question ended up being settled by phone.
//
// The on-hire list also keeps the full address, and deliberately: there the collection column stands
// on its own — its Delivery neighbour reads "—" whenever the line has no address of its own — so a
// cross-reference would point at nothing.

export interface ReturnLocationView {
  label: string;
  address: string | null;
}

/** The same place typed twice is one place — case, line breaks and repeated spaces don't change it. */
function sameAddress(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The short form of the return leg, for a detail page that already shows the delivery address.
 *
 * Branches in the SAME order as the server's resolver, so an unrecognised mode lands on `delivery`
 * here exactly as it does there — the two must never disagree about which mode they are describing.
 *
 * @param returnMode       the line's stored mode
 * @param returnLocation   what the server resolved it to
 * @param deliveryAddress  the line's own delivery address, as shown directly above this line
 */
export function returnLegSummary(
  returnMode: string,
  returnLocation: ReturnLocationView,
  deliveryAddress: string | null,
): string {
  // "Other" is the one mode that names a place nothing else on the page mentions, so it is the one
  // that prints in full — unless it was typed out as the delivery address again, which is the same
  // place however the mode reads.
  if (returnMode === "other") {
    return sameAddress(returnLocation.address, deliveryAddress)
      ? "same as delivery"
      : (returnLocation.address ?? returnLocation.label);
  }
  // The warehouse's NAME, not its address: the page header states that address in full, and the name
  // is what tells a reader which depot the van is going to.
  if (returnMode === "warehouse") return returnLocation.label;
  // `delivery` means "wherever delivery went" — which is the line directly above this one.
  return "same as delivery";
}
