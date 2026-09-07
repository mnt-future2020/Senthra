import { describe, expect, it } from "vitest";

import { earliestExtensionDay, extensionDateProblem } from "./hireExtension";

describe("earliestExtensionDay", () => {
  it("is the day after the current end date", () => {
    expect(earliestExtensionDay("2026-09-08")).toBe("2026-09-09");
  });

  // The bug this exists to prevent: `min` set to the current end let the browser accept 08 Sept for
  // a hire already ending 08 Sept, which the server then refused.
  it("never offers the current end date itself", () => {
    expect(earliestExtensionDay("2026-09-08")).not.toBe("2026-09-08");
  });

  it("crosses a month boundary", () => {
    expect(earliestExtensionDay("2026-09-30")).toBe("2026-10-01");
  });

  it("crosses a year boundary", () => {
    expect(earliestExtensionDay("2026-12-31")).toBe("2027-01-01");
  });

  it("crosses a leap day", () => {
    expect(earliestExtensionDay("2028-02-28")).toBe("2028-02-29");
  });

  // Hire dates come back as UTC midnights, but a stored time-of-day must not push the floor a day out.
  it("ignores the time of day", () => {
    expect(earliestExtensionDay("2026-09-08T22:30:00Z")).toBe("2026-09-09");
  });

  it("stays exact across a DST transition", () => {
    expect(earliestExtensionDay("2026-03-28")).toBe("2026-03-29");
  });

  it("is empty when there is no usable date, so the caller drops the attribute", () => {
    expect(earliestExtensionDay(null)).toBe("");
    expect(earliestExtensionDay(undefined)).toBe("");
    expect(earliestExtensionDay("")).toBe("");
    expect(earliestExtensionDay("not a date")).toBe("");
  });
});

describe("extensionDateProblem", () => {
  const currentEnd = "2026-09-08T00:00:00.000Z";

  it("passes a date after the current end", () => {
    expect(extensionDateProblem(currentEnd, "2026-09-09")).toBeNull();
  });

  // The exact case from the field: 08 Sept typed against a hire already ending 08 Sept.
  it("refuses the current end date itself, in the server's words", () => {
    expect(extensionDateProblem(currentEnd, "2026-09-08")).toBe(
      "The new hire end date must be after the current end date.",
    );
  });

  it("refuses a date before the current end", () => {
    expect(extensionDateProblem(currentEnd, "2026-09-01")).toBe(
      "The new hire end date must be after the current end date.",
    );
  });

  it("asks for a date when the box is empty", () => {
    expect(extensionDateProblem(currentEnd, "")).toBe("Select a new hire end date.");
  });

  it("rejects an unparseable date", () => {
    expect(extensionDateProblem(currentEnd, "31/02/2026")).toBe("Enter a valid date.");
  });

  it("compares calendar days, not instants", () => {
    // Same calendar day as the current end, later in it — still not an extension.
    expect(extensionDateProblem(currentEnd, "2026-09-08T23:59:00Z")).toBe(
      "The new hire end date must be after the current end date.",
    );
  });

  it("leaves a missing current end to the server rather than blocking the dialog", () => {
    expect(extensionDateProblem(null, "2026-09-09")).toBeNull();
  });
});
