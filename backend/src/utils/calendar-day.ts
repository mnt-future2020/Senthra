// Calendar-day arithmetic for values that are DATES, not instants — a hire period, a deadline.
//
// ONE helper because a second hand-written copy would eventually disagree with the first, and the
// disagreement is invisible: a duplicate rental line the unique index should have refused, or a
// reminder a day out. Every rental date passes through here before it is stored or compared.
//
// A calendar day is stored as UTC MIDNIGHT of that date — the convention utils/filter-date.ts
// already documents for every date-only field in this app. `startOfDayIn` answers "which calendar
// date is it right now" in the SAME form, so the two compare correctly; storing a timezone-local
// start-of-day instant instead would be "wrong in the opposite direction", which is exactly the
// off-by-a-day that file's comment records.
//
// It also makes the arithmetic exact: UTC midnight to UTC midnight is always n * 86_400_000 ms, so
// a hire spanning a DST change is unaffected. Timezone-local instants would be 23 or 25 hours out
// and a reminder would land on the wrong day.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * UTC midnight of the calendar date in `input`.
 *
 * Throws on anything unparseable rather than returning an Invalid Date: every comparison against
 * one of those is false, so a silently-invalid hire period would read as "never due" — a deadline
 * that never fires is the one failure this whole feature exists to prevent.
 */
export function toCalendarDay(input: string | Date): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${String(input)}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Move a calendar day by whole days. Exact: UTC midnights are always a whole day apart. */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * MS_PER_DAY);
}

/** Whole calendar days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}
