import { describe, expect, it } from "vitest";

import { RENTAL_COUNTER_KEY, formatRentalCode } from "./rentalCode.js";

describe("formatRentalCode", () => {
  it("pads to four digits", () => {
    expect(formatRentalCode("RNT", 1)).toBe("RNT-0001");
    expect(formatRentalCode("RNT", 42)).toBe("RNT-0042");
    expect(formatRentalCode("RNT", 9999)).toBe("RNT-9999");
  });

  // Past 9999 the code GROWS rather than wrapping — a wrapped code would collide with a live one,
  // and `code` is uniquely indexed, so the create would simply fail.
  it("grows past four digits instead of wrapping", () => {
    expect(formatRentalCode("RNT", 10_000)).toBe("RNT-10000");
  });

  // The prefix is configurable in Settings → Branding, so nothing here may assume "RNT".
  it("uses whatever prefix it is given", () => {
    expect(formatRentalCode("EQP", 7)).toBe("EQP-0007");
    expect(formatRentalCode("HIRE", 7)).toBe("HIRE-0007");
  });

  // The NUMBER is one shared sequence, so two prefixes never produce the same number twice — which is
  // exactly why the counter key below is not the prefix.
  it("keeps the number when only the prefix changes", () => {
    expect(formatRentalCode("EQP", 11).endsWith("-0011")).toBe(true);
    expect(formatRentalCode("RNT", 11).endsWith("-0011")).toBe(true);
  });
});

describe("RENTAL_COUNTER_KEY", () => {
  // Fixed, never derived from a setting: the key is what makes numbering monotonic, so changing it
  // would restart the sequence and mint codes that already exist. The DISPLAY prefix is configurable;
  // this is not, and the two must never be wired together.
  it("is the fixed RNT sequence key", () => {
    expect(RENTAL_COUNTER_KEY).toBe("RNT");
  });
});
