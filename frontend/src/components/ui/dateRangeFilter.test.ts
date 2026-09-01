import { describe, expect, it } from "vitest";

import { dateRangeActive } from "./DateRangeFilter";

// The FilterPopover trigger counts what is ACTIVE, and that count is the whole bargain of folding a
// filter away: a narrowed list must never read as a short one. So "is this range narrowing
// anything" has to be one shared answer, not a `from || to` written at each of ~15 call sites.

describe("dateRangeActive", () => {
  it("is inactive when neither end is set", () => {
    expect(dateRangeActive("", "")).toBe(false);
  });

  it("is ACTIVE with only a lower bound — 'everything since the 1st' narrows the list", () => {
    expect(dateRangeActive("2026-08-01", "")).toBe(true);
  });

  it("is ACTIVE with only an upper bound", () => {
    expect(dateRangeActive("", "2026-08-31")).toBe(true);
  });

  it("is active with both", () => {
    expect(dateRangeActive("2026-08-01", "2026-08-31")).toBe(true);
  });

  it("counts a single day as active", () => {
    expect(dateRangeActive("2026-08-31", "2026-08-31")).toBe(true);
  });
});
