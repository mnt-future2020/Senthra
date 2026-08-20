import { describe, expect, it } from "vitest";

import { heldVsBilled } from "./OnHireView";

// Billed 70 days, held 62 — the one comparison a finished hire is reviewed on, and the reason the
// returned register carries both numbers instead of just the paperwork's.
describe("held against billed", () => {
  it("says nothing when the hire ran exactly as ordered", () => {
    expect(heldVsBilled(70, 70)).toBeNull();
  });

  // Held LONGER than billed is the gap a supplier invoices into — the caller colours it.
  it("flags an overrun as the overrun it is", () => {
    expect(heldVsBilled(74, 70)).toEqual({ label: "4d over", over: true });
  });

  // Back early is good news, not a warning. Reported, not coloured.
  it("reports an early return without calling it a problem", () => {
    expect(heldVsBilled(62, 70)).toEqual({ label: "8d early", over: false });
  });

  // One day either side still has to read as a whole day, not "1d over" vs "-1d over".
  it("never prints a negative day count", () => {
    expect(heldVsBilled(69, 70)?.label).toBe("1d early");
    expect(heldVsBilled(71, 70)?.label).toBe("1d over");
  });
});
