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
