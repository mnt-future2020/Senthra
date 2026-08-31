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

// ── "Is this delivery due inside the planning window?" — the other half of the same mirror ─────
//
// `expectedDeliveries` (the "Expected this week" card) splits the open receivable set into ALREADY
// LATE and DUE SOON. The late half is `isDeliveryOverdue` above and the list opens it as
// `?status=overdue`. The soon half had no list at all: the card pointed at `?status=sent`, which is
// one of the three receivable statuses and takes no notice of a date — so a card reading 4 opened a
// list of every sent order, most of them due next month.
//
// Same construction as the overdue pair: this is the in-memory half, buildWhere's `due_this_week`
// branch is the Mongo half, and both are tested against one table of cases.

/** How far ahead "this week" reaches. ONE constant behind the card's count and the list's filter. */
export const EXPECTED_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * The inclusive upper bound of the window: `dayStart` + EXPECTED_WINDOW_DAYS.
 *
 * Inclusive (`<=`), which is what the card has always counted — an order due on the seventh day is
 * in the window, not past it. Exported so the `where` clause bounds itself with the same instant
 * rather than recomputing "+7 days" a second time.
 */
export function expectedWindowEnd(dayStart: Date): Date {
  return new Date(dayStart.getTime() + EXPECTED_WINDOW_DAYS * MS_PER_DAY);
}

/**
 * @param dayStart start of today in the COMPANY timezone — never `new Date()`; see filter-date.ts
 *
 * Due within the window AND not already late: the two halves are disjoint by construction, so an
 * order can never be counted on both the "overdue" and the "expected this week" badge. Callers
 * restrict to RECEIVABLE_PO_STATUSES; this answers only the date question.
 */
export function isDeliveryDueSoon(
  confirmedDeliveryDate: Date | null | undefined,
  expectedDeliveryDate: Date | null | undefined,
  dayStart: Date,
): boolean {
  const eta = effectiveEta(confirmedDeliveryDate, expectedDeliveryDate);
  if (eta == null) return false;
  if (eta > expectedWindowEnd(dayStart)) return false;
  return !(eta < dayStart);
}
