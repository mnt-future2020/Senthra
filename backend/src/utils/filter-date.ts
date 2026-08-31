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

// ── Day windows ────────────────────────────────────────────────────────────────────────────────
//
// A list filter always asks a CALENDAR question — "things on 31 August", "things between the 1st and
// the 5th". Turning that into a `where` clause has exactly two correct answers in this codebase, and
// picking the wrong one is invisible until somebody argues about a missing row:
//
//   • A CALENDAR-DAY column (Job.completionDate, GoodsReceipt.receivedDate, hireEndDate, …) is stored
//     at UTC midnight of the date somebody typed. It carries no time of day and no zone, so the
//     window is pure date arithmetic — `calendarDayWindow`.
//
//   • An INSTANT column (createdAt, postedAt, receivedAt, lastMovementAt, …) is a real moment. "31
//     August" is only meaningful once you say *whose* 31 August, and this app has one answer for that
//     everywhere else: the COMPANY timezone from Settings — `instantDayWindow`.
//
// Both return a HALF-OPEN range: `gte` the start of the first day, `lt` the start of the day AFTER
// the last. Half-open rather than an inclusive `lte` at 23:59:59.999 because it is the form that
// cannot be wrong — consecutive windows tile with no gap and no overlap, and a value carrying an
// unexpected time component (a calendar-day column somebody wrote as an instant) still lands in
// exactly one of them.

const MS_PER_DAY_WINDOW = 24 * 60 * 60 * 1000;

/** A half-open `where` range. Either bound may be absent; both absent means "no filter". */
export interface DayWindow {
  gte?: Date;
  lt?: Date;
}

/** Nothing to filter on — a window with neither bound set. */
export function isEmptyWindow(w: DayWindow): boolean {
  return w.gte === undefined && w.lt === undefined;
}

/**
 * Turn a window into a Prisma date filter, or `undefined` when neither bound is set.
 *
 * The `undefined` matters: spreading an empty `{}` into a `where` gives Mongo an empty comparison
 * document, which is not the same as omitting the key.
 */
export function dayWindowFilter(w: DayWindow): DayWindow | undefined {
  return isEmptyWindow(w) ? undefined : w;
}

/** The `YYYY-MM-DD` a date-input sends. Anything else is not a calendar day. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnly(value: string): { y: number; m: number; d: number } | null {
  if (!DATE_ONLY_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip check — rejects "2026-02-31", which Date.UTC would happily roll into March.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * A window over a CALENDAR-DAY column — one stored at UTC midnight of the date the user typed.
 *
 * `from`/`to` are the raw query values ("YYYY-MM-DD"); junk is dropped rather than thrown on, the
 * same leniency `parseFilterDate` documents, because these arrive from a URL a user can edit.
 * `to` is INCLUSIVE of its whole day: the upper bound is the start of the following day.
 */
export function calendarDayWindow(from: string | undefined, to: string | undefined): DayWindow {
  const w: DayWindow = {};
  const f = from ? parseDateOnly(from.trim()) : null;
  const t = to ? parseDateOnly(to.trim()) : null;
  if (f) w.gte = new Date(Date.UTC(f.y, f.m - 1, f.d));
  if (t) w.lt = new Date(Date.UTC(t.y, t.m - 1, t.d) + MS_PER_DAY_WINDOW);
  return w;
}

/**
 * The UTC offset of `timeZone` at `at`, in milliseconds (east of UTC is positive).
 *
 * Derived by formatting the instant as wall-clock time in the zone and reading those parts back as
 * if they were UTC: the difference between the two IS the offset. `en-CA` + 2-digit parts because
 * that combination is stable across engines — the same reason `startOfDayIn` above uses it.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  // `hour12: false` renders midnight as "24" on some engines — normalise, or the offset lands a day out.
  const h = get("hour") % 24;
  const min = get("minute");
  const s = get("second");
  if (![y, m, d, h, min, s].every((n) => Number.isFinite(n))) return 0;
  return Date.UTC(y, m - 1, d, h, min, s) - at.getTime();
}

/**
 * The instant at which the calendar date `{y,m,d}` BEGINS in `timeZone`.
 *
 * Two passes, because the offset needed to answer the question depends on the answer: the first pass
 * guesses using the offset in force at the same wall-clock reading in UTC, the second corrects it if
 * that guess landed on the other side of a DST transition. Without the second pass, a window
 * starting on the morning clocks change is an hour out — precisely the day someone checks.
 *
 * On a spring-forward day in a zone whose transition IS midnight, that midnight does not exist; the
 * result is then the first instant of the day that does. Both bounds of every window are computed
 * the same way, so consecutive days still tile exactly — which is the property that matters here.
 */
function zonedDayStart(y: number, m: number, d: number, timeZone: string): Date {
  const asUtc = Date.UTC(y, m - 1, d);
  const guess = asUtc - zoneOffsetMs(new Date(asUtc), timeZone);
  const corrected = asUtc - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(corrected);
}

/**
 * A window over an INSTANT column, expressed as calendar days in the COMPANY timezone.
 *
 * `timeZone` must come from `settingsService.getCompanyTimezone()` — never from the browser, never
 * from the query string. An unusable zone falls back to UTC rather than throwing, matching
 * `startOfDayIn`: a filter that degrades is recoverable, a 500 on a shareable URL is not.
 */
export function instantDayWindow(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): DayWindow {
  const w: DayWindow = {};
  const f = from ? parseDateOnly(from.trim()) : null;
  const t = to ? parseDateOnly(to.trim()) : null;
  try {
    if (f) w.gte = zonedDayStart(f.y, f.m, f.d, timeZone);
    if (t) {
      // The START of the day after — computed as its own zoned day start, NOT as "+24h", which is
      // wrong by an hour across a DST change.
      const next = new Date(Date.UTC(t.y, t.m - 1, t.d) + MS_PER_DAY_WINDOW);
      w.lt = zonedDayStart(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
    }
  } catch {
    return calendarDayWindow(from, to);
  }
  return w;
}

/**
 * `instantDayWindow`, but the timezone is only READ when there is actually a window to build.
 *
 * Resolving the company timezone means a settings read, and a list call with no date filter has no
 * reason to pay for one — nor to depend on that module at all. Every instant-column date filter goes
 * through here so the rule is uniform rather than remembered per call site.
 */
export async function resolveInstantWindow(
  from: string | undefined,
  to: string | undefined,
  timeZone: () => Promise<string> | string,
): Promise<DayWindow> {
  if (!from && !to) return {};
  return instantDayWindow(from, to, await timeZone());
}
