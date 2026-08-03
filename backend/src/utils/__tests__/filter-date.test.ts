import { describe, expect, it, vi } from "vitest";

import { parseFilterDate, startOfDayIn } from "../filter-date.js";

describe("parseFilterDate", () => {
  it("widens a date-only value to the START of the UTC day", () => {
    expect(parseFilterDate("2026-07-30", "start")?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  // The whole reason the helper exists: a "To" of 2026-07-30 must include that day's records. Widening
  // to midnight instead would silently drop everything that happened on the last day of the range.
  it("widens a date-only value to the END of the UTC day so the range is inclusive", () => {
    expect(parseFilterDate("2026-07-30", "end")?.toISOString()).toBe("2026-07-30T23:59:59.999Z");
  });

  it("uses a full ISO datetime as-is, both edges", () => {
    expect(parseFilterDate("2026-07-30T09:15:00.000Z", "start")?.toISOString()).toBe("2026-07-30T09:15:00.000Z");
    expect(parseFilterDate("2026-07-30T09:15:00.000Z", "end")?.toISOString()).toBe("2026-07-30T09:15:00.000Z");
  });

  it("returns undefined (no filter) for empty or junk input rather than throwing", () => {
    expect(parseFilterDate(undefined, "start")).toBeUndefined();
    expect(parseFilterDate("", "start")).toBeUndefined();
    expect(parseFilterDate("   ", "start")).toBeUndefined();
    expect(parseFilterDate("not-a-date", "start")).toBeUndefined();
    expect(parseFilterDate("2026-13-45", "end")).toBeUndefined();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseFilterDate("  2026-07-30  ", "start")?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });
});

// One definition of "start of today" now backs FOUR surfaces that each answer "is this job overdue?":
// the dashboard card, the engineer's Overdue filter, the engineer portal's counts and the warehouse
// Due filter. They previously each computed it from UTC, which is a day behind for the first hour of
// every British Summer Time day — so on a UK morning shift they could all be wrong together, and once
// one was fixed alone they would have been wrong differently, which is worse.
describe("startOfDayIn", () => {
  it("returns the UK calendar day during BST, not the UTC one", () => {
    // 23:30 UTC on 3 Aug is already 00:30 on 4 Aug in London.
    expect(startOfDayIn("Europe/London", new Date("2026-08-03T23:30:00.000Z")).toISOString())
      .toBe("2026-08-04T00:00:00.000Z");
  });

  it("leaves winter alone, when the UK is on UTC", () => {
    expect(startOfDayIn("Europe/London", new Date("2026-01-15T23:30:00.000Z")).toISOString())
      .toBe("2026-01-15T00:00:00.000Z");
  });

  it("follows whatever timezone the company is set to", () => {
    // Paris is an hour ahead of London, so it rolls over an hour earlier.
    expect(startOfDayIn("Europe/Paris", new Date("2026-08-03T22:30:00.000Z")).toISOString())
      .toBe("2026-08-04T00:00:00.000Z");
    expect(startOfDayIn("Europe/London", new Date("2026-08-03T22:30:00.000Z")).toISOString())
      .toBe("2026-08-03T00:00:00.000Z");
  });

  // A stored setting can be anything; a due-date filter must not 500 because of it.
  it("falls back to the UTC day on an unusable timezone", () => {
    expect(startOfDayIn("Not/AZone", new Date("2026-08-03T23:30:00.000Z")).toISOString())
      .toBe("2026-08-03T00:00:00.000Z");
  });

  // The unusable-timezone case above THROWS, so a try/catch alone appears to cover this function. It
  // doesn't: a formatter that returns an unexpected SHAPE throws nothing, and `Date.UTC(NaN, ...)`
  // quietly yields an Invalid Date. Every later comparison against it is false, so the whole app would
  // report "nothing due, nothing overdue" as if that were the answer. The parse is checked too.
  it("falls back to the UTC day when the formatted value can't be parsed", () => {
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(() => ({ format: () => "not-a-real-date" }) as never);
    try {
      const out = startOfDayIn("Europe/London", new Date("2026-08-03T15:00:00.000Z"));
      expect(Number.isNaN(out.getTime())).toBe(false);
      expect(out.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    } finally {
      spy.mockRestore();
    }
  });
});
