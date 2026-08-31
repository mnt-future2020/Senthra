import { startOfDayIn } from "../../utils/filter-date.js";

// ── Report periods — CALENDAR weeks and months, in the company timezone ────────────────────────
//
// The client asked for "Weekly / Monthly / On-demand". The existing dashboard periods (12m/90d/30d)
// are ROLLING windows anchored on `now` — "the last 30 days" — which is a different question and the
// wrong one for a finance period: a monthly report has to mean a calendar month, or two runs of the
// same month return different numbers.
//
// Every boundary is resolved in the COMPANY timezone via the existing `startOfDayIn`, so a report run
// at 00:30 BST reports today and not yesterday. No second date convention is introduced: this file
// only composes the helper the rest of the codebase already uses.

export const REPORT_PERIODS = ["week", "month", "custom"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export interface DateRange {
  /** Inclusive start — 00:00 of the first day, in the company timezone. */
  from: Date;
  /** Inclusive end — the last millisecond of the final day, so `lte` catches the whole day. */
  to: Date;
  /** What the caller asked for, echoed back so a screen can label itself without re-deriving. */
  period: ReportPeriod;
  /** Human label for the report header: "1–7 Sep 2026", "September 2026". */
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last millisecond of the day that `dayStart` begins. */
function endOfDay(dayStart: Date): Date {
  return new Date(dayStart.getTime() + DAY_MS - 1);
}

/**
 * Monday-start ISO week containing `anchor`.
 *
 * ISO (Monday) rather than Sunday because the client is UK and the requirements doc pins working days
 * as Mon–Fri; a Sunday-start week would split every working week across two reports.
 */
export function startOfWeekIn(timeZone: string, anchor: Date): Date {
  const today = startOfDayIn(timeZone, anchor);
  // getUTCDay on a UTC-midnight value is the calendar weekday of that date — the value startOfDayIn
  // returns is exactly that, so no second timezone conversion is needed here.
  const dow = today.getUTCDay(); // 0 = Sunday
  const backToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  return new Date(today.getTime() - backToMonday * DAY_MS);
}

/** First day of the calendar month containing `anchor`, at 00:00 company time. */
export function startOfMonthIn(timeZone: string, anchor: Date): Date {
  const today = startOfDayIn(timeZone, anchor);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
}

/** First day of the month AFTER the one containing `anchor` — the exclusive upper bound. */
function startOfNextMonthIn(timeZone: string, anchor: Date): Date {
  const first = startOfMonthIn(timeZone, anchor);
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d = (v: Date) => v.getUTCDate();
const mon = (v: Date) => MONTHS[v.getUTCMonth()];
const yr = (v: Date) => v.getUTCFullYear();

/** "1–7 Sep 2026" / "28 Sep – 4 Oct 2026" — compact, and never ambiguous across a month boundary. */
function rangeLabel(from: Date, to: Date): string {
  if (yr(from) === yr(to) && mon(from) === mon(to)) return `${d(from)}–${d(to)} ${mon(to)} ${yr(to)}`;
  if (yr(from) === yr(to)) return `${d(from)} ${mon(from)} – ${d(to)} ${mon(to)} ${yr(to)}`;
  return `${d(from)} ${mon(from)} ${yr(from)} – ${d(to)} ${mon(to)} ${yr(to)}`;
}

/**
 * Resolve the period a report covers.
 *
 * `week` and `month` are the CURRENT calendar week/month to date — the period the client is standing
 * in. A completed-previous-period variant is what scheduling will need, and it composes from the same
 * helpers; it is deliberately not invented here before there is a scheduler to use it.
 *
 * `custom` requires both bounds. They arrive already normalised by `parseFilterDate` (start-of-day /
 * end-of-day), which is why this only orders them rather than re-deriving the edges: a second
 * normalisation is a second convention.
 */
export function resolvePeriod(
  timeZone: string,
  period: ReportPeriod,
  now: Date,
  custom?: { from?: Date; to?: Date },
): DateRange {
  if (period === "week") {
    const from = startOfWeekIn(timeZone, now);
    const to = endOfDay(startOfDayIn(timeZone, now));
    return { from, to, period, label: rangeLabel(from, to) };
  }
  if (period === "month") {
    const from = startOfMonthIn(timeZone, now);
    const to = endOfDay(startOfDayIn(timeZone, now));
    return { from, to, period, label: `${mon(from)} ${yr(from)}` };
  }
  // custom — the caller validated that both bounds are present.
  const from = custom?.from ?? startOfMonthIn(timeZone, now);
  const rawTo = custom?.to ?? endOfDay(startOfDayIn(timeZone, now));
  // Swapped bounds select NOTHING, which reads as "no spend this period" — indistinguishable from a
  // genuinely quiet month. Ordering them is the honest reading of what the user asked for.
  const [lo, hi] = from.getTime() <= rawTo.getTime() ? [from, rawTo] : [rawTo, from];
  return { from: lo, to: hi, period, label: rangeLabel(lo, hi) };
}

/** Whole calendar months spanned by a range, oldest first — "2026-09". The x-axis of a spend trend. */
export function monthKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor.getTime() <= last.getTime()) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

/** Whole days spanned by a range, oldest first — "2026-09-04". */
export function dayKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Which grain a trend should use for a range.
 *
 * A day-by-day series over a year is 365 unreadable points; a month-by-month series over one week is
 * a single bar. The switch is at ~62 days, i.e. anything up to about two months reads as days.
 */
export function trendGrain(range: DateRange): "day" | "month" {
  return range.to.getTime() - range.from.getTime() <= 62 * DAY_MS ? "day" : "month";
}

export { startOfNextMonthIn };

// ── Scheduled-report periods ───────────────────────────────────────────────────────────────────
//
// A schedule reports the period that has JUST ENDED, never the one in progress. Emailing "September
// so far" on the 1st would be a different (and useless) report from the one the same schedule sent in
// August, and two runs of the same cadence must be comparable.
//
// Separate from `resolvePeriod` above, which answers "the period I am standing in" for the on-demand
// screens. Both compose from the same boundary helpers, so there is still one date convention.

export const SCHEDULE_CADENCES = ["weekly", "monthly"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

/**
 * The last COMPLETE period before `now`.
 *
 * weekly  → the Monday-to-Sunday week that ended before this one began.
 * monthly → the calendar month that ended before this one began.
 *
 * `periodStart` is the idempotency key half: it is derived purely from the cadence, the timezone and
 * the clock, so a retry an hour later — or on another instance — computes the identical value and
 * collides with the run already recorded. That is what makes the key stable rather than merely
 * unique.
 */
export function completedPeriod(timeZone: string, cadence: ScheduleCadence, now: Date): DateRange {
  if (cadence === "weekly") {
    const thisWeek = startOfWeekIn(timeZone, now);
    const from = new Date(thisWeek.getTime() - 7 * DAY_MS);
    const to = new Date(thisWeek.getTime() - 1); // 23:59:59.999 last Sunday
    return { from, to, period: "custom", label: rangeLabel(from, to) };
  }
  const thisMonth = startOfMonthIn(timeZone, now);
  const from = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1));
  const to = new Date(thisMonth.getTime() - 1); // last millisecond of last month
  return { from, to, period: "custom", label: `${mon(from)} ${yr(from)}` };
}

/**
 * When a schedule should next fire after `from`.
 *
 * The start of the NEXT period, so a weekly schedule fires at 00:00 each Monday and a monthly one at
 * 00:00 on the 1st — the first moment its reporting period is complete. Stored on the schedule so the
 * due query stays one indexed range scan.
 *
 * Always strictly in the future relative to `from`: a schedule whose stored `nextRunAt` has fallen
 * behind (the process was down for a week) must not be able to compute a next run in the past and
 * spin. Each sweep advances it by exactly one period, so a backlog drains one period per sweep and the
 * skipped periods are visible as missing ReportRuns rather than silently collapsed into one.
 */
export function nextRunAfter(timeZone: string, cadence: ScheduleCadence, from: Date, at: FireTime = {}): Date {
  const hour = clamp(at.hour ?? 6, 0, 23);
  const minute = clamp(at.minute ?? 0, 0, 59);

  if (cadence === "weekly") {
    // ISO day: 1 = Monday. The offset is from the START of the week, so a Wednesday schedule fires two
    // days after the period it reports has closed.
    const offset = clamp(at.dayOfWeek ?? 1, 1, 7) - 1;
    let candidate = zonedTimeToUtc(timeZone, addDaysUtc(startOfWeekIn(timeZone, from), offset), hour, minute);
    // The chosen day/time may still be ahead of us within THIS week — fire then rather than waiting a
    // full extra week. Otherwise roll to next week.
    if (candidate.getTime() <= from.getTime()) {
      candidate = zonedTimeToUtc(timeZone, addDaysUtc(startOfWeekIn(timeZone, from), offset + 7), hour, minute);
    }
    return candidate;
  }

  const m = startOfMonthIn(timeZone, from);
  let candidate = zonedTimeToUtc(timeZone, addDaysUtc(m, dayIndexIn(m, at.dayOfMonth)), hour, minute);
  if (candidate.getTime() <= from.getTime()) {
    // Resolved AGAIN against the next month, not reused: "the 31st" is a different day index in March
    // than in April, and "last day" is a different one in every other month.
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    candidate = zonedTimeToUtc(timeZone, addDaysUtc(next, dayIndexIn(next, at.dayOfMonth)), hour, minute);
  }
  return candidate;
}

/**
 * The explicit "last day of the month" selection.
 *
 * Not the same intent as 31 even though they coincide: a user who picks 31 means the 31st, and a user
 * who picks month-end means month-end — which is what a finance report actually wants. Storing the
 * intent keeps the label honest ("Monthly on the last day" vs "Monthly on the 31st"). The negative
 * sentinel is the iCalendar convention (BYMONTHDAY=-1), not an invention of this codebase.
 */
export const LAST_DAY_OF_MONTH = -1;

/** Days in the calendar month that `year`/`month` (0-based) names. Day 0 of the next month IS that. */
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * Which day of `monthStart`'s month a `dayOfMonth` selection lands on, as a 0-based offset.
 *
 * THE monthly rule, in one place:
 *
 *   • `LAST_DAY_OF_MONTH` → the last day, whatever its number is.
 *   • 1-31 → that day, CLAMPED DOWN to the month's last day where it does not exist. The 31st runs on
 *     30 April and on 28 (or 29) February.
 *
 * Clamping rather than skipping, because a monthly report that silently misses February is a hole in
 * the record nobody notices until an accountant asks for it. Clamping rather than rolling into the
 * next month, because 1 March is inside the period the March run will itself report — the same month
 * would be covered twice and February never announced on its own.
 *
 * The client documents say only "Weekly / Monthly / On-demand" and never define day-of-month, so this
 * is a documented product decision, not a stated requirement. See docs/reports-scheduler-runtime.md.
 */
function dayIndexIn(monthStart: Date, dayOfMonth?: number | null): number {
  const len = daysInMonth(monthStart.getUTCFullYear(), monthStart.getUTCMonth());
  const want = dayOfMonth ?? 1;
  return want === LAST_DAY_OF_MONTH ? len - 1 : clamp(want, 1, len) - 1;
}

/** When within its cadence a schedule fires. All optional; the defaults are Monday / the 1st / 06:00. */
export interface FireTime {
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  hour?: number | null;
  minute?: number | null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(Math.trunc(v), lo), hi);
const addDaysUtc = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

/**
 * How far `timeZone` is ahead of UTC at a given instant, in milliseconds.
 *
 * Measured rather than tabulated: format the instant IN the zone, read it back as though it were UTC,
 * and the difference is the offset. That is correct through every DST transition and every historical
 * rule change without this codebase carrying a timezone database of its own.
 */
function zoneOffsetMs(timeZone: string, at: Date): number {
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
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // `hour` can format as 24 for midnight in some engines; %24 normalises it.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - at.getTime();
}

/**
 * The UTC instant at which the LOCAL wall clock in `timeZone` reads `hour:minute` on `day`'s date.
 *
 * "09:00 in London" must stay 09:00 in both GMT and BST. Adding hours to a UTC-midnight anchor would
 * drift by the DST offset — a report scheduled for 09:00 arriving at 10:00 for half the year — so the
 * offset is measured and subtracted.
 *
 * Two passes: the first guess uses the offset at UTC-midnight, which is wrong only when the guess
 * lands on the far side of a transition; re-measuring at the corrected instant settles it. A third
 * pass could never differ, because a transition moves the clock by at most a couple of hours.
 */
function zonedTimeToUtc(timeZone: string, day: Date, hour: number, minute: number): Date {
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  let ts = wall - zoneOffsetMs(timeZone, new Date(wall));
  ts = wall - zoneOffsetMs(timeZone, new Date(ts));
  return new Date(ts);
}

export { zonedTimeToUtc, zoneOffsetMs };
