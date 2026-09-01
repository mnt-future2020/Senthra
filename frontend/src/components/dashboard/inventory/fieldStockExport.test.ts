import { describe, expect, it } from "vitest";

import { fieldStockExportState } from "./EngineersOverview";

/**
 * The field-stock export button's enabled state and its tooltip.
 *
 * Two defects are pinned here, and the first is the one that could hand a user a bad file:
 *
 *   1. The button stayed CLICKABLE at zero rows. Before the export honoured the lens's search a
 *      zero-row result was unreachable, so the missing guard was harmless; the moment the search
 *      started narrowing the file, "search an engineer who isn't there → download a header row and
 *      nothing else" became a one-click path. Every other export in the dashboard already refuses.
 *   2. The tooltip promised "every item currently held by an engineer" while the file held the
 *      filtered set. It is the only place the scope is stated, because the label collapses to an
 *      icon below `xl`.
 *
 * The count it turns on is `holdingCount`, NOT the rows on screen — see the third block.
 */
describe("fieldStockExportState", () => {
  describe("enabled state", () => {
    it("is enabled when engineers are holding stock", () => {
      expect(fieldStockExportState({ holdingCount: 3 }).disabled).toBe(false);
    });

    it("is DISABLED at zero — the regression", () => {
      expect(fieldStockExportState({ holdingCount: 0 }).disabled).toBe(true);
    });

    it("is disabled when a search narrows the list to nothing", () => {
      expect(fieldStockExportState({ engineerSearch: "zzz", holdingCount: 0 }).disabled).toBe(true);
    });

    it("is enabled again when the search is cleared and holders return", () => {
      const filtered = fieldStockExportState({ engineerSearch: "zzz", holdingCount: 0 });
      const cleared = fieldStockExportState({ holdingCount: 5 });
      expect(filtered.disabled).toBe(true);
      expect(cleared.disabled).toBe(false);
    });

    it("stays enabled while a search is active but still matches holders", () => {
      // A filter being ACTIVE is not itself a reason to stand down — only an empty result is.
      expect(fieldStockExportState({ engineerSearch: "kansha", holdingCount: 1 }).disabled).toBe(false);
    });
  });

  describe("the count it turns on", () => {
    it("ignores the search text entirely when deciding", () => {
      // Rows, not filters. Same search, opposite answers, driven only by whether anything is held.
      expect(fieldStockExportState({ engineerSearch: "kansha", holdingCount: 0 }).disabled).toBe(true);
      expect(fieldStockExportState({ engineerSearch: "kansha", holdingCount: 1 }).disabled).toBe(false);
    });

    it("treats an engineer holding nothing as nothing to export", () => {
      // The case the visible row count gets wrong: the lens legitimately lists an engineer carrying
      // nothing, so `total` would be 1 while the file would have 0 data rows.
      expect(fieldStockExportState({ engineerSearch: "idle", holdingCount: 0 }).disabled).toBe(true);
    });
  });

  describe("tooltip", () => {
    it("no longer claims to export EVERY engineer's holdings", () => {
      for (const lens of [{ holdingCount: 4 }, { engineerSearch: "kansha", holdingCount: 2 }]) {
        expect(fieldStockExportState(lens).title).not.toMatch(/every item/i);
      }
    });

    it("names the active search, so the file's scope is stated where the label is an icon", () => {
      const { title } = fieldStockExportState({ engineerSearch: "Kansha", holdingCount: 2 });
      expect(title).toContain("Kansha");
      expect(title).toMatch(/one row per item/i);
    });

    it("describes the list rather than a search when none is active", () => {
      const { title } = fieldStockExportState({ holdingCount: 4 });
      expect(title).toMatch(/engineers in this list/i);
      expect(title).toMatch(/one row per item/i);
    });

    it("explains the disabled state instead of describing a download that cannot happen", () => {
      expect(fieldStockExportState({ holdingCount: 0 }).title).toMatch(/nothing to export|no engineer/i);
      expect(fieldStockExportState({ engineerSearch: "zzz", holdingCount: 0 }).title).toMatch(/search/i);
    });

    it("always gives the button SOME accessible label — it doubles as the aria-label", () => {
      for (const lens of [{ holdingCount: 0 }, { holdingCount: 9 }, { engineerSearch: "a", holdingCount: 0 }]) {
        expect(fieldStockExportState(lens).title.length).toBeGreaterThan(10);
      }
    });
  });
});
