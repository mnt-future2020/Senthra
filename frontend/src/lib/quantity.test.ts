import { describe, expect, it } from "vitest";

import { clampQuantityInput } from "./quantity";

// The quantity box clamps AS YOU TYPE rather than rejecting on submit, so an impossible number never
// sits in the field. Typing 999 against 1 available should land on 1, not wait to be refused.
describe("clampQuantityInput", () => {
  it("caps at the available quantity", () => {
    expect(clampQuantityInput("999", 1)).toBe("1");
    expect(clampQuantityInput("20", 15)).toBe("15");
  });

  it("leaves an in-range value alone", () => {
    expect(clampQuantityInput("1", 15)).toBe("1");
    expect(clampQuantityInput("12", 15)).toBe("12");
    expect(clampQuantityInput("15", 15)).toBe("15");
  });

  it("floors to at least 1 — you can't damage zero or a negative", () => {
    expect(clampQuantityInput("0", 10)).toBe("1");
    expect(clampQuantityInput("-5", 10)).toBe("1");
  });

  it("drops a decimal rather than rounding up past the cap", () => {
    expect(clampQuantityInput("2.9", 10)).toBe("2");
    expect(clampQuantityInput("10.9", 10)).toBe("10");
  });

  it("allows an empty field so it can be cleared and retyped mid-edit", () => {
    expect(clampQuantityInput("", 10)).toBe("");
  });

  it("ignores junk entirely (null = swallow the keystroke, don't blank the field)", () => {
    // A number input still admits a lone "-" or "e"; those must not wipe what's already typed.
    expect(clampQuantityInput("-", 10)).toBeNull();
    expect(clampQuantityInput("abc", 10)).toBeNull();
  });

  it("still caps correctly when only one unit is available", () => {
    expect(clampQuantityInput("2", 1)).toBe("1");
    expect(clampQuantityInput("1", 1)).toBe("1");
  });

  // With nothing available there is no value in 1..max to clamp to. Rewriting the keystroke to "0"
  // anyway froze the field: the submit gate blocks 0, and the caller's own "more than available"
  // message is `qty > available`, which 0 > 0 never satisfies — so the user was told nothing at all.
  // The typed number has to survive so the caller can explain why it's refused.
  it("passes the typed number through when nothing is available to clamp to", () => {
    expect(clampQuantityInput("5", 0)).toBe("5");
    expect(clampQuantityInput("1", 0)).toBe("1");
  });

  it("still refuses a negative when nothing is available", () => {
    expect(clampQuantityInput("-5", 0)).toBe("0");
    expect(clampQuantityInput("-", 0)).toBeNull();
  });
});
