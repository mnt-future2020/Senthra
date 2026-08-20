import { describe, expect, it } from "vitest";

import { addDays, daysBetween, toCalendarDay } from "../calendar-day.js";

describe("toCalendarDay", () => {
  it("keeps a date-only string at UTC midnight", () => {
    expect(toCalendarDay("2026-09-01").toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  // The hole this plugs: the PRF rental-line uniqueness index includes both hire dates, so two
  // lines for the same calendar day would NOT collide if one arrived carrying a time.
  it("strips the time of day, so the same day always normalises identically", () => {
    const a = toCalendarDay("2026-09-01");
    const b = toCalendarDay("2026-09-01T09:30:00Z");
    const c = toCalendarDay(new Date("2026-09-01T23:59:59.999Z"));
    expect(a.getTime()).toBe(b.getTime());
    expect(a.getTime()).toBe(c.getTime());
  });

  it("accepts a Date as readily as a string", () => {
    expect(toCalendarDay(new Date("2026-10-01T12:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  // Throwing beats returning an Invalid Date: every comparison against one of those is false, so a
  // bad hire period would read as "never due" and the reminder would silently never fire.
  it("refuses input it cannot parse", () => {
    expect(() => toCalendarDay("not a date")).toThrow(/not a date/i);
    expect(() => toCalendarDay("")).toThrow();
  });
});

describe("addDays", () => {
  it("moves by whole days", () => {
    expect(addDays(toCalendarDay("2026-10-01"), -3).toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(addDays(toCalendarDay("2026-10-01"), 3).toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  it("is a no-op for zero", () => {
    expect(addDays(toCalendarDay("2026-10-01"), 0).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  // UTC midnight to UTC midnight is always exactly n * 86_400_000 ms, so a hire spanning a DST
  // change is unaffected. Timezone-local instants would be 23 or 25 hours out and the reminder
  // would land on the wrong calendar day. (Europe/London springs forward 29 Mar 2026, back 25 Oct.)
  it("is unaffected by a DST transition", () => {
    expect(addDays(toCalendarDay("2026-03-30"), -3).toISOString()).toBe("2026-03-27T00:00:00.000Z");
    expect(addDays(toCalendarDay("2026-10-26"), -3).toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(addDays(toCalendarDay("2026-01-01"), -1).toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(addDays(toCalendarDay("2028-03-01"), -1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days", () => {
    expect(daysBetween(toCalendarDay("2026-09-01"), toCalendarDay("2026-10-01"))).toBe(30);
  });

  it("is zero for the same day", () => {
    expect(daysBetween(toCalendarDay("2026-09-01"), toCalendarDay("2026-09-01"))).toBe(0);
  });

  it("is negative when the second day precedes the first", () => {
    expect(daysBetween(toCalendarDay("2026-09-10"), toCalendarDay("2026-09-01"))).toBe(-9);
  });

  it("stays exact across a DST transition", () => {
    expect(daysBetween(toCalendarDay("2026-03-28"), toCalendarDay("2026-03-31"))).toBe(3);
    expect(daysBetween(toCalendarDay("2026-10-24"), toCalendarDay("2026-10-27"))).toBe(3);
  });
});
