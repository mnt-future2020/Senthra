import { describe, expect, it } from "vitest";

import { countPillCls } from "./styles";

// The badge's box used to be whatever its text measured: "9" came out ~18x18 and read as a circle,
// "28" came out ~24x18 and read as an oval, so one sidebar column showed two shapes depending on the
// number in it. `rounded-full` on a box that is not square gives a stadium, never a circle.
//
// Stating the height and the minimum width is the whole fix, so this guards those two specifically —
// a later "simplify" back to padding-only would restore the bug and look tidier doing it.
describe("the count pill's shape is stated, not inherited from padding", () => {
  it("pins an explicit height", () => {
    expect(countPillCls).toMatch(/\bh-\[\d+px\]/);
  });

  // min-width EQUAL to the height is what makes a single digit a true circle.
  it("floors the width at the height", () => {
    const h = countPillCls.match(/\bh-\[(\d+)px\]/)?.[1];
    const w = countPillCls.match(/\bmin-w-\[(\d+)px\]/)?.[1];
    expect(w, "no min-width — a one-digit badge is only round by accident").toBeDefined();
    expect(w).toBe(h);
  });

  // Centred in both axes, or a fixed-height box leaves the digit sitting off-baseline.
  it("centres the number in the box", () => {
    expect(countPillCls).toContain("items-center");
    expect(countPillCls).toContain("justify-center");
  });

  // Digits of equal width, so a count ticking 9 → 10 does not shuffle the row beside it.
  it("uses tabular figures", () => {
    expect(countPillCls).toContain("tabular-nums");
  });

  // Geometry only: tone belongs to the caller — the sidebar badge is solid and loud, the tab and row
  // counts are tinted and quiet, and that difference is deliberate.
  it("carries no colour", () => {
    expect(countPillCls).not.toMatch(/\bbg-|\btext-\[var|\btext-white\b/);
  });
});
