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

/**
 * A calendar day somebody CHOSE, resolved to an instant — for the fields that store instants.
 *
 * `HireCustodyExit.declaredAt` is an instant, and a damage report carries a day picked on a form.
 * Putting the day in raw is where the off-by-a-day lives: a calendar day is UTC midnight, and UTC
 * midnight rendered in the viewer's own zone is the DAY BEFORE for anyone behind UTC. That is the
 * hazard `lib/formatDate.ts` warns about, and a field holding a mix of real instants and smuggled-in
 * calendar days cannot be rendered correctly by either formatter.
 *
 * So:
 *  - the day it is NOW keeps the real instant — the ordinary case, and the one where the time of day
 *    is true and worth keeping: records on one day settle oldest-first, and midnight would flatten
 *    that ordering into a tie.
 *  - any OTHER day is anchored at MIDDAY, which reads as that same date in every zone from UTC-12 to
 *    UTC+11. The time of day is not known — nobody asked for it — and midday says so without lying
 *    about the date, which is the part somebody will argue over with a supplier.
 *
 * "Now" is read in UTC, because that is the zone the day itself was flattened to on the way in.
 */
export function instantForDay(day: Date, now: Date = new Date()): Date {
  return toCalendarDay(day).getTime() === toCalendarDay(now).getTime()
    ? now
    : new Date(toCalendarDay(day).getTime() + MS_PER_DAY / 2);
}
