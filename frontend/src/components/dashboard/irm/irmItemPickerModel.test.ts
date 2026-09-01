import { describe, expect, it } from "vitest";

import type { IrmItem } from "@/types/irm";
import {
  irmItemLabel,
  matchesIrmQuery,
  mergeIrmItems,
  missingIrmIds,
  searchView,
  shouldOfferQuickCreate,
} from "./irmItemPickerModel";

const item = (over: Partial<IrmItem> & { id: string }): IrmItem =>
  ({
    code: "IRM-0001",
    name: "Item",
    sku: null,
    brand: null,
    mpn: null,
    trackInventory: true,
    ...over,
  }) as IrmItem;

describe("irmItemLabel", () => {
  it("names the item and its catalogue code", () => {
    expect(irmItemLabel({ name: "CAT6 U/UTP Cable, 305m box", code: "IRM-0004" })).toBe(
      "CAT6 U/UTP Cable, 305m box (IRM-0004)",
    );
  });
});

describe("matchesIrmQuery", () => {
  const cable = item({ id: "1", name: "CAT6 U/UTP Cable", code: "IRM-0004", sku: "CAB-CAT6-305M", brand: "Excel", mpn: "100-024-RL" });

  // The five fields the server searches (irm.repository buildWhere). A local filter that
  // matched fewer would hide a row while typing that reappears once the server answers.
  it("matches every field the backend searches, case-insensitively", () => {
    expect(matchesIrmQuery(cable, "cat6")).toBe(true);
    expect(matchesIrmQuery(cable, "irm-0004")).toBe(true);
    expect(matchesIrmQuery(cable, "cab-cat6")).toBe(true);
    expect(matchesIrmQuery(cable, "excel")).toBe(true);
    expect(matchesIrmQuery(cable, "100-024")).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(matchesIrmQuery(cable, "fibre")).toBe(false);
  });

  it("treats a blank query as no filter", () => {
    expect(matchesIrmQuery(cable, "")).toBe(true);
    expect(matchesIrmQuery(cable, "   ")).toBe(true);
  });

  it("survives the null optional fields", () => {
    expect(matchesIrmQuery(item({ id: "2", name: "Plain", code: "IRM-0002" }), "plain")).toBe(true);
    expect(matchesIrmQuery(item({ id: "2", name: "Plain", code: "IRM-0002" }), "excel")).toBe(false);
  });
});

