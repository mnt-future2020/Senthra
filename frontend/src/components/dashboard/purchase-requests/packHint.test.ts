import { describe, expect, it } from "vitest";

import { packHint } from "./packHint";

describe("packHint", () => {
  // Nothing to say when the item isn't sold in packs. A pack of 1 IS "sold individually" in the data,
  // so treating it as a pack would put a pointless note on nearly every line.
  it("stays silent when there is no pack size", () => {
    expect(packHint(null, "10")).toBeNull();
    expect(packHint(undefined, "10")).toBeNull();
    expect(packHint(0, "10")).toBeNull();
    expect(packHint(1, "10")).toBeNull();
  });

  it("names the pack size before anything is typed", () => {
    expect(packHint(305, "")).toBe("Sold in packs of 305.");
    expect(packHint(305, "   ")).toBe("Sold in packs of 305.");
  });

  it("confirms a quantity that is already whole packs", () => {
    expect(packHint(305, "610")).toBe("2 packs of 305.");
    expect(packHint(305, "305")).toBe("1 pack of 305."); // singular
  });

  // The case this exists for: 380 metres of a 305m-box cable is not orderable, and nothing else on
  // the form would have said so.
  it("points at the next whole pack when the quantity does not fit", () => {
    expect(packHint(305, "380")).toBe("Packs of 305 — 610 would be 2 packs.");
  });

  it("rounds UP, never down — a short order leaves the shelf short again", () => {
    expect(packHint(100, "101")).toBe("Packs of 100 — 200 would be 2 packs.");
  });

  // The first thing anyone sees: a fresh line defaults to quantity 1, so the SINGULAR branch of the
  // rounded message renders before any other. It read "1 full packs" — the one case the original
  // tests skipped, and the one guaranteed to be on screen.
  it("says one PACK, not one packs, when the round-up lands on a single pack", () => {
    expect(packHint(305, "1")).toBe("Packs of 305 — 305 would be 1 pack.");
    expect(packHint(6, "2")).toBe("Packs of 6 — 6 would be 1 pack.");
  });

  it("treats a fractional quantity as not fitting", () => {
    expect(packHint(10, "15.5")).toBe("Packs of 10 — 20 would be 2 packs.");
  });

  // A half-typed or cleared box must not produce a nonsense figure.
  it("falls back to the plain statement for unusable input", () => {
    expect(packHint(305, "abc")).toBe("Sold in packs of 305.");
    expect(packHint(305, "0")).toBe("Sold in packs of 305.");
    expect(packHint(305, "-5")).toBe("Sold in packs of 305.");
  });
});
