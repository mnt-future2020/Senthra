import { describe, expect, it } from "vitest";

import { calendarDayWindow, dayWindowFilter, instantDayWindow, isEmptyWindow } from "../filter-date.js";

// Day-window semantics. These are the tests that stop a "To" date silently excluding its own day,
// and stop an instant column being windowed on the UTC day instead of the company's.

const iso = (d: Date | undefined) => d?.toISOString();

describe("calendarDayWindow — columns stored at UTC midnight", () => {
  it("makes a single day a half-open range covering exactly that day", () => {
    const w = calendarDayWindow("2026-08-31", "2026-08-31");
    expect(iso(w.gte)).toBe("2026-08-31T00:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("includes the whole of the TO day", () => {
    const w = calendarDayWindow("2026-08-01", "2026-08-05");
    expect(iso(w.gte)).toBe("2026-08-01T00:00:00.000Z");
    // A row stored at 2026-08-05T00:00:00Z is inside; the 6th is not.
    expect(iso(w.lt)).toBe("2026-08-06T00:00:00.000Z");
  });

  it("supports from-only and to-only", () => {
    expect(iso(calendarDayWindow("2026-08-31", undefined).gte)).toBe("2026-08-31T00:00:00.000Z");
    expect(calendarDayWindow("2026-08-31", undefined).lt).toBeUndefined();
    expect(iso(calendarDayWindow(undefined, "2026-08-31").lt)).toBe("2026-09-01T00:00:00.000Z");
    expect(calendarDayWindow(undefined, "2026-08-31").gte).toBeUndefined();
  });

  it("rolls the month and the year at the boundary", () => {
    expect(iso(calendarDayWindow(undefined, "2026-12-31").lt)).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(calendarDayWindow(undefined, "2026-02-28").lt)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles a leap day", () => {
    expect(iso(calendarDayWindow("2028-02-29", "2028-02-29").lt)).toBe("2028-03-01T00:00:00.000Z");
  });

  it("drops junk rather than throwing — these values come from an editable URL", () => {
    expect(isEmptyWindow(calendarDayWindow("not-a-date", "31/08/2026"))).toBe(true);
    expect(isEmptyWindow(calendarDayWindow("", ""))).toBe(true);
    expect(isEmptyWindow(calendarDayWindow(undefined, undefined))).toBe(true);
    // A date that does not exist must be dropped, never rolled forward into March.
    expect(isEmptyWindow(calendarDayWindow("2026-02-31", undefined))).toBe(true);
    expect(isEmptyWindow(calendarDayWindow("2026-13-01", undefined))).toBe(true);
  });

  it("ignores a full ISO datetime — this filter only speaks calendar days", () => {
    expect(isEmptyWindow(calendarDayWindow("2026-08-31T12:00:00Z", undefined))).toBe(true);
  });
});

describe("instantDayWindow — real timestamps, company timezone", () => {
  it("resolves a BST day to the London boundary, not the UTC one", () => {
    const w = instantDayWindow("2026-08-31", "2026-08-31", "Europe/London");
    // 31 Aug is BST (UTC+1), so the day starts an hour BEFORE UTC midnight.
    expect(iso(w.gte)).toBe("2026-08-30T23:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-08-31T23:00:00.000Z");
  });

  it("resolves a GMT day to UTC midnight", () => {
    const w = instantDayWindow("2026-01-15", "2026-01-15", "Europe/London");
    expect(iso(w.gte)).toBe("2026-01-15T00:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-01-16T00:00:00.000Z");
  });

  it("is exact across the spring-forward transition", () => {
    // 2026-03-29 is the UK spring-forward: 01:00 GMT becomes 02:00 BST. The day is 23h long.
    const w = instantDayWindow("2026-03-29", "2026-03-29", "Europe/London");
    expect(iso(w.gte)).toBe("2026-03-29T00:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-03-29T23:00:00.000Z");
    expect(w.lt!.getTime() - w.gte!.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("is exact across the autumn fall-back transition", () => {
    // 2026-10-25 is the UK fall-back: 02:00 BST becomes 01:00 GMT. The day is 25h long.
    const w = instantDayWindow("2026-10-25", "2026-10-25", "Europe/London");
    expect(iso(w.gte)).toBe("2026-10-24T23:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-10-26T00:00:00.000Z");
    expect(w.lt!.getTime() - w.gte!.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("tiles consecutive days with no gap and no overlap, DST included", () => {
    const a = instantDayWindow("2026-10-24", "2026-10-24", "Europe/London");
    const b = instantDayWindow("2026-10-25", "2026-10-25", "Europe/London");
    const c = instantDayWindow("2026-10-26", "2026-10-26", "Europe/London");
    expect(iso(a.lt)).toBe(iso(b.gte));
    expect(iso(b.lt)).toBe(iso(c.gte));
  });

  it("a multi-day range equals the union of its days", () => {
    const range = instantDayWindow("2026-08-01", "2026-08-05", "Europe/London");
    const first = instantDayWindow("2026-08-01", "2026-08-01", "Europe/London");
    const last = instantDayWindow("2026-08-05", "2026-08-05", "Europe/London");
    expect(iso(range.gte)).toBe(iso(first.gte));
    expect(iso(range.lt)).toBe(iso(last.lt));
  });

  it("honours a zone ahead of UTC", () => {
    const w = instantDayWindow("2026-08-31", "2026-08-31", "Europe/Berlin"); // CEST = UTC+2
    expect(iso(w.gte)).toBe("2026-08-30T22:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-08-31T22:00:00.000Z");
  });

  it("is UTC-identical when the company runs on UTC", () => {
    const w = instantDayWindow("2026-08-31", "2026-08-31", "UTC");
    expect(iso(w.gte)).toBe("2026-08-31T00:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("falls back to the UTC day rather than throwing on an unusable zone", () => {
    const w = instantDayWindow("2026-08-31", "2026-08-31", "Not/AZone");
    expect(iso(w.gte)).toBe("2026-08-31T00:00:00.000Z");
    expect(iso(w.lt)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("supports from-only and to-only", () => {
    expect(instantDayWindow("2026-08-31", undefined, "Europe/London").lt).toBeUndefined();
    expect(instantDayWindow(undefined, "2026-08-31", "Europe/London").gte).toBeUndefined();
  });

  it("drops junk", () => {
    expect(isEmptyWindow(instantDayWindow("nope", "", "Europe/London"))).toBe(true);
  });
});

describe("dayWindowFilter", () => {
  it("returns undefined for an empty window so the where key is omitted entirely", () => {
    expect(dayWindowFilter(calendarDayWindow(undefined, undefined))).toBeUndefined();
  });

  it("passes a populated window straight through", () => {
    const w = calendarDayWindow("2026-08-31", undefined);
    expect(dayWindowFilter(w)).toBe(w);
  });
});
