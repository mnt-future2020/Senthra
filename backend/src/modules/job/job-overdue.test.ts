import { describe, expect, it } from "vitest";

import { OVERDUE_ELIGIBLE_STATUSES, jobOverdue } from "./job-overdue.js";

// The jobs list showed every Due date in the same grey, so "Jobs overdue 4" could only be resolved by
// clicking it — the number named work the table refused to point at. This is the predicate the row
// marker uses, and it has to be the SAME one `?status=overdue` filters on and the badge counts, or
// the list would redden a different set than the number claimed.

// Start of 8 Aug 2026 in the company's timezone. Never `new Date()` — see the module header.
const TODAY = new Date("2026-08-08T00:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("jobOverdue", () => {
  it("marks an active job whose due date has passed", () => {
    expect(jobOverdue(at("2026-07-13T00:00:00.000Z"), "accepted", TODAY)).toEqual({ overdue: true, daysLate: 26 });
  });

  // The boundary the whole thing turns on, and the one buildWhere uses (`<`, not `<=`).
  it("does not call a job due TODAY late", () => {
    expect(jobOverdue(TODAY, "in_progress", TODAY)).toEqual({ overdue: false, daysLate: null });
  });

  it("counts the first day late as 1, not 0", () => {
    expect(jobOverdue(at("2026-08-07T00:00:00.000Z"), "assigned", TODAY).daysLate).toBe(1);
  });

  // A due date carrying a time-of-day would otherwise floor to "0d late", which reads as not late.
  it("rounds a part-day up, so yesterday afternoon is still 1d late", () => {
    expect(jobOverdue(at("2026-08-07T14:30:00.000Z"), "accepted", TODAY)).toEqual({ overdue: true, daysLate: 1 });
  });

  it("is late in every status a job can still be worked in", () => {
    for (const status of OVERDUE_ELIGIBLE_STATUSES) {
      expect(jobOverdue(at("2026-07-01T00:00:00.000Z"), status, TODAY).overdue, status).toBe(true);
    }
  });

  // The narrowing that matters: without it the list would redden rows nobody can act on, and the
  // badge — which applies the same narrowing — would never agree with them.
  it("never marks finished or abandoned work, however old", () => {
    for (const status of ["completed", "cancelled", "rejected", "draft"]) {
      expect(jobOverdue(at("2020-01-01T00:00:00.000Z"), status, TODAY), status).toEqual({
        overdue: false,
        daysLate: null,
      });
    }
  });

  it("treats a job with no due date as not late", () => {
    expect(jobOverdue(null, "accepted", TODAY)).toEqual({ overdue: false, daysLate: null });
    expect(jobOverdue(undefined, "accepted", TODAY)).toEqual({ overdue: false, daysLate: null });
  });

  it("leaves a future job alone", () => {
    expect(jobOverdue(at("2026-08-25T00:00:00.000Z"), "accepted", TODAY)).toEqual({ overdue: false, daysLate: null });
  });

  // The reason the SERVER answers this at all: the boundary is the company's midnight, not the
  // viewer's. Passing a different dayStart flips the same job, which is exactly what would happen if
  // a browser in another timezone derived it — a red row with no matching count, or the reverse.
  it("follows the day boundary it is given, not any local clock", () => {
    const due = at("2026-08-07T23:30:00.000Z"); // already 8 Aug in London (BST)
    expect(jobOverdue(due, "accepted", new Date("2026-08-08T00:00:00.000Z")).overdue).toBe(true);
    expect(jobOverdue(due, "accepted", new Date("2026-08-07T00:00:00.000Z")).overdue).toBe(false);
  });
});

// One rule, three surfaces. The office list, the engineer's list and the customer portal all mark a
// job late from THIS function against the company-timezone day start — so a customer abroad, an
// engineer in the field and a planner at a desk never see a different set of jobs marked late.
//
// They drifted once already in the direction that is easy to miss: the flag was added to the office
// list and the engineer payload, but only the office list rendered it, and the portal never carried
// it at all. The engineer could FILTER to Overdue while being unable to see which of their rows were.
describe("one overdue rule across office, engineer and portal", () => {
  // Every status a portal job can be in (PORTAL_JOB_STATUSES), answered by the same predicate the
  // internal lists use. The portal shows a customer's own work, so "late" has to mean the same thing.
  it("agrees on every status a customer can see", () => {
    const late = at("2026-07-13T00:00:00.000Z");
    const live = ["assigned", "accepted", "in_progress"];
    const done = ["completed", "cancelled", "rejected"];
    for (const status of live) expect(jobOverdue(late, status, TODAY).overdue, status).toBe(true);
    for (const status of done) expect(jobOverdue(late, status, TODAY).overdue, status).toBe(false);
  });

  // The portal drops `daysLate` deliberately — a running total on a customer's own job reads as an
  // accusation. The FLAG still has to be identical, or the same job would be red on one screen and
  // not on another.
  it("carries the day count for internal surfaces and leaves the flag usable without it", () => {
    const res = jobOverdue(at("2026-07-13T00:00:00.000Z"), "accepted", TODAY);
    expect(res).toEqual({ overdue: true, daysLate: 26 });
    // A caller that shows only the flag still gets the same answer.
    expect(res.overdue).toBe(true);
  });
});
