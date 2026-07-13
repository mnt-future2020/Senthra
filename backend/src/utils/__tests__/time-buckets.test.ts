import { describe, it, expect } from "vitest";
import {
  isoWeekKeysBack,
  monthKeysBack,
  dayKeysBack,
  bucketByWeek,
  bucketByMonth,
  bucketValueByWeek,
  bucketValueByDay,
} from "../time-buckets.js";

describe("monthKeysBack", () => {
  it("returns N ascending YYYY-MM keys ending at the anchor month", () => {
    const keys = monthKeysBack(12, new Date("2026-07-09T00:00:00Z"));
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-07");
    expect(keys[0]).toBe("2025-08");
  });
  it("crosses year boundaries correctly", () => {
    const keys = monthKeysBack(3, new Date("2026-01-15T00:00:00Z"));
    expect(keys).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("bucketByMonth", () => {
  it("zero-fills empty months and sums values into the right bucket", () => {
    const anchor = new Date("2026-03-31T00:00:00Z");
    const rows = [
      { at: new Date("2026-03-02T10:00:00Z"), value: 100 },
      { at: new Date("2026-03-20T10:00:00Z"), value: 50 },
      { at: new Date("2026-01-10T10:00:00Z"), value: 25 },
    ];
    const out = bucketByMonth(rows, 3, anchor);
    expect(out).toEqual([
      { period: "2026-01", totalPence: 25 },
      { period: "2026-02", totalPence: 0 },
      { period: "2026-03", totalPence: 150 },
    ]);
  });
  it("ignores rows outside the window", () => {
    const anchor = new Date("2026-03-31T00:00:00Z");
    const out = bucketByMonth([{ at: new Date("2025-01-01T00:00:00Z"), value: 999 }], 3, anchor);
    expect(out.every((b) => b.totalPence === 0)).toBe(true);
  });
});

describe("isoWeekKeysBack / bucketByWeek", () => {
  it("returns N weekly counts ending at the anchor week", () => {
    const anchor = new Date("2026-07-09T00:00:00Z"); // Thursday
    const keys = isoWeekKeysBack(8, anchor);
    expect(keys).toHaveLength(8);
    const counts = bucketByWeek(
      [{ at: anchor }, { at: anchor }, { at: new Date("2026-05-01T00:00:00Z") }],
      8,
      anchor,
    );
    expect(counts).toHaveLength(8);
    expect(counts[7]).toBe(2); // two in the anchor week
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2); // the May row is outside the 8-week window
  });
});

describe("bucketValueByWeek", () => {
  it("sums values into Monday-keyed weekly buckets, zero-filling empty weeks", () => {
    const anchor = new Date("2026-07-09T00:00:00Z"); // Thursday → anchor week starts Mon 2026-07-06
    const rows = [
      { at: new Date("2026-07-07T12:00:00Z"), value: 100 }, // anchor week
      { at: new Date("2026-07-06T00:00:00Z"), value: 50 }, // anchor week (Monday itself)
      { at: new Date("2026-06-30T00:00:00Z"), value: 25 }, // previous week
    ];
    const out = bucketValueByWeek(rows, 3, anchor);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ period: "2026-07-06", totalPence: 150 });
    expect(out[1]).toEqual({ period: "2026-06-29", totalPence: 25 });
    expect(out[0].totalPence).toBe(0);
  });
});

describe("dayKeysBack / bucketValueByDay", () => {
  it("returns N ascending day keys ending at the anchor day", () => {
    const keys = dayKeysBack(3, new Date("2026-03-01T15:00:00Z"));
    expect(keys).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]); // crosses month boundary
  });
  it("sums values into daily buckets, zero-filling empty days", () => {
    const anchor = new Date("2026-07-09T23:59:00Z");
    const rows = [
      { at: new Date("2026-07-09T01:00:00Z"), value: 10 },
      { at: new Date("2026-07-09T20:00:00Z"), value: 5 },
      { at: new Date("2026-07-07T10:00:00Z"), value: 7 },
      { at: new Date("2026-06-01T10:00:00Z"), value: 999 }, // outside window
    ];
    const out = bucketValueByDay(rows, 3, anchor);
    expect(out).toEqual([
      { period: "2026-07-07", totalPence: 7 },
      { period: "2026-07-08", totalPence: 0 },
      { period: "2026-07-09", totalPence: 15 },
    ]);
  });
});
