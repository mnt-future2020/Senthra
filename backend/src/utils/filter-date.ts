// Shared parser for a LIST-FILTER date coming off the wire (`?from=`/`?to=`), used by every module
// that offers a date-range filter. Lives here rather than in one module because the day-widening rule
// below is subtle enough that a second hand-written copy would eventually disagree with the first —
// and a "To" filter that silently excludes the last day is the kind of bug nobody reports, they just
// stop trusting the screen.

/**
 * Parse a filter date. A date-only value ("YYYY-MM-DD", what the UI's date input sends) is widened to
 * the whole UTC day: the `start` edge → 00:00:00.000, the `end` edge → 23:59:59.999. This makes a "To"
 * date INCLUSIVE of that day's records instead of cutting off at midnight, and keeps the range
 * timezone-stable (timestamps are stored in UTC). A full ISO datetime is used as-is.
 *
 * Invalid input → `undefined`, i.e. NO filter. Deliberately lenient: a typo'd query string returns an
 * unfiltered result rather than a 500, since these values arrive straight from a URL a user can edit.
 */
export function parseFilterDate(value: string | undefined, edge: "start" | "end"): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${edge === "end" ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Today's calendar date in `timeZone`, expressed the SAME way a due date is stored: UTC midnight of
 * that date.
 *
 * Job.completionDate is a date-only value — the form sends "YYYY-MM-DD" and `new Date(...)` stores it
 * at UTC midnight. So "due 3 Aug" is 2026-08-03T00:00:00Z no matter where you stand, and comparing it
 * against a true timezone-converted instant would be wrong in the opposite direction. The only
 * question a timezone answers here is *which calendar date is it right now* — which is what this asks.
 *
 * Why it matters: computing that from `getUTCDate()` is a day behind for the first hour of every BST
 * day. A UK manager opening the queue at 00:30 on 4 August was shown 3 August's jobs, for seven
 * months of the year. Falls back to UTC only if the timezone string is unusable.
 */
export function startOfDayIn(timeZone: string, now: Date): Date {
  const utcDay = () => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    // en-CA formats as YYYY-MM-DD, which is why it's used here rather than parsing locale-specific parts.
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(now)
      .split("-")
      .map(Number);
    // The parse is checked, not just the call. An unusable timezone makes the Intl constructor THROW
    // and lands in the catch — but a merely UNEXPECTED format string would sail past it as NaN, and
    // `Date.UTC(NaN, …)` yields an Invalid Date that throws nowhere. Every comparison against it is
    // then false, so an app-wide "nothing is due, nothing is overdue" would look like real data.
    if (![y, m, d].every((n) => Number.isFinite(n))) return utcDay();
    return new Date(Date.UTC(y!, m! - 1, d!));
  } catch {
    return utcDay();
  }
}
