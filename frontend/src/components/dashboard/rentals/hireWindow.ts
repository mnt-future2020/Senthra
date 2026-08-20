// Display-side mirror of the server's hire predicate. Decides a row's COLOUR, nothing else — the
// server's `expiringSoonWhere` / `overdueWhere` remain authoritative for what is counted and listed.
//
// Hire dates arrive as UTC midnights (the server normalises every one), so comparing them by
// calendar day here is exact, DST included.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the calendar date, matching how the server stores a hire date. */
const calendarDay = (v: string | Date): number => {
  const d = v instanceof Date ? v : new Date(v);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Whole days between two hire dates. */
export function hireLengthDays(start: string | Date, end: string | Date): number {
  return Math.round((calendarDay(end) - calendarDay(start)) / MS_PER_DAY);
}

export type HireWindow = "ok" | "expiring" | "overdue";

/**
 * Which window a live hire is in.
 *
 * `startDate` is optional but SHOULD be passed: without it a lead longer than the hire would report
 * "expiring" from before the hire began, where the server clamps the reminder to the start date.
 * The two must agree or a row is coloured for a state the badge does not count.
 */
export function hireWindowState(
  endDate: string | Date,
  notifyDaysBefore: number,
  today: Date = new Date(),
  startDate?: string | Date,
): HireWindow {
  const end = calendarDay(endDate);
  const now = calendarDay(today);
  if (end < now) return "overdue";

  const raw = end - notifyDaysBefore * MS_PER_DAY;
  // The same clamp the server applies: a reminder never falls before the hire starts.
  const notifyOn = startDate !== undefined ? Math.max(raw, calendarDay(startDate)) : raw;
  return notifyOn <= now ? "expiring" : "ok";
}

/** "3 days left" / "2 days over" / "ends today". */
export function daysRemainingLabel(daysRemaining: number): string {
  if (daysRemaining === 0) return "ends today";
  if (daysRemaining > 0) return `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`;
  const over = Math.abs(daysRemaining);
  return `${over} day${over === 1 ? "" : "s"} over`;
}
