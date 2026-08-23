// How a hire's return deadline is worded for the engineer holding it.
//
// Pure, so it can be tested without a DOM (this suite is Node-only) — the same split as
// kitItemAvailability.ts and jobAge.ts.
//
// THE DAY COUNT IS NOT COMPUTED HERE, and that is the point of this file existing rather than a
// `new Date()` inside the component. `dueInDays` and `overdue` are resolved SERVER-side against the
// company timezone (engineer.service.ts `getOwnRentals`), because a hire deadline is a calendar day
// and the only clock that may decide which calendar day it is now is the company's. A device an hour
// ahead, in another country, or simply set wrong would otherwise tell an engineer their hire is due
// tomorrow while the warehouse chasing it says today. This module only turns those two server facts
// into a sentence.

/** The two deadline facts the server resolves; everything else about a holding is irrelevant here. */
export interface HireDue {
  dueInDays: number | null;
  overdue: boolean;
}

/**
 * "3 days left" / "Due back today" / "2 days overdue" / "No date on record".
 *
 * Singular/plural is handled for 1, including "1 day overdue" — a stray "1 days" on the one line an
 * engineer is meant to act on reads as a broken screen, and undermines the number beside it.
 */
export function dueLabel(r: HireDue): string {
  if (r.dueInDays === null) return "No date on record";
  if (r.overdue) {
    const late = Math.abs(r.dueInDays);
    return `${late} day${late === 1 ? "" : "s"} overdue`;
  }
  // Zero is its own sentence rather than "0 days left". The engineer has all of the last day to get
  // it back, so this is a deadline, not an expiry — and "0 days left" reads as already too late.
  if (r.dueInDays === 0) return "Due back today";
  return `${r.dueInDays} day${r.dueInDays === 1 ? "" : "s"} left`;
}
