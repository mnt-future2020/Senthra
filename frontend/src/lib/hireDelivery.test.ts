import { describe, expect, it } from "vitest";

import { earliestHireStart, hireDeliveryWarning, lateHireDeliveryDays } from "./hireDelivery";

const row = (hireStartDate: string) => ({ hireStartDate });

describe("earliestHireStart", () => {
  // Feeds the form's default: the requester picks a hire period, and the date the kit is needed is
  // the day that hire starts. Filling it in beats asking them to type the same date twice.
  it("returns the earliest start across the hire rows", () => {
    expect(earliestHireStart([row("2026-09-05"), row("2026-09-01"), row("2026-09-20")])).toBe("2026-09-01");
  });

  it("ignores rows whose hire start has not been picked yet", () => {
    expect(earliestHireStart([row(""), row("2026-09-05"), row("")])).toBe("2026-09-05");
  });

  it("is null when there is nothing to go on", () => {
    expect(earliestHireStart([])).toBeNull();
    expect(earliestHireStart([row(""), row("")])).toBeNull();
    expect(earliestHireStart([row("not a date")])).toBeNull();
  });
});

describe("lateHireDeliveryDays", () => {
  it("counts the days a delivery lands after the hire has started", () => {
    expect(lateHireDeliveryDays("2026-09-03", [row("2026-09-01")])).toBe(2);
  });

  it("is null when the kit arrives on or before the hire starts", () => {
    expect(lateHireDeliveryDays("2026-09-01", [row("2026-09-01")])).toBeNull();
    expect(lateHireDeliveryDays("2026-08-28", [row("2026-09-01")])).toBeNull();
  });

  // A one-day hire is ordinary. The rule is about the DELIVERY date, never the hire's length.
  it("says nothing about a one-day hire delivered on its start date", () => {
    expect(lateHireDeliveryDays("2026-08-18", [row("2026-08-18")])).toBeNull();
  });

  it("measures against the earliest hire on the request", () => {
    expect(lateHireDeliveryDays("2026-09-03", [row("2026-09-10"), row("2026-09-01")])).toBe(2);
  });

  it("is null while either date is still blank or unusable", () => {
    expect(lateHireDeliveryDays("", [row("2026-09-01")])).toBeNull();
    expect(lateHireDeliveryDays("2026-09-03", [])).toBeNull();
    expect(lateHireDeliveryDays("nonsense", [row("2026-09-01")])).toBeNull();
  });
});

describe("hireDeliveryWarning", () => {
  // ONE wording for the form, the request page and the order page — three hand-written variants of
  // the same warning is how a user ends up unsure whether they are being told two different things.
  it("names the hire start and what the mismatch costs", () => {
    const msg = hireDeliveryWarning(2, "2026-09-01");
    expect(msg).toContain("2 days");
    expect(msg).toContain("01/09/2026");
    expect(msg).toMatch(/billed/i);
  });

  it("says day, not days, for a single day", () => {
    expect(hireDeliveryWarning(1, "2026-09-01")).toContain("1 day after");
  });
});
