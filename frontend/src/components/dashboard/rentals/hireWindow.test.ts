import { describe, expect, it } from "vitest";

import { daysRemainingLabel, hireLengthDays, hireWindowState } from "./hireWindow";

describe("hireLengthDays", () => {
  it("counts whole days between the two dates", () => {
    expect(hireLengthDays("2026-09-01", "2026-10-01")).toBe(30);
  });

  it("is zero for the same day", () => {
    expect(hireLengthDays("2026-09-01", "2026-09-01")).toBe(0);
  });

  // The server stores UTC midnights, so a time-of-day on either end must not shift the count.
  it("ignores the time of day", () => {
    expect(hireLengthDays("2026-09-01T22:00:00Z", "2026-10-01T01:00:00Z")).toBe(30);
  });

  it("stays exact across a DST transition", () => {
    expect(hireLengthDays("2026-03-28", "2026-03-31")).toBe(3);
  });
});

describe("hireWindowState", () => {
  const today = new Date("2026-09-28T12:00:00Z");

  it("is expiring when the reminder date has arrived", () => {
    expect(hireWindowState("2026-10-01", 3, today)).toBe("expiring");
  });

  it("is ok while the reminder date is still ahead", () => {
    expect(hireWindowState("2026-11-01", 3, today)).toBe("ok");
  });

  it("is overdue once the end date has passed", () => {
    expect(hireWindowState("2026-09-27", 3, today)).toBe("overdue");
  });

  it("is still expiring, not overdue, on the last day", () => {
    expect(hireWindowState("2026-09-28", 3, today)).toBe("expiring");
  });

  // Same disjointness the server predicates guarantee: never both.
  it("never reports expiring for an already-overdue hire", () => {
    expect(hireWindowState("2026-09-01", 30, today)).toBe("overdue");
  });

  // Mirrors the server's clamp: a lead longer than the hire reports expiring from the START date,
  // never before it. Without the start date the raw subtraction would colour it early.
  it("reports expiring from the start date when the lead exceeds the hire", () => {
    expect(hireWindowState("2026-09-30", 60, new Date("2026-09-29T12:00:00Z"), "2026-09-29")).toBe("expiring");
    expect(hireWindowState("2026-09-30", 60, new Date("2026-09-28T12:00:00Z"), "2026-09-29")).toBe("ok");
  });
});

describe("daysRemainingLabel", () => {
  it("reads naturally either side of the deadline", () => {
    expect(daysRemainingLabel(3)).toBe("3 days left");
    expect(daysRemainingLabel(1)).toBe("1 day left");
    expect(daysRemainingLabel(0)).toBe("ends today");
    expect(daysRemainingLabel(-1)).toBe("1 day over");
    expect(daysRemainingLabel(-5)).toBe("5 days over");
  });
});
