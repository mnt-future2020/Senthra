// The dashboard's on-screen date format, in one place.
//
// "DD Mon YYYY" — 03 Aug 2026 — is what Settings → Company promises the admin ("On-screen dates keep
// the standard UK format (DD Mon YYYY)"). It is deliberately NOT the numeric DD/MM/YYYY offered by
// the Date format control on that same screen: that setting drives generated documents, supplier
// emails and CSV exports, and nothing on screen.
//
// This module exists because that six-line formatter had been copy-pasted into thirteen files under
// three different names, and five copies had drifted to a bare `toLocaleDateString("en-GB")` — which
// renders 03/08/2026. Those screens then matched the DD/MM/YYYY *setting* by coincidence, which is
// worse than plainly wrong: it looked like the setting was driving them, so an admin changing it had
// every reason to expect the screens to follow. They never would have.
//
// Month is spelled, so no separator is needed or wanted: separators disambiguate three run-together
// numbers, and "Aug" already does that.
//
// No `timeZone` option, so both render in the VIEWER's zone — matching every copy replaced. Anything
// that is a calendar date rather than an instant (a `<input type="date">` value stored at UTC
// midnight) must not use these: formatting UTC midnight locally shows the day before for anyone
// behind UTC. See `formatDueDay` in goods-management/jobAge.ts, which pins timeZone: "UTC" for
// exactly that reason.

const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };

// Hour + minute, no seconds: these are ledger and audit timestamps, where the second is noise.
const TIME_OPTS: Intl.DateTimeFormatOptions = { ...DATE_OPTS, hour: "2-digit", minute: "2-digit" };

/** An em dash, not an empty string — tables rely on it to stop a column collapsing on a blank cell. */
const EMPTY = "—";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "03 Aug 2026". Em dash when absent or unparseable. */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toLocaleDateString("en-GB", DATE_OPTS) : EMPTY;
}

/** "03 Aug 2026, 15:30" — for timestamps where the time of day matters. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toLocaleString("en-GB", TIME_OPTS) : EMPTY;
}

/**
 * "01 Sept 2026, 06:00 BST" — an instant rendered in a NAMED zone, with that zone shown.
 *
 * `formatDateTime` above renders in the VIEWER's zone, which is right for a ledger entry ("when did
 * this happen, my time") and wrong for a scheduled report ("when will this fire"). A schedule is
 * configured as a wall-clock time in the COMPANY timezone, so a viewer in another zone saw a row that
 * read "Monthly on the 1st at 06:00 · Europe/London" beside "Next run: 01 Sept 2026, 10:30" — two
 * different times for the same event, on the same row.
 *
 * The zone abbreviation is appended rather than left implied. It is what makes 06:00 unambiguous, and
 * it also surfaces the DST half of the year: the same schedule reads BST in September and GMT in
 * December, from one stored UTC instant. Nothing about storage or scheduling changes here — this
 * formats, it does not compute.
 *
 * An unusable `timeZone` would make Intl throw and take the table down with it, so it falls back to
 * the viewer's zone rather than crashing on a value that only reaches here from the database.
 */
export function formatDateTimeIn(iso: string | null | undefined, timeZone: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  if (!timeZone) return formatDateTime(iso);
  try {
    return d.toLocaleString("en-GB", { ...TIME_OPTS, timeZone, timeZoneName: "short" });
  } catch {
    return formatDateTime(iso);
  }
}

/**
 * "03 Aug 2026" for a CALENDAR DAY — pinned to UTC.
 *
 * The variant the note at the top of this file warns is needed. A calendar day (a hire deadline, a
 * `<input type="date">` value) is stored as UTC midnight, so `formatDate` above renders it as the day
 * BEFORE for any viewer behind UTC. On a hire return deadline that is the one number that must not be
 * wrong: it is the difference between an engineer thinking they have until Friday and the provider
 * billing for the weekend.
 */
export function formatCalendarDay(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toLocaleDateString("en-GB", { ...DATE_OPTS, timeZone: "UTC" }) : EMPTY;
}
