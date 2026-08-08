// ── "Has this delivery slipped?" — the in-memory half of a mirrored rule ───────────────────────
//
// The same question is asked in two places that CANNOT share an implementation: the badge counts in
// memory (expectedDeliveries loads the open receivable set and splits it), while the list filters in
// Mongo (buildWhere's `overdue` branch). One is JavaScript, the other is a Prisma `where` — so the
// rule exists twice by necessity, and the only defence is to write each half down and test them
// against the same table of cases.
//
// That defence was missing, and the halves drifted in the way Mongo invites: the where clause used
// `confirmedDeliveryDate: null`, which matches only an EXPLICIT null. Nothing writes that field on
// create — recordSupplierAcceptance is the only path that ever sets it — so on every PO still
// awaiting acknowledgement it is ABSENT, and absent is not null. `confirmed ?? expected` below
// handles undefined without noticing; the filter dropped the row. Result: "Deliveries overdue 8"
// opened a list of six, all Supplier Accepted, with the un-acknowledged ones missing.

/**
 * The date the warehouse should plan against.
 *
 * A supplier's CONFIRMED date supersedes the buyer's original expectation once given; until then the
 * expected date stands. Null when neither exists — that PO has no ETA and is neither due nor late.
 */
export function effectiveEta(
  confirmedDeliveryDate: Date | null | undefined,
  expectedDeliveryDate: Date | null | undefined,
): Date | null {
  return confirmedDeliveryDate ?? expectedDeliveryDate ?? null;
}

/**
 * @param dayStart start of today in the COMPANY timezone — never `new Date()`; see filter-date.ts
 *
 * Strictly before the day boundary, matching buildWhere's `lt`: a delivery due TODAY is due, not
 * late. Callers are responsible for restricting to RECEIVABLE_PO_STATUSES; this answers only the date
 * question, exactly as the `where` clause splits status from date.
 */
export function isDeliveryOverdue(
  confirmedDeliveryDate: Date | null | undefined,
  expectedDeliveryDate: Date | null | undefined,
  dayStart: Date,
): boolean {
  const eta = effectiveEta(confirmedDeliveryDate, expectedDeliveryDate);
  return eta != null && eta < dayStart;
}
