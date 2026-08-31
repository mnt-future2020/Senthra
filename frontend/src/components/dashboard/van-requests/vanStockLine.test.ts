import { describe, expect, it } from "vitest";

import { formatHireDate, splitItemKeys, toLinePayload, vanStockItemKey } from "./vanStockLine";

// The client half of "company stock and hired kit are not interchangeable". The server enforces its
// own version of every rule below; these exist because a composer that sends the wrong shape produces
// a confusing 400 at best, and — if the ids were ever keyed together — the wrong item at worst.

const irm = { source: "irm" as const, irmItemId: "aaa", rentalItemId: null };
const rental = { source: "rental" as const, irmItemId: null, rentalItemId: "bbb" };

describe("vanStockItemKey", () => {
  it("namespaces each catalogue", () => {
    expect(vanStockItemKey(irm)).toBe("irm:aaa");
    expect(vanStockItemKey(rental)).toBe("rental:bbb");
  });

  // THE REASON THIS IS COMPOSITE. The two id spaces are independent, so the same string can be a
  // valid id in both. Keyed on a bare id the cart would treat them as one row — the second add would
  // be silently swallowed as a duplicate, and the engineer would be short an item with no error.
  it("keeps an IRM item and a rental item with the SAME id apart", () => {
    const collide = { source: "rental" as const, irmItemId: null, rentalItemId: "aaa" };
    expect(vanStockItemKey(collide)).not.toBe(vanStockItemKey(irm));
  });

  it("is stable for the same item", () => {
    expect(vanStockItemKey(rental)).toBe(vanStockItemKey({ ...rental }));
  });
});

describe("splitItemKeys", () => {
  it("routes each key back to its own id list", () => {
    expect(splitItemKeys(["irm:aaa", "rental:bbb", "irm:ccc"])).toEqual({
      irmItemIds: ["aaa", "ccc"],
      rentalItemIds: ["bbb"],
    });
  });

  it("survives an empty cart", () => {
    expect(splitItemKeys([])).toEqual({ irmItemIds: [], rentalItemIds: [] });
  });

  // Round-trips, so the availability request always asks about exactly the items in the cart.
  it("round-trips through vanStockItemKey", () => {
    const { irmItemIds, rentalItemIds } = splitItemKeys([irm, rental].map(vanStockItemKey));
    expect(irmItemIds).toEqual(["aaa"]);
    expect(rentalItemIds).toEqual(["bbb"]);
  });
});

describe("formatHireDate", () => {
  // Caught in browser QA: the scan panel rendered "9/30/2026" one line above the app's own
  // "27 Aug 2026", because a bare toLocaleDateString() follows the viewer's locale.
  it("renders the UK format the rest of the app uses", () => {
    expect(formatHireDate("2026-09-30T00:00:00.000Z")).toBe("30 Sept 2026");
  });

  // The correctness half. A hire deadline is a CALENDAR DAY stored at UTC midnight — formatted in a
  // zone behind UTC it reads as the day before, telling an engineer their kit was due yesterday.
  it("pins UTC so a calendar day never slips backwards", () => {
    expect(formatHireDate("2026-01-01T00:00:00.000Z")).toBe("01 Jan 2026");
  });

  it("degrades to an em dash rather than 'Invalid Date'", () => {
    expect(formatHireDate(null)).toBe("—");
    expect(formatHireDate(undefined)).toBe("—");
    expect(formatHireDate("not-a-date")).toBe("—");
  });
});

describe("toLinePayload", () => {
  it("sends a rental line with the rental id and NO IRM id", () => {
    const line = toLinePayload({ ...rental, name: "Fibre Tester", qty: 2 }, "wh1");
    expect(line).toEqual({ source: "rental", rentalItemId: "bbb", itemName: "Fibre Tester", qty: 2, warehouseId: "wh1" });
    // Not merely absent-by-value: the key must not be present at all. The server refuses a line
    // carrying both ids rather than picking one, so an explicit undefined would still be wrong shape.
    expect("irmItemId" in line).toBe(false);
  });

  it("sends an IRM line with the IRM id and NO rental id", () => {
    const line = toLinePayload({ ...irm, name: "CAT6", qty: 1 }, "wh1");
    expect(line).toEqual({ source: "irm", irmItemId: "aaa", itemName: "CAT6", qty: 1, warehouseId: "wh1" });
    expect("rentalItemId" in line).toBe(false);
  });

  // Returns name one destination on the request, so their lines carry no warehouse of their own.
  it("omits the warehouse entirely on a return", () => {
    const line = toLinePayload({ ...rental, name: "Fibre Tester", qty: 1 });
    expect("warehouseId" in line).toBe(false);
  });
});
