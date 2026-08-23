import { describe, expect, it } from "vitest";

import { dueLabel } from "./hireDeadline";

describe("dueLabel", () => {
  it("counts down the days left", () => {
    expect(dueLabel({ dueInDays: 3, overdue: false })).toBe("3 days left");
  });

  it("says today rather than '0 days left' on the deadline day", () => {
    // The engineer has all of the last day to get it back. "0 days left" reads as already too late
    // and would send someone chasing a hire that is not late yet.
    expect(dueLabel({ dueInDays: 0, overdue: false })).toBe("Due back today");
  });

  it("counts up once overdue, from the negative the server sends", () => {
    expect(dueLabel({ dueInDays: -2, overdue: true })).toBe("2 days overdue");
  });

  it("keeps singular at exactly one day, both directions", () => {
    expect(dueLabel({ dueInDays: 1, overdue: false })).toBe("1 day left");
    expect(dueLabel({ dueInDays: -1, overdue: true })).toBe("1 day overdue");
  });

  it("says so plainly when the hire carries no deadline snapshot", () => {
    // A holding written before the deadline was snapshotted. Better to admit there is no date than
    // to render an em dash the engineer reads as "nothing due".
    expect(dueLabel({ dueInDays: null, overdue: false })).toBe("No date on record");
  });

  it("trusts `overdue` over the sign of the day count", () => {
    // The two come from the same server computation, so they cannot disagree in practice — pinned
    // because the alternative (deriving overdue from `dueInDays < 0` here) is exactly the
    // browser-clock reasoning this module exists to keep out.
    expect(dueLabel({ dueInDays: 0, overdue: true })).toBe("0 days overdue");
  });
});
