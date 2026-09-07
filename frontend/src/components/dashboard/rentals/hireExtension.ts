// ── The Extend dialog's date rule, mirrored from the server ─────────────────────────────────────
//
// The authority is `extendHire` in `backend/src/modules/purchase-order/purchase-order.service.ts`,
// which refuses any new end date that is not strictly AFTER the current one. This copy exists so
// the refusal lands on the field being typed into rather than as a toast after a round trip — and
// so the picker itself stops offering the one date the server is guaranteed to reject.
//
// Hire dates arrive as UTC midnights (the server normalises every one), so calendar-day arithmetic
// here is exact, DST included. Nothing in this rule compares against "today", so there is no
// client/server timezone skew to reconcile — it is two stored days against each other.
//
// The day arithmetic is `dayValue` from `lib/rentalPricing`, NOT a copy of it. This file briefly
// carried its own byte-identical version, which is the failure this whole module is written to
// avoid: the dialog prices the extension with `extensionChargePence` out of that same module, so
// two implementations of "which calendar day is this" would sit inside one form. Correct one of
// them — to reject a non-ISO string, say, which `Date.parse` otherwise resolves in LOCAL time — and
// the floor the picker enforces would quietly stop agreeing with the charge printed beneath it.

import { dayValue } from "@/lib/rentalPricing";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the calendar date, or null when it isn't one. Null-safe over `dayValue`. */
const calendarDay = (iso: string | null | undefined): number | null => (iso ? dayValue(iso) : null);

/**
 * The earliest date the picker may offer: the day AFTER the current end.
 *
 * `min` used to be the current end date itself, which let the browser accept the single value the
 * server always rejects — the picker said yes, the save said no, and the offending number was the
 * very date the dialog had just printed as "currently ends".
 *
 * "" when there is no usable end date, so the caller drops the attribute rather than pinning the
 * picker to an Invalid Date.
 */
export function earliestExtensionDay(currentEndIso: string | null | undefined): string {
  const end = calendarDay(currentEndIso);
  if (end == null) return "";
  return new Date(end + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * What is wrong with the chosen date — null when nothing is.
 *
 * The wording is copied from `extendHireSchema` and `extendHire` deliberately: one refusal that can
 * reach a user twice (here, then from the API if they get past this) must not read as two different
 * problems.
 *
 * A `min` on the input is a hint to the picker, not a rule — a typed date, a stale tab or a direct
 * API call all ignore it — which is why this is checked again on submit and, authoritatively, on
 * the server.
 */
export function extensionDateProblem(
  currentEndIso: string | null | undefined,
  newEndIso: string,
): string | null {
  if (!newEndIso) return "Select a new hire end date.";
  const next = calendarDay(newEndIso);
  if (next == null) return "Enter a valid date.";
  const end = calendarDay(currentEndIso);
  // No end date to compare against is not this dialog's problem to report: the server holds the
  // stored one and remains the check that cannot be skipped.
  if (end == null) return null;
  if (next <= end) return "The new hire end date must be after the current end date.";
  return null;
}
