import { dayValue } from "./rentalPricing";

// Does the delivery date land AFTER one of the request's hires has already started?
//
// A hire is billed from its start date, so kit that arrives later is charged for days it was never
// on site — and the warehouse's "awaiting delivery, hire has already started" alert fires the day
// the order is raised.
//
// A WARNING, never a block. Some hire companies bill from the day the kit leaves their yard rather
// than the day it reaches you, and there a later delivery date is correct — refusing to save it
// would reject a legitimate order. The server's utils/hire-delivery.ts is authoritative and reports
// the same thing on a saved request or order; this mirror exists so the form can answer while the
// user is still typing, before there is anything to save.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The earliest hire start across the rows, in the raw `YYYY-MM-DD` form the date input uses. */
export function earliestHireStart(rows: { hireStartDate: string }[]): string | null {
  let best: { value: string; ms: number } | null = null;
  for (const r of rows) {
    const ms = dayValue(r.hireStartDate);
    if (ms === null) continue;
    if (!best || ms < best.ms) best = { value: r.hireStartDate, ms };
  }
  return best?.value ?? null;
}

/** Whole days the delivery falls after the earliest hire start, or null when there's no problem. */
export function lateHireDeliveryDays(
  requiredByDate: string,
  rows: { hireStartDate: string }[],
): number | null {
  const delivery = dayValue(requiredByDate);
  const start = earliestHireStart(rows);
  const startMs = start === null ? null : dayValue(start);
  if (delivery === null || startMs === null) return null;
  const days = Math.round((delivery - startMs) / MS_PER_DAY);
  return days > 0 ? days : null;
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`, the UK form used everywhere this warning is shown. */
function ukDate(day: string): string {
  const ms = dayValue(day);
  if (ms === null) return day;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * ONE wording, shared by the form, the request page and the order page. Three hand-written variants
 * of the same warning is how a user ends up unsure whether they are being told two different things.
 */
export function hireDeliveryWarning(daysLate: number, earliestHireStartDay: string): string {
  const unit = daysLate === 1 ? "day" : "days";
  return `Delivery is ${daysLate} ${unit} after the hire starts (${ukDate(earliestHireStartDay)}) — you'd be billed for days the kit isn't on site. Fine if your supplier bills from dispatch.`;
}
