import { describe, expect, it } from "vitest";

import { searchDamagedRows, type SearchableDamagedRow } from "./DamagedStockView";

type Row = SearchableDamagedRow;

const row = (over: Partial<Row> = {}): Row => ({
  itemName: "Optical splitter",
  warehouseName: "London Fulfillment Centre",
  reason: "Crushed in transit",
  ...over,
});

const ROWS: Row[] = [
  row(),
  row({ itemName: "Fibre drum", warehouseName: "Leeds Depot", reason: "Water damage" }),
  row({ itemName: "Patch lead", warehouseName: null, reason: null }),
];

const names = (rows: Row[]) => rows.map((r) => r.itemName);

describe("searchDamagedRows", () => {
  it("returns everything for an empty or whitespace-only term", () => {
    expect(searchDamagedRows(ROWS, "")).toHaveLength(3);
    expect(searchDamagedRows(ROWS, "   ")).toHaveLength(3);
  });

  it("matches the item", () => {
    expect(names(searchDamagedRows(ROWS, "fibre"))).toEqual(["Fibre drum"]);
  });

  it("matches the warehouse", () => {
    expect(names(searchDamagedRows(ROWS, "leeds"))).toEqual(["Fibre drum"]);
  });

  it("matches the damage reason — how you find 'everything water-damaged'", () => {
    expect(names(searchDamagedRows(ROWS, "water"))).toEqual(["Fibre drum"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(names(searchDamagedRows(ROWS, "  OPTICAL  "))).toEqual(["Optical splitter"]);
  });

  it("survives a null warehouse or reason instead of throwing", () => {
    // A customer-scoped row has no warehouse column; a row can predate reason capture.
    expect(names(searchDamagedRows(ROWS, "patch"))).toEqual(["Patch lead"]);
  });

  it("returns nothing when the term matches nothing", () => {
    expect(searchDamagedRows(ROWS, "zzz")).toEqual([]);
  });

  it("returns an empty list rather than throwing on no rows", () => {
    expect(searchDamagedRows([], "anything")).toEqual([]);
  });
});
