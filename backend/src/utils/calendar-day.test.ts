import { describe, expect, it } from "vitest";

import { addDays, daysBetween, instantForDay, toCalendarDay } from "./calendar-day.js";

describe("toCalendarDay", () => {
  it("keeps the UTC date and drops the time", () => {
    expect(toCalendarDay("2026-08-24T21:09:25.178Z").toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("throws on anything unparseable rather than returning an invalid date", () => {
    expect(() => toCalendarDay("not a date")).toThrow(/Not a date/);
  });
});

describe("addDays / daysBetween", () => {
  it("moves a calendar day by whole days", () => {
    expect(addDays(toCalendarDay("2026-08-24"), 3).toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("counts whole days between two calendar days", () => {
    expect(daysBetween(toCalendarDay("2026-08-24"), toCalendarDay("2026-08-27"))).toBe(3);
  });
});

// ── A picked DAY landing in a field that stores INSTANTS ────────────────────────────────────────
//
// `declaredAt` on a custody record is an instant, and a damage report carries a day somebody chose on
// a form. The two are not the same kind of value, and the conversion is where the off-by-a-day lives.
describe("instantForDay", () => {
  it("keeps the real instant when the day chosen is the day it is now", () => {
    const now = new Date("2026-08-25T11:16:24.038Z");
    expect(instantForDay(toCalendarDay("2026-08-25"), now)).toStrictEqual(now);
  });

  it("anchors an earlier day at midday, so every timezone reads that same date", () => {
    const now = new Date("2026-08-25T11:16:24.038Z");
    const at = instantForDay(toCalendarDay("2026-08-20"), now);
    expect(at.toISOString()).toBe("2026-08-20T12:00:00.000Z");
    // The point of midday: UTC midnight would render as the 19th for any viewer behind UTC.
    expect(at.toLocaleDateString("en-GB", { timeZone: "America/Los_Angeles", day: "2-digit", month: "short" })).toBe("20 Aug");
    expect(at.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" })).toBe("20 Aug");
  });

  it("anchors a later day the same way rather than inventing a future instant of its own", () => {
    const now = new Date("2026-08-25T11:16:24.038Z");
    expect(instantForDay(toCalendarDay("2026-08-27"), now).toISOString()).toBe("2026-08-27T12:00:00.000Z");
  });

  it("reads the day it is now in UTC, matching how the day itself was stored", () => {
    // 01:30 in Kolkata on the 26th is still the 25th in UTC, which is the day the form would have
    // sent. Reading "today" in the server's local zone would make the two disagree and midday-anchor
    // a day the user picked as today.
    const now = new Date("2026-08-25T20:00:00.000Z");
    expect(instantForDay(toCalendarDay("2026-08-25"), now)).toStrictEqual(now);
  });
});
