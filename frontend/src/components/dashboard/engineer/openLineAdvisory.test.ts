import { describe, expect, it } from "vitest";

import { openLineAdvisory } from "./openLineAdvisory";

// The advisory that annotates the selected-items table on both van-stock composers.
//
// What these hold is that the sentence is the RIGHT ONE FOR THE SCREEN, and that its length does not
// grow with the cart — the two faults in the string this replaced.

describe("openLineAdvisory", () => {
  const clash = (name: string, code?: string) => ({ name, code });

  it("says nothing when nothing clashes, so no banner is rendered at all", () => {
    expect(openLineAdvisory([], "return")).toBeNull();
    expect(openLineAdvisory([], "restock")).toBeNull();
  });

  describe("the return composer speaks about returns", () => {
    it("uses return vocabulary for one item", () => {
      const a = openLineAdvisory([clash("Fibre Tester", "VSR-0072")], "return")!;
      expect(a.text).toBe("Open return already exists for this item. You can still include it here.");
    });

    it("never says 'request' or 'send' on a return", () => {
      const a = openLineAdvisory([clash("Fibre Tester", "VSR-0072"), clash("CAT36", "VSR-0037")], "return")!;
      expect(a.text).not.toMatch(/request|send/i);
    });

    it("counts the items instead of listing them", () => {
      const a = openLineAdvisory([clash("A", "VSR-1"), clash("B", "VSR-2"), clash("C", "VSR-3")], "return")!;
      expect(a.text).toBe("Open returns already exist for 3 of these items. You can still include them here.");
    });
  });

  it("keeps request vocabulary on the restock composer", () => {
    const a = openLineAdvisory([clash("CAT36", "VSR-0049")], "restock")!;
    expect(a.text).toBe("Open request already exists for this item. You can still send this one.");
  });

  describe("the reference never reaches the primary sentence", () => {
    it("omits the code from the banner and puts it on the detail line", () => {
      const a = openLineAdvisory([clash("Fibre Tester", "VSR-0072")], "return")!;
      expect(a.text).not.toContain("VSR-0072");
      expect(a.detail).toBe("Fibre Tester (VSR-0072)");
    });

    it("still reads correctly when an open line has no code", () => {
      const a = openLineAdvisory([clash("Fibre Tester", undefined)], "return")!;
      expect(a.detail).toBe("Fibre Tester");
      expect(a.detail).not.toContain("undefined");
    });
  });

  describe("length does not grow with the cart", () => {
    it("gives the same banner length for 2 items and for 12", () => {
      const two = openLineAdvisory([clash("A", "VSR-1"), clash("B", "VSR-2")], "return")!;
      const many = openLineAdvisory(Array.from({ length: 12 }, (_, i) => clash(`Item ${i}`, `VSR-${i}`)), "return")!;
      // Only the count differs — "2" vs "12" — so the sentence cannot wrap into extra lines.
      expect(many.text.length - two.text.length).toBe(1);
    });

    it("abbreviates the detail line past two items and keeps the full list for the tooltip", () => {
      const a = openLineAdvisory([clash("A", "VSR-1"), clash("B", "VSR-2"), clash("C", "VSR-3"), clash("D", "VSR-4")], "return")!;
      expect(a.detail).toBe("A (VSR-1) · B (VSR-2) +2 more");
      expect(a.title).toBe("A (VSR-1), B (VSR-2), C (VSR-3), D (VSR-4)");
    });

    it("adds no tooltip when the detail line hid nothing", () => {
      const a = openLineAdvisory([clash("A", "VSR-1"), clash("B", "VSR-2")], "return")!;
      expect(a.title).toBeUndefined();
    });

    it("survives a very long item name without the banner growing", () => {
      const long = "Single-Mode Fibre Optic Cable — 12-Core G.652D, Armoured, 2000m Drum";
      const a = openLineAdvisory([clash(long, "VSR-0037"), clash(long, "VSR-0033")], "return")!;
      // The name lands only on the detail line; the banner stays the fixed two-item sentence.
      expect(a.text).toBe("Open returns already exist for 2 of these items. You can still include them here.");
      expect(a.detail).toContain(long);
    });
  });
});
