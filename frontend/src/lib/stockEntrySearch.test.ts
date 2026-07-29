import { describe, expect, it } from "vitest";

import { searchStockEntries, type SearchableStockEntry } from "./stockEntrySearch";

const entry = (over: Partial<SearchableStockEntry> = {}): SearchableStockEntry => ({
  itemName: "Optical Splitter",
  sku: "OPT-100",
  barcode: "CSE-00031",
  customerName: "LOBBI",
  ...over,
});

const ENTRIES: SearchableStockEntry[] = [
  entry(),
  entry({ itemName: "Fibre Drum", sku: "FIB-250", barcode: "CSE-00032", customerName: "Kansha Org" }),
  entry({ itemName: "Patch Lead", sku: null, barcode: null, customerName: "LOBBI" }),
];

const names = (rows: SearchableStockEntry[]) => rows.map((r) => r.itemName);

describe("searchStockEntries", () => {
  it("returns everything for an empty or whitespace-only term", () => {
    expect(searchStockEntries(ENTRIES, "")).toHaveLength(3);
    expect(searchStockEntries(ENTRIES, "   ")).toHaveLength(3);
  });

  it("matches the item name", () => {
    expect(names(searchStockEntries(ENTRIES, "fibre"))).toEqual(["Fibre Drum"]);
  });

  it("matches the SKU", () => {
    expect(names(searchStockEntries(ENTRIES, "OPT-100"))).toEqual(["Optical Splitter"]);
  });

  it("matches the barcode — the value you can read off the physical unit", () => {
    expect(names(searchStockEntries(ENTRIES, "CSE-00032"))).toEqual(["Fibre Drum"]);
  });

  it("matches the customer", () => {
    expect(names(searchStockEntries(ENTRIES, "kansha"))).toEqual(["Fibre Drum"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(names(searchStockEntries(ENTRIES, "  OPTICAL  "))).toEqual(["Optical Splitter"]);
  });

  it("matches on a partial term", () => {
    expect(names(searchStockEntries(ENTRIES, "CSE-000"))).toEqual(["Optical Splitter", "Fibre Drum"]);
  });

  it("survives a null sku or barcode instead of throwing", () => {
    // A draft entry has neither yet — it must still be searchable by name.
    expect(names(searchStockEntries(ENTRIES, "patch"))).toEqual(["Patch Lead"]);
    expect(searchStockEntries(ENTRIES, "nothing-matches")).toEqual([]);
  });

  it("returns an empty list rather than throwing on no entries", () => {
    expect(searchStockEntries([], "anything")).toEqual([]);
  });
});
