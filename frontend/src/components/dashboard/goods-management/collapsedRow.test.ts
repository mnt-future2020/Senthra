import { describe, expect, it } from "vitest";

import { foldedStatus, itemNamesTitle, summariseLines } from "./collapsedRow";
import type { QueueKitLine } from "@/types/goodsManagement";

const line = (over: Partial<QueueKitLine> = {}): QueueKitLine => ({
  id: "l1",
  lineType: "irm",
  irmItemId: "i1",
  customerStockEntryId: null,
  itemName: "CAT6",
  scanCode: null,
  warehouseId: "w1",
  warehouseName: "London",
  warehouseCode: "WH-0005",
  plannedQty: 0,
  issuedQty: 0,
  usedQty: 0,
  returnedQty: 0,
  engineerHeld: 0,
  available: 0,
  vanReturnableQty: 0,
  vanIssuedQty: 0,
  ...over,
});

// A folded row REPLACES the job's kit lines, so its numbers must be the sum of the rows it hid.
// Blanking them would make folding cost the manager the figures the queue exists to show — they'd
// have to expand every job to get them back, which is the opposite of shrinking the view.
describe("summariseLines", () => {
  it("counts the lines it folded", () => {
    expect(summariseLines([line({ id: "a" }), line({ id: "b" })], new Map(), new Map()).items).toBe(2);
  });

  it("adds up planned and issued", () => {
    const t = summariseLines(
      [line({ id: "a", plannedQty: 2, issuedQty: 1 }), line({ id: "b", plannedQty: 5, issuedQty: 4 })],
      new Map(),
      new Map(),
    );
    expect(t.planned).toBe(7);
    expect(t.issued).toBe(5);
  });

  // Returned and to-return are APPORTIONED across an item's warehouse lines by the caller, because a
  // line's own returnedQty carries the ITEM's whole total. Summing the raw field on a split item
  // would count the same returns once per warehouse and report more back than ever went out.
  it("takes returned and to-return from the distributed maps, not the raw line field", () => {
    const lines = [line({ id: "a", returnedQty: 6 }), line({ id: "b", returnedQty: 6 })];
    const t = summariseLines(lines, new Map([["a", 4], ["b", 2]]), new Map([["a", 1], ["b", 1]]));
    expect(t.returned).toBe(6); // 4 + 2 — NOT 12
    expect(t.toReturn).toBe(2);
  });

  it("falls back to the line's own returned figure when the map has no entry", () => {
    expect(summariseLines([line({ id: "a", returnedQty: 3 })], new Map(), new Map()).returned).toBe(3);
  });

  // Misc lines are free text, not stock-tracked: the expanded rows print "—" for used/returned/
  // to-return, so the folded total has to equal what those rows actually showed.
  it("counts misc lines in planned and issued only", () => {
    const t = summariseLines(
      [line({ id: "m", lineType: "misc", plannedQty: 3, issuedQty: 3, usedQty: 9, returnedQty: 9 })],
      new Map([["m", 9]]),
      new Map([["m", 9]]),
    );
    expect(t.planned).toBe(3);
    expect(t.issued).toBe(3);
    expect(t.used).toBe(0);
    expect(t.returned).toBe(0);
    expect(t.toReturn).toBe(0);
  });

  it("mixes misc and stock lines without letting misc leak into the stock totals", () => {
    const t = summariseLines(
      [line({ id: "a", plannedQty: 2, issuedQty: 2, usedQty: 2 }), line({ id: "m", lineType: "misc", plannedQty: 1, issuedQty: 1, usedQty: 5 })],
      new Map(),
      new Map(),
    );
    expect(t.planned).toBe(3);
    expect(t.used).toBe(2);
  });

  it("returns clean zeros for no lines", () => {
    expect(summariseLines([], new Map(), new Map())).toEqual({ items: 0, planned: 0, issued: 0, used: 0, returned: 0, toReturn: 0 });
  });
});

// "2 items" says how much was folded but not WHAT — the one thing you'd otherwise expand to check.
describe("itemNamesTitle", () => {
  it("lists the folded item names one per line", () => {
    expect(itemNamesTitle([line({ itemName: "CAT6" }), line({ itemName: "mouse123" })])).toBe("CAT6\nmouse123");
  });

  // A 40-line kit must not produce a tooltip taller than the screen.
  it("caps the list and says how many more there are", () => {
    const many = Array.from({ length: 15 }, (_, i) => line({ id: `l${i}`, itemName: `Item ${i}` }));
    expect(itemNamesTitle(many, 3)).toBe("Item 0\nItem 1\nItem 2\n+12 more");
  });

  it("adds no 'more' note when everything fits", () => {
    expect(itemNamesTitle([line({ itemName: "Only" })], 3)).toBe("Only");
  });
});

// The folded chip has to describe the SAME lines as the folded row's numbers. It first used the job's
// own goodsStatus, which covers the WHOLE job including other warehouses' lines — so a job partly
// issued elsewhere showed "Partial" here beside an Issued column of 0, the chip contradicting the
// numbers on its own row.
describe("foldedStatus", () => {
  it("passes a single line's status straight through", () => {
    expect(foldedStatus(["issued"])).toBe("issued");
  });

  it("keeps the status when every line agrees", () => {
    expect(foldedStatus(["not_issued", "not_issued"])).toBe("not_issued");
  });

  // The outstanding work is what the manager is scanning for, so the least advanced line wins.
  it("reports the LEAST advanced state when lines disagree", () => {
    expect(foldedStatus(["awaiting_return", "issued"])).toBe("issued");
    expect(foldedStatus(["returned", "awaiting_return"])).toBe("awaiting_return");
  });

  // The one exception to least-advanced: "Not issued" beside a non-zero Issued column would deny
  // units already with the engineer.
  it("says PARTIAL, not 'Not issued', when some lines have gone out and others haven't", () => {
    expect(foldedStatus(["not_issued", "issued"])).toBe("partially_issued");
    expect(foldedStatus(["not_issued", "awaiting_return"])).toBe("partially_issued");
  });

  it("still says Not issued when genuinely nothing has moved", () => {
    expect(foldedStatus(["not_issued", "not_issued", "not_issued"])).toBe("not_issued");
  });

  // The regression this function exists for: nothing issued HERE must not inherit a job-level
  // "Partial" earned at another warehouse.
  it("does not inherit a job-level status from lines it did not fold", () => {
    expect(foldedStatus(["not_issued"])).toBe("not_issued");
  });

  it("falls back to Not issued for no lines", () => {
    expect(foldedStatus([])).toBe("not_issued");
  });
});
