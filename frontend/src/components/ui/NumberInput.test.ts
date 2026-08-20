import { describe, expect, it } from "vitest";

import { clampNumberInput } from "./NumberInput";

// `max` on a native <input type="number"> binds the SPINNER and native validation — it does nothing
// about typing. So a receive form offering "of those, damaged" against a single ordered unit happily
// took 534345 and answered with a red line underneath, which is a correction after the fact rather
// than a field that cannot hold a wrong answer. On a bounded quantity the bound is knowable while
// the key is pressed, so it is enforced there.
describe("clampNumberInput", () => {
  it("holds a value inside the bound", () => {
    expect(clampNumberInput("534345", 0, 1)).toBe("1");
    expect(clampNumberInput("7", 0, 5)).toBe("5");
  });

  it("leaves a value that already fits alone", () => {
    expect(clampNumberInput("3", 0, 5)).toBe("3");
    expect(clampNumberInput("5", 0, 5)).toBe("5");
    expect(clampNumberInput("0", 0, 5)).toBe("0");
  });

  it("lifts a value under the floor", () => {
    expect(clampNumberInput("0", 1, 5)).toBe("1");
    expect(clampNumberInput("-4", 1, 5)).toBe("1");
  });

  // Emptying the box is how you retype it. Clamping "" to the minimum would make the field
  // impossible to clear — every backspace to empty would spring back to 1.
  it("leaves an empty field empty", () => {
    expect(clampNumberInput("", 1, 5)).toBe("");
    expect(clampNumberInput("   ", 1, 5)).toBe("   ");
  });

  // A half-typed or unparseable value is left for the parser and the submit guard to judge; rewriting
  // it mid-keystroke would fight the user.
  it("leaves anything that is not a number alone", () => {
    expect(clampNumberInput("abc", 0, 5)).toBe("abc");
    expect(clampNumberInput("1.", 0, 5)).toBe("1.");
  });

  // An unbounded field is the common case — most quantities have no ceiling worth enforcing.
  it("does nothing without a bound", () => {
    expect(clampNumberInput("534345", undefined, undefined)).toBe("534345");
    expect(clampNumberInput("534345", 0, undefined)).toBe("534345");
  });

  // `max={receiveNum || undefined}` is a real call site: while the quantity above is blank there is
  // no ceiling yet, and inventing one (0) would pin the field shut.
  it("treats an absent max as no ceiling rather than zero", () => {
    expect(clampNumberInput("4", 0, undefined)).toBe("4");
  });
});
