// Does the delivery date on this order land AFTER one of its hires has already started?
//
// A hire's start date is the first day it is billed — `billablePeriods` prices from it — so kit
// that arrives later is charged for days it was never on site. The app already treats this state as
// wrong once it happens: `overdueDeliveryWhere()` alerts on "awaiting delivery, and the hire has
// already started". Nothing stopped an order being RAISED that way, so a PO could trip that alert
// on the day it was created, and the supplier was handed two dates that contradict each other.
//
// Deliberately a WARNING, not a rule: some hire companies bill from the day the kit leaves their
// yard rather than the day it reaches you, and under that convention a delivery a day after the
// hire start is correct. Blocking it would refuse a legitimate order — so this reports, and the
// human decides.
//
// ONE helper for both documents: a purchase request measures its `requiredByDate`, the purchase
// order its `expectedDeliveryDate`. A second copy would eventually disagree with the first about
// the same order.

import { daysBetween, toCalendarDay } from "./calendar-day.js";

export interface LateHireDelivery {
  /** The earliest hire on the order — the start date the delivery has to satisfy. */
  earliestHireStart: Date;
  /** Whole days the delivery lands after that start: days billed with nothing on site. */
  daysLate: number;
}

/**
 * Null when the order is fine — no delivery date yet, no hire lines, or the kit arrives on or
 * before the first hire starts. Null too on an unusable date: this runs on every read of a request
 * or an order, and a bad row must not take the list down with it.
 */
export function lateHireDelivery(
  deliveryDate: Date | string | null | undefined,
  hires: { hireStartDate: Date | string }[],
): LateHireDelivery | null {
  if (!deliveryDate || hires.length === 0) return null;
  try {
    const delivery = toCalendarDay(deliveryDate);
    const starts = hires.map((h) => toCalendarDay(h.hireStartDate));
    const earliestHireStart = new Date(Math.min(...starts.map((d) => d.getTime())));
    const daysLate = daysBetween(earliestHireStart, delivery);
    return daysLate > 0 ? { earliestHireStart, daysLate } : null;
  } catch {
    return null;
  }
}

/** The wire shape both a purchase request and a purchase order publish, so the screens agree. */
export interface PublicLateHireDelivery {
  earliestHireStart: string;
  daysLate: number;
}

export function publicLateHireDelivery(
  deliveryDate: Date | string | null | undefined,
  hires: { hireStartDate: Date | string }[],
): PublicLateHireDelivery | null {
  const late = lateHireDelivery(deliveryDate, hires);
  return late ? { earliestHireStart: late.earliestHireStart.toISOString(), daysLate: late.daysLate } : null;
}
