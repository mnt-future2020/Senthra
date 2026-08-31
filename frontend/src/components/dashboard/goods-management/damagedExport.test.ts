import { describe, expect, it } from "vitest";

import { damagedExportState } from "./DamagedStockView";

/**
 * When the damaged-stock export may run, and how the reason reaches the reader.
 *
 * The search box on this screen matches item name, damage REASON, order and job. The stock-position
 * ledger the export reads matches item name, SKU and item code — and a damaged position carries
 * neither a reason nor a code. So the same word means two different queries, and forwarding the term
 * would answer the wrong one in silence: "cracked screen" would come back empty and read as missing
 * data rather than a mismatched filter.
 *
 * The export therefore stands down while a search is active — and says so IN THE PAGE. A `title`
 * alone was the first attempt and is not enough: a disabled button cannot take focus, and nothing
 * hovers on the warehouse tablet this screen is used on, so a greyed control with no visible reason
 * reads as broken.
 */
const state = (over: Partial<Parameters<typeof damagedExportState>[0]> = {}) =>
  damagedExportState({ search: "", exportableCount: 5, scoped: false, ...over });

describe("damagedExportState", () => {
  describe("with no search", () => {
    it("exports normally when there are rows", () => {
      expect(state()).toMatchObject({ disabled: false, reason: null });
    });

    it("is DISABLED with nothing to export — the convention every other export follows", () => {
      expect(state({ exportableCount: 0 }).disabled).toBe(true);
    });

    it("says nothing is there rather than describing a download that cannot happen", () => {
      expect(state({ exportableCount: 0 }).title).toMatch(/nothing to export/i);
    });

    it("names the warehouse scope when this instance is pinned to one", () => {
      expect(state({ scoped: true }).title).toMatch(/this warehouse/i);
      expect(state({ scoped: false }).title).toMatch(/every owned/i);
    });

    it("still says hired equipment is elsewhere — the file is owned stock only", () => {
      expect(state().title).toMatch(/hired equipment/i);
    });
  });

  describe("with an incompatible search active", () => {
    it("stands the export down", () => {
      expect(state({ search: "cracked" }).disabled).toBe(true);
    });

    it("returns a VISIBLE reason, not just a tooltip", () => {
      // The whole point: `reason` is rendered as text in the flow, so it survives touch, keyboard
      // and a screen reader reading in document order.
      const { reason } = state({ search: "cracked" });
      expect(reason).toBeTruthy();
      expect(reason).toMatch(/reason|order|job/i);
      expect(reason).toMatch(/clear the search/i);
    });

    it("names the fields that do not carry over, in this screen's own words", () => {
      // The search placeholder offers item, reason, order and job. The note has to point at the ones
      // the export cannot match, or it is just an apology.
      const { reason } = state({ search: "cracked" });
      for (const field of ["reason", "order", "job"]) expect(reason?.toLowerCase()).toContain(field);
    });

    it("keeps a matching tooltip so the two never disagree", () => {
      const { title, reason } = state({ search: "cracked" });
      expect(title).toMatch(/clear the search/i);
      expect(reason).toMatch(/clear the search/i);
    });

    it("treats a whitespace-only search as no search at all", () => {
      expect(state({ search: "   " })).toMatchObject({ disabled: false, reason: null });
    });

    it("takes precedence over the empty-result reason — the actionable one wins", () => {
      // Both conditions hold: the search narrowed the list to nothing. Telling the user to clear the
      // search is the one that leads somewhere; "nothing to export" would be a dead end.
      const { reason, title } = state({ search: "cracked", exportableCount: 0 });
      expect(reason).toMatch(/clear the search/i);
      expect(title).toMatch(/clear the search/i);
    });
  });

  describe("clearing the search", () => {
    it("re-enables the export when rows exist", () => {
      expect(state({ search: "cracked" }).disabled).toBe(true);
      expect(state({ search: "" }).disabled).toBe(false);
    });

    it("leaves it disabled when the pool is genuinely empty", () => {
      expect(state({ search: "", exportableCount: 0 }).disabled).toBe(true);
    });

    it("drops the visible note once it no longer applies", () => {
      expect(state({ search: "" }).reason).toBeNull();
      expect(state({ search: "", exportableCount: 0 }).reason).toBeNull();
    });
  });

  it("always gives the button an accessible label — the title doubles as its aria-label", () => {
    for (const over of [{}, { search: "x" }, { exportableCount: 0 }, { search: "x", exportableCount: 0 }]) {
      expect(state(over).title.length).toBeGreaterThan(10);
    }
  });
});
