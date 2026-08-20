// ── Hire pricing rules, mirrored from the server ───────────────────────────────────────────────
//
// The authority is `backend/src/utils/rental-pricing.ts`; every figure a user agrees to is
// recomputed there on save. This copy exists so the screen can show the number BEFORE the round
// trip — a price the user only meets after saving is a price they cannot negotiate against.
//
// The two are tested against the same table of cases (see rentalLineRows.test.ts), because the
// failure mode of a mirror is silence: the form shows £2,475, the server stores £2,585, and nothing
// anywhere says they disagreed.
//
// Dates are "YYYY-MM-DD" calendar days. Money is integer pence.

export const RATE_PERIODS = ["total", "day", "week", "month"] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];

export const RATE_PERIOD_OPTIONS: { value: RatePeriod; label: string }[] = [
  { value: "total", label: "Total for hire period" },
  { value: "day", label: "Per day" },
  { value: "week", label: "Per week" },
  { value: "month", label: "Per month" },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A calendar day as a UTC-midnight timestamp, or null when it isn't one. */
export function dayValue(v: string): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole calendar months, clamping the anniversary into a short month (31 Jan + 1 = 28/29 Feb). */
function monthsBetween(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  const start = new Date(startMs);
  const add = (n: number) => {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth();
    const d = start.getUTCDate();
    const lastOfTarget = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
    return Date.UTC(y, m + n, Math.min(d, lastOfTarget));
  };
  let whole = 0;
  while (add(whole + 1) <= endMs) whole++;
  // A part month is a whole month, exactly as a part week is a whole week.
  return add(whole) < endMs ? whole + 1 : whole;
}

/**
 * How many chargeable periods a hire spans.
 *
 * PART PERIODS BILL IN FULL — 10 days on a weekly rate is two weeks. The rule is stated on screen
 * beside every figure it produces, so nobody has to infer which one was applied.
 */
export function periodsFor(period: RatePeriod, startIso: string, endIso: string): number | null {
  const start = dayValue(startIso);
  const end = dayValue(endIso);
  if (start == null || end == null || end <= start) return null;
  const days = Math.round((end - start) / MS_PER_DAY);
  switch (period) {
    case "day":
      return days;
    case "week":
      return Math.ceil(days / 7);
    case "month":
      return monthsBetween(start, end);
    default:
      return 1;
  }
}

/** The price for ONE unit for the whole hire, in pence — null when the basis or rate gives none. */
export function hirePricePence(
  period: RatePeriod,
  ratePence: number | null | undefined,
  startIso: string,
  endIso: string,
): number | null {
  if (period === "total") return null;
  if (ratePence == null || !Number.isFinite(ratePence) || ratePence < 0) return null;
  const periods = periodsFor(period, startIso, endIso);
  if (periods == null || periods <= 0) return null;
  return Math.round(ratePence) * periods;
}

/**
 * What extending a hire adds, in pence per unit.
 *
 * The whole hire is repriced and the old price subtracted — never the added days priced alone. On a
 * weekly rate a 10-day hire is two weeks; stretching it to 12 days is still two weeks, so the
 * extension costs nothing. Pricing the two extra days on their own would invent a third week.
 */
export function extensionChargePence(
  period: RatePeriod,
  ratePence: number | null | undefined,
  startIso: string,
  oldEndIso: string,
  newEndIso: string,
): number | null {
  const before = hirePricePence(period, ratePence, startIso, oldEndIso);
  const after = hirePricePence(period, ratePence, startIso, newEndIso);
  if (before == null || after == null) return null;
  // Never negative: shortening a hire is not a credit note, and nothing here models one.
  return Math.max(0, after - before);
}
