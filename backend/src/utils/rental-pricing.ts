// ── What a hire costs, and on what basis ───────────────────────────────────────────────────────
//
// A rental supplier quotes one of two ways: a single figure for the whole hire ("£2,475 for the
// tester until October"), or a RATE ("£55 a day"). The line used to hold only the first, so a quoted
// rate had to be multiplied out by hand — and the rate itself was never recorded, which left nothing
// to check an invoice against and nothing for an extension to price from.
//
// The rate is an INPUT BASIS, never the stored truth. `unitPricePence` remains the agreed money, for
// the same reason it always was: the purchase order totals, the VAT, the PDF, the CSV and every
// report read it. A price derived at read time by five callers is five chances to disagree.
//
// Everything here is integer pence and whole calendar days. No floating point touches money.

import { daysBetween } from "./calendar-day.js";

export const RATE_PERIODS = ["total", "day", "week", "month"] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];

/** How many days a hire is charged for. The END date is the return day and is not charged. */
export function billableDays(hireStartDate: Date, hireEndDate: Date): number {
  return daysBetween(hireStartDate, hireEndDate);
}

/**
 * Add whole months to a UTC calendar day, CLAMPING to the end of a short month.
 *
 * 31 January + 1 month is 28 February (29 in a leap year), not 3 March. Without the clamp the
 * anniversary walks forward through every short month and the month count comes out low.
 */
function addMonthsUtc(day: Date, months: number): Date {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + months, Math.min(d, lastOfTarget)));
}

/**
 * Whole calendar months in a hire, with any remainder charged as a further whole month.
 *
 * CALENDAR months, not 30-day blocks. `ceil(days / 30)` looks tidier and sits beside the weekly rule,
 * but it bills two months for 1 Jan → 1 Feb — 31 days — and so overcharges by a full month for every
 * 31-day month, which is the commonest hire there is ("we need it for August").
 */
export function billableMonths(hireStartDate: Date, hireEndDate: Date): number {
  if (hireEndDate.getTime() <= hireStartDate.getTime()) return 0;
  let whole = 0;
  while (addMonthsUtc(hireStartDate, whole + 1).getTime() <= hireEndDate.getTime()) whole++;
  // A part month is a whole month, exactly as a part week is a whole week.
  return addMonthsUtc(hireStartDate, whole).getTime() < hireEndDate.getTime() ? whole + 1 : whole;
}

/**
 * How many chargeable periods a hire spans, on a given basis.
 *
 * PART PERIODS ARE CHARGED IN FULL — 10 days on a weekly rate is two weeks, not 1.43. That is the
 * common commercial convention, and it is stated on screen beside the figure so nobody has to infer
 * which rule produced it. `total` is one period by definition: the figure IS the hire.
 */
export function billablePeriods(period: RatePeriod, hireStartDate: Date, hireEndDate: Date): number {
  switch (period) {
    case "day":
      return billableDays(hireStartDate, hireEndDate);
    case "week":
      return Math.ceil(billableDays(hireStartDate, hireEndDate) / 7);
    case "month":
      return billableMonths(hireStartDate, hireEndDate);
    default:
      return 1;
  }
}

/**
 * The price for ONE unit for the whole hire, from a rate.
 *
 * Returns null when it cannot be computed — an unusable basis, a missing rate, or a period that
 * yields nothing. The caller keeps whatever the user agreed rather than storing a zero it invented.
 */
export function calculateUnitPricePence(
  period: RatePeriod,
  ratePence: number | null | undefined,
  hireStartDate: Date,
  hireEndDate: Date,
): number | null {
  if (period === "total") return null;
  if (ratePence == null || !Number.isInteger(ratePence) || ratePence < 0) return null;
  const periods = billablePeriods(period, hireStartDate, hireEndDate);
  if (periods <= 0) return null;
  return ratePence * periods;
}

/** How the basis reads on screen and on the supplier's order — "£55/day × 45 days". */
export function rateBasisLabel(period: RatePeriod, periods: number): string {
  if (period === "total") return "for the whole hire period";
  const noun = period === "day" ? "day" : period === "week" ? "week" : "month";
  return `× ${periods} ${noun}${periods === 1 ? "" : "s"}`;
}

/**
 * What EXTENDING a hire adds, on the rate it was struck at.
 *
 * The whole hire is repriced and the old price subtracted — never the added days priced on their
 * own. On a weekly rate a 10-day hire is two weeks; stretching it to 12 days is still two weeks, so
 * the extension costs nothing. Pricing the two extra days separately would invent a third week.
 *
 * Null when there is nothing to compute from: the `total` basis carries no rate, so what an
 * extension costs is a fresh negotiation rather than arithmetic.
 */
export function extensionChargePence(
  period: RatePeriod,
  ratePence: number | null | undefined,
  hireStartDate: Date,
  oldEndDate: Date,
  newEndDate: Date,
): number | null {
  const before = calculateUnitPricePence(period, ratePence, hireStartDate, oldEndDate);
  const after = calculateUnitPricePence(period, ratePence, hireStartDate, newEndDate);
  if (before == null || after == null) return null;
  // Never negative: shortening a hire is not a credit note, and this codebase does not model one.
  return Math.max(0, after - before);
}
