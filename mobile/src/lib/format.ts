// The app's on-screen date format, in one place — the mobile twin of the web's
// lib/formatDate.ts, and deliberately identical to it: "DD Mon YYYY" (03 Aug 2026).
//
// This is NOT the numeric DD/MM/YYYY offered by Settings → Company's "Date format"
// control. That setting drives generated documents, supplier emails and CSV exports,
// and nothing on screen. This file used to render 03/08/2026, which matched that
// setting by coincidence — worse than plainly wrong, because it looked like the
// setting was driving the app when it never was.
//
// Spelled out rather than via toLocaleDateString: Hermes' Intl support varies by
// platform and the device locale can reorder the parts, and a date that renders
// differently on one engineer's phone than on the dashboard is exactly the drift
// this module exists to end.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An em dash, not an empty string — rows rely on it so a blank value still occupies its line. */
const EMPTY = "—";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "03 Aug 2026". Em dash when absent or unparseable. */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * A HIRE DEADLINE — same "03 Aug 2026" shape as `formatDate`, but read in UTC.
 *
 * NOT interchangeable with `formatDate`, and the difference is a whole day.
 *
 * A hire's return date is a CALENDAR DAY, stored at UTC midnight — it is "the 30th", not an instant.
 * `formatDate` reads a timestamp with the device's local getters, which is right for a timestamp
 * (when something happened, in the reader's own day) and wrong for a calendar day: on any device
 * BEHIND UTC, `new Date("2026-09-30T00:00:00Z").getDate()` is 29. The engineer is then told their
 * kit was due yesterday, or that today's deadline is tomorrow — on the one field whose entire job is
 * naming a day, and against a warehouse that is chasing them by the real one.
 *
 * The web pins the same fields the same way (`formatHireDate` in van-requests/vanStockLine.ts, and
 * `formatDueDay` in goods-management/jobAge.ts). Use this for `hireEndDate` and nothing else.
 */
export function formatHireDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "03 Aug 2026, 15:30" — for timestamps where the time of day matters. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(iso)}, ${hh}:${mi}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function joinAddress(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(", ");
}

export function signed(qty: number): string {
  return qty > 0 ? `+${qty}` : String(qty);
}
