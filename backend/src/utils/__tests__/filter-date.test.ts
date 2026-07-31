import { describe, expect, it } from "vitest";

import { parseFilterDate } from "../filter-date.js";

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
