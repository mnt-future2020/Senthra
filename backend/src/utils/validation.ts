import { z } from "zod";

// Validation primitives shared by every account type (admin/staff/customer) so the
// rules are defined once and can't drift between modules. Module-specific fields
// (status enums, postcode/website, profile dates) stay in each module's validation.

// Email shape — intentionally lenient; real deliverability is proven by the invite /
// reset email, not the regex. Explicitly forbids ` , ; < > ` so a stored address can't
// smuggle a second recipient (comma/semicolon address-lists) or header brackets into a
// downstream `to:` field (e.g. the PO-to-supplier email).
export const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// UK phone only (client is a UK telecom field-services business): national "0" +
// 9–10 digits, or international "+44" with an optional "(0)" + 9–10 digits, after
// stripping spaces/hyphens/parens. Mirrored on the front-end (defence in depth).
export const UK_PHONE_RE = /^(?:\+440?|0)\d{9,10}$/;
export const isValidPhone = (v: string): boolean => UK_PHONE_RE.test(v.replace(/[\s()-]/g, ""));

// Required email field with a customizable "required" message.
export const emailField = (required = "Email is required.") =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address.");

// Optional phone field: an empty string is allowed (the service treats it as
// "clear"); any non-empty value must be a valid UK number.
export const optionalPhoneField = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === "" || isValidPhone(v), "Enter a valid phone number.")
  .optional();

// ---------------------------------------------------------------------------
// Calendar dates
//
// Every date field in the app is fed by an <input type="date">, which emits
// exactly "YYYY-MM-DD". Anchoring to that shape is not pedantry: `Date.parse`
// falls back to a legacy implementation-defined parser for anything it doesn't
// recognise as ISO, so "Mar 5" silently becomes 2001-03-05 and a bare "2024"
// becomes a valid timestamp. A `!Number.isNaN(Date.parse(v))` check therefore
// accepts junk and stores a plausible-looking wrong date.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True when `v` is "YYYY-MM-DD" AND names a date that actually exists. The
// round-trip is what rejects 2025-02-30 / 2025-13-01: `Date.UTC` rolls overflow
// forward into the next month, so a real date is the only input that comes back
// spelling itself the same way.
export function isCalendarDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

// Today as "YYYY-MM-DD". ISO date strings sort lexicographically, so comparing
// them as strings is an exact, timezone-free "is this day before that day?" —
// unlike `new Date("2026-07-27") > Date.now()`, which pits a UTC midnight
// against a local clock and flips its answer within hours of midnight.
export const todayIso = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

// Whole years elapsed between two ISO dates, by calendar components — never
// millisecond arithmetic, which drifts across leap years. Returns a negative
// number when `to` precedes `from`.
export function yearsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let years = ty - fy;
  // Birthday hasn't come round yet this year.
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years;
}

// Shift an ISO date by whole days.
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Real-world timezones span UTC-12 … UTC+14, so a browser's idea of "today" is
// always within ONE day of the server's UTC date. Date bounds are therefore
// evaluated against the most permissive day in that window: the server never
// rejects a date the user's own calendar told them was fine.
//
// This is deliberately derived from the server clock rather than from a timezone
// sent by the client — a client-supplied "today" would be trivially forged to
// defeat every bound below. The price is at most one day of extra leniency at a
// boundary, which is meaningless against a 16-year rule.
export const TZ_DAY_SKEW = 1;
// The latest / earliest "today" any legitimate client could be reporting.
export const latestClientToday = (today: string = todayIso()): string =>
  addDaysIso(today, TZ_DAY_SKEW);
export const earliestClientToday = (today: string = todayIso()): string =>
  addDaysIso(today, -TZ_DAY_SKEW);

// Shift an ISO date by whole years, clamping 29 Feb to 28 Feb in a non-leap
// target year (Date.UTC would otherwise roll it to 1 March).
export function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const targetY = y + years;
  const lastDay = new Date(Date.UTC(targetY, m, 0)).getUTCDate();
  return `${String(targetY).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

// An optional calendar-date field. An empty string is preserved and means
// "clear this field" — the services rely on that to distinguish "not supplied"
// (undefined, leave alone) from "cleared" (empty, write null).
export const optionalIsoDateField = (label = "date") =>
  z
    .string()
    .trim()
    .refine(
      (v) => v === "" || isCalendarDate(v),
      `Enter a valid ${label.toLowerCase()} as a real calendar date.`,
    );