describe("mergeIrmItems", () => {
  const a = item({ id: "a", name: "A" });
  const b = item({ id: "b", name: "B" });

  it("appends items the list has not seen", () => {
    expect(mergeIrmItems([a], [b]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("replaces a known item with the fresher copy, in place", () => {
    const fresherA = item({ id: "a", name: "A (renamed)" });
    const merged = mergeIrmItems([a, b], [fresherA]);
    expect(merged.map((i) => i.id)).toEqual(["a", "b"]); // order held
    expect(merged[0].name).toBe("A (renamed)");
  });

  // The picker merges on EVERY search response. Returning a new array each time would
  // re-render every line row of the form for results it already had.
  it("returns the same array when nothing changed", () => {
    const existing = [a, b];
    expect(mergeIrmItems(existing, [a])).toBe(existing);
    expect(mergeIrmItems(existing, [])).toBe(existing);
  });

  // The LIST endpoint omits barcodeDataUri to stay light; the inventory forms fetch it for the
  // selected item alone and patch it onto the row. A later merge of that same id — a picker search
  // that matches it, or the by-ids resolve landing — must not undo that: the forms cache which ids
  // they have fetched, so a clobbered image is never re-requested and the print-label control
  // silently disappears from a form that had one.
  it("keeps a locally-loaded barcode when the incoming copy has none", () => {
    const withBarcode = item({ id: "a", name: "A", barcodeDataUri: "data:image/png;base64,AAA" });
    const fromList = item({ id: "a", name: "A (renamed)" });
    const merged = mergeIrmItems([withBarcode], [fromList]);
    expect(merged[0].name).toBe("A (renamed)"); // still takes the fresher fields
    expect(merged[0].barcodeDataUri).toBe("data:image/png;base64,AAA");
  });

  it("takes the incoming barcode when there is one", () => {
    const stale = item({ id: "a", barcodeDataUri: "data:image/png;base64,OLD" });
    const regenerated = item({ id: "a", barcodeDataUri: "data:image/png;base64,NEW" });
    expect(mergeIrmItems([stale], [regenerated])[0].barcodeDataUri).toBe("data:image/png;base64,NEW");
  });
});

describe("shouldOfferQuickCreate", () => {
  const settled = { canCreate: true, query: "CAT36", searching: false, searchFailed: false, resultCount: 0 };

  it("offers create once a search has settled with no match", () => {
    expect(shouldOfferQuickCreate(settled)).toBe(true);
  });

  it("never offers create without the permission", () => {
    expect(shouldOfferQuickCreate({ ...settled, canCreate: false })).toBe(false);
  });

  // The anti-duplicate guard. Mid-search the result count is still 0, so offering create there
  // invites "CAT6 Cable" to be created seconds before the existing CAT6 row arrives.
  it("stays silent while the search is still running", () => {
    expect(shouldOfferQuickCreate({ ...settled, searching: true })).toBe(false);
  });

  // A failed search does not mean "no such item" — it means we do not know. Offering create on a
  // network blip is how a catalogue grows a second copy of everything.
  it("stays silent when the search failed", () => {
    expect(shouldOfferQuickCreate({ ...settled, searchFailed: true })).toBe(false);
  });

  it("stays silent when matches exist", () => {
    expect(shouldOfferQuickCreate({ ...settled, resultCount: 3 })).toBe(false);
  });

  it("stays silent until the query is worth searching on", () => {
    expect(shouldOfferQuickCreate({ ...settled, query: "" })).toBe(false);
    expect(shouldOfferQuickCreate({ ...settled, query: " c " })).toBe(false);
    expect(shouldOfferQuickCreate({ ...settled, query: " ca " })).toBe(true);
  });
});

describe("searchView", () => {
  const seed = [
    item({ id: "1", name: "CAT6 U/UTP Cable", code: "IRM-0004" }),
    item({ id: "2", name: "Fibre Patch Panel", code: "IRM-0010" }),
  ];
  const hit = item({ id: "9", name: "CAT6A Cable", code: "IRM-0099" });

  it("filters the caller's own list below the search threshold", () => {
    const v = searchView("f", null, seed);
    expect(v.options.map((i) => i.id)).toEqual(["2"]);
    expect(v.searching).toBe(false);
    expect(v.searchFailed).toBe(false);
  });

  it("lists everything the caller loaded when nothing is typed", () => {
    expect(searchView("", null, seed).options).toHaveLength(2);
  });

  it("is searching once past the threshold with no answer yet", () => {
    const v = searchView("cat6", null, seed);
    expect(v.searching).toBe(true);
    expect(v.options).toEqual([]);
  });

  // Covers the debounce window AND a slow response for an earlier query: an answer that is not
  // for what is on screen leaves the picker searching, so the create option stays hidden.
  it("ignores an answer to a different query", () => {
    const stale = { query: "cat", items: [hit], failed: false };
    const v = searchView("cat6", stale, seed);
    expect(v.searching).toBe(true);
    expect(v.options).toEqual([]);
  });

  it("shows the server's answer for the query on screen", () => {
    const v = searchView("cat6", { query: "cat6", items: [hit], failed: false }, seed);
    expect(v.options).toEqual([hit]);
    expect(v.searching).toBe(false);
    expect(v.searchFailed).toBe(false);
  });

  it("reports a failure as a failure, not as an empty catalogue", () => {
    const v = searchView("cat6", { query: "cat6", items: [], failed: true }, seed);
    expect(v.searching).toBe(false);
    expect(v.searchFailed).toBe(true);
    expect(v.options).toEqual([]);
  });

  it("compares on the trimmed query, the way the request was keyed", () => {
    expect(searchView("  cat6  ", { query: "cat6", items: [hit], failed: false }, seed).options).toEqual([hit]);
  });
});

describe("missingIrmIds", () => {
  const have = [item({ id: "a" }), item({ id: "b" })];

  it("names only the ids the form does not already hold", () => {
    expect(missingIrmIds(["a", "c"], have)).toEqual(["c"]);
  });

  it("asks for nothing when everything is already loaded", () => {
    expect(missingIrmIds(["a", "b"], have)).toEqual([]);
  });

  // Empty lines carry no item yet — asking the server for "" would be a wasted round trip.
  it("ignores blank and missing ids", () => {
    expect(missingIrmIds(["", null, undefined, "c"], have)).toEqual(["c"]);
  });

  // A receipt can list the same item on two lines; it should be resolved once.
  it("de-duplicates", () => {
    expect(missingIrmIds(["c", "c", "d"], have)).toEqual(["c", "d"]);
  });

  it("asks for everything when the form holds nothing", () => {
    expect(missingIrmIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("searchView — caller's own exclusion rule", () => {
  const plain = item({ id: "p", name: "Plain Cable", code: "IRM-1" });
  const serial = item({ id: "s", name: "Serial Router", code: "IRM-2", trackInventory: false });
  const adjustable = (i: IrmItem) => i.trackInventory;

  it("hides excluded rows from the seed and counts them", () => {
    const v = searchView("", null, [plain, serial], adjustable);
    expect(v.options).toEqual([plain]);
    expect(v.excludedCount).toBe(1);
  });

  it("applies the same rule to server results, not just the seed", () => {
    const v = searchView("rout", { query: "rout", items: [serial], failed: false }, [], adjustable);
    expect(v.options).toEqual([]);
    expect(v.excludedCount).toBe(1);
  });

  // "No such item" and "it exists but not for this screen" are different answers. Collapsing them
  // is how someone concludes the catalogue is missing a row and creates a duplicate.
  it("separates a genuine no-match from an excluded match", () => {
    const none = searchView("zzz", { query: "zzz", items: [], failed: false }, [], adjustable);
    expect(none.options).toEqual([]);
    expect(none.excludedCount).toBe(0);
  });

  it("counts nothing as excluded when the caller has no rule", () => {
    expect(searchView("", null, [plain, serial]).excludedCount).toBe(0);
  });
});
