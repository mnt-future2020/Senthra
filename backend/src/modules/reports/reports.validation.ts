import { z } from "zod";

import { MAX_CUSTOM_RANGE_DAYS, SCHEDULE_FORMATS } from "./reports.constants.js";
import { LAST_DAY_OF_MONTH, REPORT_PERIODS, SCHEDULE_CADENCES } from "./reports.period.js";
import { badRequest } from "../../utils/http-error.js";

// Query contract for every Finance read. `custom` REQUIRES both bounds: a half-open custom range
// would silently fall back to a default period and report a window nobody asked for.
export const financeQuerySchema = z
  .object({
    period: z.enum(REPORT_PERIODS).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    supplierId: z.string().optional(),
  })
  .refine((v) => v.period !== "custom" || (Boolean(v.from) && Boolean(v.to)), {
    message: "A custom period needs both a from and a to date.",
    path: ["from"],
  });

export type FinanceQueryInput = z.infer<typeof financeQuerySchema>;

const DAY_MS = 86_400_000;

/**
 * Refuse a custom period wider than the report can honestly total.
 *
 * The window is the one input on the Finance endpoint with no natural ceiling, and the two-step read
 * behind it loads every order in range plus every line under it. Unbounded,
 * `?period=custom&from=2000-01-01&to=2030-12-31` pulled the entire purchase-order history into one
 * process — an authenticated self-DoS, and one no figure on the page needed.
 *
 * Bounds are ORDERED first, matching `resolvePeriod`: a user who fills the dates in backwards asked
 * for a span, not a negative one, and rejecting it as "too wide" would be a confusing lie.
 *
 * Applied to what a CALLER may ask for. The scheduler composes its range from a cadence and is
 * bounded by construction, so it never reaches here.
 */
export function assertRangeWithinLimit(from?: Date, to?: Date): void {
  if (!from || !to) return;
  const [lo, hi] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
  if (Math.ceil((hi.getTime() - lo.getTime()) / DAY_MS) > MAX_CUSTOM_RANGE_DAYS) {
    throw badRequest(`A custom period can span at most ${MAX_CUSTOM_RANGE_DAYS} days. Narrow the dates and try again.`);
  }
}

/**
 * `?limit=` → a positive whole number, or a 400.
 *
 * `Number("abc")` is NaN, and NaN survives `Math.min(Math.max(NaN, 1), MAX)` unchanged — every clamp
 * in the chain passes it straight through — so it reached Prisma as `take: NaN` and came back as a
 * 500. A malformed query string is the caller's mistake and has to read as one; a 500 says the server
 * broke and sends somebody looking through logs for a fault that is not there.
 */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("`limit` must be a positive whole number.");
  return n;
}

// ── Scheduled-report write bodies ──────────────────────────────────────────────────────────────
//
// The SHAPE gate, at the route, in front of createSchedule / updateSchedule. Everything below is
// about types and ranges; nothing here decides authorisation. Which reports this actor may schedule,
// which recipients are eligible, and whether a report can honour a given filter all stay in
// reportSchedule.service — they need the database and the actor, which a body schema has neither of.
//
// Why it is needed even though the service already validates: the service validates SEMANTICS while
// trusting the TYPES, because `req.body` was cast straight to `ScheduleInput`. That cast is a claim,
// not a check, and three of them broke:
//
//   {"name": 123}        → `input.name?.trim()` → TypeError → 500
//   {"hour": "6"}        → `"6" < 0` and `"6" > 23` are both false, so the range check passes by
//                          coercion and a string reaches Prisma's Int column → 500
//   {"recipients": "a"}  → `.map is not a function` → 500
//
// A malformed body is the caller's mistake and must read as one. Every other write route in this
// codebase goes route → validateBody(schema) → controller; these two were the exception.
const FILTERS_MESSAGE = "Filters must be a set of text values.";
const DAY_OF_MONTH_MESSAGE = "Day of month must be between 1 and 31, or the last day of the month.";

const scheduleName = z
  .string({ error: "Give the schedule a name." })
  .trim()
  .min(1, "Give the schedule a name.")
  .max(120, "Keep the name under 120 characters.");

/** Nullable because the form clears the field the current cadence does not use. */
const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message).max(max, message).nullish();

export const scheduleWriteSchema = z.object({
  name: scheduleName,
  reportKey: z.string({ error: "Choose a report." }).trim().min(1, "Choose a report."),
  cadence: z.enum(SCHEDULE_CADENCES, { error: "Frequency must be weekly or monthly." }),
  dayOfWeek: wholeNumber(1, 7, "Day of week must be between 1 (Monday) and 7 (Sunday)."),
  // 1-31, or LAST_DAY_OF_MONTH (-1) for "month end" — iCalendar's BYMONTHDAY=-1 convention.
  // A refined number rather than a union: a union reports the failure of each branch, and
  // `validateBody` surfaces only `issues[0]`, so the caller would read Zod's generic
  // "Invalid input" instead of the sentence that tells them what to do.
  dayOfMonth: z
    .number(DAY_OF_MONTH_MESSAGE)
    .int(DAY_OF_MONTH_MESSAGE)
    .refine((v) => v === LAST_DAY_OF_MONTH || (v >= 1 && v <= 31), DAY_OF_MONTH_MESSAGE)
    .nullish(),
  hour: wholeNumber(0, 23, "Hour must be between 0 and 23."),
  minute: wholeNumber(0, 59, "Minute must be between 0 and 59."),
  // Accepted and deliberately IGNORED by the service — Settings → Company → Timezone is the single
  // source of truth. Typed here only so an old client sending one gets a 400 for a bad shape rather
  // than having a non-string silently ride along.
  timeZone: z.string().nullish(),
  format: z.enum(SCHEDULE_FORMATS, { error: "Format must be xlsx or csv." }).optional(),
  recipients: z
    .array(z.string({ error: "A recipient must be a user." }), { error: "Add at least one recipient." })
    .min(1, "Add at least one recipient.")
    .max(20, "A schedule can have at most 20 recipients."),
  // Keys are checked against the REPORT's declared filters in the service, which is the only layer
  // that knows the report. Here it is only "a flat map of strings" — the shape Prisma's Json column
  // and the runner both assume.
  // The message goes on the VALUE schema, not the record: a bad value fails there, and that is the
  // issue `validateBody` reports.
  filters: z
    .record(z.string(), z.string(FILTERS_MESSAGE), { error: FILTERS_MESSAGE })
    .nullish(),
  enabled: z.boolean({ error: "Enabled must be true or false." }).optional(),
});

// PATCH /schedules/:id/enabled — the pause/resume toggle.
//
// Its handler read `(req.body as { enabled?: boolean }).enabled === true`, which survives any object
// but throws on a JSON `null` body (`null.enabled`) → 500. Required rather than optional: a toggle
// with no value is not a request to turn something off, it is a malformed one.
export const scheduleEnabledSchema = z.object({
  enabled: z.boolean({ error: "`enabled` must be true or false." }),
});

export type ScheduleWriteInput = z.infer<typeof scheduleWriteSchema>;
