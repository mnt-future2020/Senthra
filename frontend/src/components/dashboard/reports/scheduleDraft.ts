import type { ReportSchedule, SchedulablePayloadState, SchedulableReport, SchedulePayload } from "./scheduleTypes";

// Pure translation between what the SERVER stores and what the FORM edits, kept out of the components
// so it can be tested on its own. The server remains the authority on every rule here — this only
// decides what a control shows and what the request body looks like.

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Every day is selectable, 1-31. A day that does not exist in a given month runs on that month's LAST
 * day, so the 31st runs on 30 April and on 28 (or 29) February — nothing is silently skipped.
 * `LAST_DAY_OF_MONTH` stores the distinct intent "month end", which is what a finance report usually
 * wants. Both mirror the server, which owns the rule.
 */
export const MAX_DAY_OF_MONTH = 31;
export const LAST_DAY_OF_MONTH = -1;

const hhmm = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** 1st, 2nd, 3rd, 4th... 11th-13th are the exceptions, 21st/22nd/23rd/31st are not. */
function ordinal(d: number): string {
  if (d % 100 >= 11 && d % 100 <= 13) return "th";
  return d % 10 === 1 ? "st" : d % 10 === 2 ? "nd" : d % 10 === 3 ? "rd" : "th";
}

/** "Weekly on Wednesday at 09:00" / "Monthly on the 1st at 06:00" — the cadence in one line. */
export function cadenceLabel(s: Pick<ReportSchedule, "cadence" | "dayOfWeek" | "dayOfMonth" | "hour" | "minute">): string {
  const time = hhmm(s.hour, s.minute);
  if (s.cadence === "weekly") return `Weekly on ${DAY_NAMES[(s.dayOfWeek ?? 1) - 1]} at ${time}`;
  const d = s.dayOfMonth ?? 1;
  if (d === LAST_DAY_OF_MONTH) return `Monthly on the last day at ${time}`;
  return `Monthly on the ${d}${ordinal(d)} at ${time}`;
}

/** A fresh draft for the first report the user may schedule. */
export function emptyDraft(first: SchedulableReport): SchedulablePayloadState {
  return {
    name: "",
    reportKey: first.key,
    cadence: "monthly",
    dayOfWeek: "1",
    dayOfMonth: "1",
    // 06:00 local — before the working day, so the report is waiting when people arrive.
    time: "06:00",
    format: "xlsx",
    recipients: [],
    filters: {},
    enabled: true,
  };
}

export function draftFrom(s: ReportSchedule): SchedulablePayloadState {
  return {
    name: s.name,
    reportKey: s.reportKey,
    cadence: s.cadence,
    // The unused day still gets a value: switching cadence in the form must not present a blank
    // control, and the payload drops whichever one the cadence does not use.
    dayOfWeek: String(s.dayOfWeek ?? 1),
    dayOfMonth: String(s.dayOfMonth ?? 1),
    time: hhmm(s.hour, s.minute),
    format: s.format,
    recipients: [...s.recipients],
    filters: s.filters ?? {},
    enabled: s.enabled,
  };
}

export function toPayload(d: SchedulablePayloadState): SchedulePayload {
  const [hh, mm] = d.time.split(":");
  return {
    name: d.name.trim(),
    reportKey: d.reportKey,
    cadence: d.cadence,
    // Only the field the cadence actually uses — the server clears the other one regardless.
    dayOfWeek: d.cadence === "weekly" ? Number(d.dayOfWeek) : null,
    dayOfMonth: d.cadence === "monthly" ? Number(d.dayOfMonth) : null,
    hour: Number(hh) || 0,
    minute: Number(mm) || 0,
    // No timezone: Settings -> Company -> Timezone is the single source of truth, and the server
    // resolves it at save time and again at every run.
    format: d.format,
    recipients: d.recipients.map((r) => r.trim()).filter(Boolean),
    // A blank filter box is not a filter. Sending "" would narrow the report to nothing.
    filters: Object.fromEntries(Object.entries(d.filters).filter(([, v]) => v.trim() !== "")),
    enabled: d.enabled,
  };
}

/**
 * How far past due an enabled schedule may sit before it means something is wrong.
 *
 * The runtime contract is "invoke the sweep at least once an hour" (docs/reports-scheduler-runtime.md),
 * so two hours is comfortably outside a healthy sweep and well inside a period.
 */
export const OVERDUE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Enabled schedules whose next run came and went.
 *
 * The one signal a user has that the sweep is not being invoked — the trigger is a deployment
 * decision, so the app cannot ask "am I wired up?" and must infer it. Derived rather than hardcoded
 * on purpose: it reads as a warning while nothing runs the sweep, and goes quiet by itself the moment
 * something does, with no code change and no flag to remember to turn off.
 */
export function overdueSchedules<T extends { enabled: boolean; nextRunAt: string }>(schedules: T[], now: number): T[] {
  return schedules.filter((s) => s.enabled && now - new Date(s.nextRunAt).getTime() > OVERDUE_AFTER_MS);
}

/**
 * What a run of this schedule will actually COVER, in the user's own words.
 *
 * The server's rule is one line — a run reports the last COMPLETE period before it fires — and it is
 * the right rule: emailing "September so far" on the 1st would be a different, useless report from
 * the one the same schedule sent in August, and two runs of a cadence have to be comparable.
 *
 * But that rule reads back as a surprise on exactly the option the form recommends first. A run
 * covers the month BEFORE the month it fires in, so "last day of month" fires on 31 January and
 * reports DECEMBER — a Finance Director who sets up month-end reporting gets last month's figures,
 * a month late, forever, and nothing on screen ever says so. Same shape weekly on a Sunday.
 *
 * The fix is not to change the period rule; it is to stop the schedule form being silent about it.
 * These strings are the whole mitigation, so they are computed from the draft rather than written as
 * static help text that could drift from what the server does.
 */
export function coverageNote(
  s: Pick<SchedulablePayloadState, "cadence" | "dayOfWeek" | "dayOfMonth">,
): { covers: string; warn: string | null } {
  if (s.cadence === "weekly") {
    const day = DAY_NAMES[(Number(s.dayOfWeek) || 1) - 1] ?? "Monday";
    const covers = `Each run reports the Monday–Sunday week that had already finished when it fired.`;
    // Sunday sits INSIDE the week a user is usually thinking of, so the run reports the week before
    // that one. Every other day is past the boundary and behaves the way people expect.
    return {
      covers,
      warn:
        Number(s.dayOfWeek) === 7
          ? `A ${day} run fires before that week has ended, so it reports the WEEK BEFORE — not the one it falls in. Pick Monday to report the week that has just finished.`
          : null,
    };
  }

  const d = Number(s.dayOfMonth);
  if (d === LAST_DAY_OF_MONTH) {
    return {
      covers: "Each run reports the month that had already finished when it fired.",
      warn:
        "A run on the last day of January fires before January is over, so it reports DECEMBER. Pick the 1st to report the month that has just ended.",
    };
  }
  return {
    covers: `Each run reports the month that ended before it — a run on the ${d}${ordinal(d)} of February reports January.`,
    warn: null,
  };
}
