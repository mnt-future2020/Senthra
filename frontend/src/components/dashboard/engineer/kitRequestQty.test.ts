import { describe, expect, it } from "vitest";

import { capQty } from "./kitRequestQty";

// A quantity can outlive the availability figure it was typed against — set before the lookup landed,
// or left standing when a refetch returns a smaller number. Clamping at READ time is what keeps the
// box and the payload honest; these cases pin down what "honest" means at each edge.
describe("capQty", () => {
  describe("unknown availability is never capped on a guess", () => {
    it("leaves the quantity alone when there is no figure", () => {
      // Misc lines (free text, nothing to run out of) and failed lookups both land here.
      expect(capQty(50, null)).toBe(50);
      expect(capQty(50, null, 1)).toBe(50);
    });
  });

  describe("a known figure caps the quantity", () => {
    it("clamps down to what is free", () => {
      expect(capQty(10, 5)).toBe(5);
    });

    it("leaves a quantity that already fits", () => {
      expect(capQty(2, 5)).toBe(2);
    });

    it("raises a quantity below the row's minimum", () => {
      // Cart rows start at 1 — a row exists because the engineer asked for it.
      expect(capQty(0, 5, 1)).toBe(1);
    });
  });

  // The bug this function exists to close. `Math.max(min, Math.min(qty, free))` with min=1 and free=0
  // returns 1, so a cart row reading "None free to request" still shipped a quantity of 1 to the
  // planner. The minimum only applies when there is something to give.
  describe("nothing free means ZERO, whatever the row's minimum is", () => {
    it("returns 0 for a cart row (minimum 1) with nothing free", () => {
      expect(capQty(1, 0, 1)).toBe(0);
      expect(capQty(9, 0, 1)).toBe(0);
    });

    it("returns 0 for a planned row (minimum 0) with nothing free", () => {
      expect(capQty(3, 0)).toBe(0);
    });

    it("treats a negative figure as nothing free rather than a negative quantity", () => {
      // quantityOnHand − quantityReserved can go negative on an over-reserved balance.
      expect(capQty(3, -2, 1)).toBe(0);
    });
  });

  // What the caller relies on to drop the line: a capped-to-zero quantity fails `qty > 0`, so the row
  // never reaches the payload. That is the whole mechanism, so it is worth stating as a test.
  describe("the drop rule the payload builder depends on", () => {
    it("caps to a falsy-for-submit quantity exactly when nothing is free", () => {
      expect(capQty(1, 0, 1) > 0).toBe(false);
      expect(capQty(1, 1, 1) > 0).toBe(true);
      expect(capQty(1, null, 1) > 0).toBe(true);
    });
  });
});
