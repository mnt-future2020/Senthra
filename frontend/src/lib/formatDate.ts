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
