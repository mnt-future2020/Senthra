import { describe, expect, it } from "vitest";

import { assertRangeWithinLimit, parseLimit } from "./reports.validation.js";
import { MAX_CUSTOM_RANGE_DAYS } from "./reports.constants.js";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

// ── `?limit=` ─────────────────────────────────────────────────────────────────────────────────
//
// The clamp this replaced was `Math.min(Math.max(req.limit ?? 100, 1), MAX)`, which looks airtight
// and is not: every comparison against NaN is false, so NaN passes through Math.max AND Math.min
// unchanged and arrives at Prisma as `take: NaN`. The user saw a 500 for a typo in a query string.
describe("parseLimit", () => {
  it("accepts a positive whole number", () => {
    expect(parseLimit("250")).toBe(250);
    expect(parseLimit("1")).toBe(1);
  });

  it("treats an absent or empty limit as 'unset', not as an error", () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit("")).toBeUndefined();
  });

  // THE regression: a 400 that names the problem, not a 500 that blames the server.
  it("rejects a non-numeric limit with a 400", () => {
    expect(() => parseLimit("abc")).toThrow(/positive whole number/i);
    expect(() => parseLimit("abc")).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("rejects the values that would reach the database as NaN or nonsense", () => {
    for (const bad of ["NaN", "Infinity", "-Infinity", "1e999", "12abc"]) {
      expect(() => parseLimit(bad), `"${bad}" must be refused`).toThrow(/positive whole number/i);
    }
  });

  it("rejects zero, negatives and fractions rather than silently clamping them", () => {
    // Silently clamping is what hid the NaN case: a clamp answers every input, including the ones
    // that mean the caller has a bug.
    for (const bad of ["0", "-5", "2.5"]) {
      expect(() => parseLimit(bad), `"${bad}" must be refused`).toThrow(/positive whole number/i);
    }
  });
});

// ── Custom period width ───────────────────────────────────────────────────────────────────────
//
// Unbounded, `from=2000-01-01&to=2030-12-31` made the two-step read pull every purchase order ever
// raised (and every line under it) into one process. Authenticated, but still a self-DoS, and no
// figure on the page needed it.
describe("assertRangeWithinLimit", () => {
  it("allows a full year — the widest period the report actually describes", () => {
    expect(() => assertRangeWithinLimit(day(0), day(MAX_CUSTOM_RANGE_DAYS))).not.toThrow();
  });

  it("refuses a decade", () => {
    expect(() => assertRangeWithinLimit(new Date("2000-01-01"), new Date("2030-12-31"))).toThrow(/at most/i);
    expect(() => assertRangeWithinLimit(new Date("2000-01-01"), new Date("2030-12-31"))).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("refuses the first day past the limit and no earlier", () => {
    expect(() => assertRangeWithinLimit(day(0), day(MAX_CUSTOM_RANGE_DAYS))).not.toThrow();
    expect(() => assertRangeWithinLimit(day(0), day(MAX_CUSTOM_RANGE_DAYS + 1))).toThrow(/at most/i);
  });

  // Bounds are ordered first, matching resolvePeriod. Somebody who fills the dates in backwards asked
  // for a span, not a negative one — telling them it is "too wide" would be a confusing lie.
  it("orders swapped bounds rather than judging a negative span", () => {
    expect(() => assertRangeWithinLimit(day(30), day(0))).not.toThrow();
    expect(() => assertRangeWithinLimit(day(MAX_CUSTOM_RANGE_DAYS + 1), day(0))).toThrow(/at most/i);
  });

  // week/month resolve their own bounds; only a custom range arrives with both dates set.
  it("ignores a half-open or absent range", () => {
    expect(() => assertRangeWithinLimit(undefined, undefined)).not.toThrow();
    expect(() => assertRangeWithinLimit(day(0), undefined)).not.toThrow();
    expect(() => assertRangeWithinLimit(undefined, day(0))).not.toThrow();
  });
});
