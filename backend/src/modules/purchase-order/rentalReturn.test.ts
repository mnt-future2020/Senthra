import { describe, expect, it } from "vitest";

import { vi } from "vitest";

import {
  isReturnMode,
  RETURN_MODES,
  resolveDeliveryLocation,
  resolveReturnLocation,
  returnLocationLine,
  type ReturnContext,
} from "./rentalReturn.js";

// A hire is a round trip. The order used to state only the outbound leg, so the collection point was
// settled by phone — differently each time. These pin the one function that answers it, which the
// order document, the API DTO and the on-hire list all read.

const ctx = (over: Partial<ReturnContext> = {}): ReturnContext => ({
  returnMode: "delivery",
  returnAddress: null,
  deliveryAddress: null,
  orderDeliveryAddress: null,
  warehouseName: "Leeds Depot",
  warehouseAddress: "1 Depot Way, Leeds, LS1 1AB",
  ...over,
});

describe("resolveReturnLocation", () => {
  it("offers exactly three modes", () => {
    expect([...RETURN_MODES]).toEqual(["delivery", "warehouse", "other"]);
  });

  // "Same as delivery" has to mean wherever delivery ACTUALLY resolved to, or the two legs of one
  // hire name different places.
  it("follows the delivery chain: the line's own address first", () => {
    const r = resolveReturnLocation(ctx({ deliveryAddress: "Site A", orderDeliveryAddress: "Order override" }));
    expect(r).toEqual({ label: "Same as delivery", address: "Site A" });
  });

  it("falls back to the order's delivery override when the line has none", () => {
    expect(resolveReturnLocation(ctx({ orderDeliveryAddress: "Order override" })).address).toBe("Order override");
  });

  it("falls back to the warehouse when neither address is set", () => {
    expect(resolveReturnLocation(ctx()).address).toBe("1 Depot Way, Leeds, LS1 1AB");
  });

  it("names the warehouse, and gives its address, in warehouse mode", () => {
    const r = resolveReturnLocation(ctx({ returnMode: "warehouse", deliveryAddress: "Site A" }));
    expect(r).toEqual({ label: "Leeds Depot", address: "1 Depot Way, Leeds, LS1 1AB" });
  });

  it("uses the typed address in other mode, ignoring both fallbacks", () => {
    const r = resolveReturnLocation(ctx({ returnMode: "other", returnAddress: "Yard 7", deliveryAddress: "Site A" }));
    expect(r).toEqual({ label: "Other address", address: "Yard 7" });
  });

  // Every row written before the field existed carries the default; a value from a future version
  // must not blank the collection point either.
  it("treats an unknown mode as delivery — the stored default", () => {
    expect(resolveReturnLocation(ctx({ returnMode: "something-else", deliveryAddress: "Site A" })).address).toBe("Site A");
  });

  it("does not pass off a blank other address as an answer", () => {
    expect(resolveReturnLocation(ctx({ returnMode: "other", returnAddress: "   " })).address).toBeNull();
  });
});

describe("returnLocationLine — what the supplier reads", () => {
  it("names the place, on one line, with newlines flattened", () => {
    const line = returnLocationLine(ctx({ returnMode: "other", returnAddress: "Yard 7\nLeeds" }));
    expect(line).toBe("Collection at end of hire: Yard 7, Leeds");
  });

  // THE bug this block exists for: the line dropped the resolved LABEL and fell back to the words
  // "the delivery address" for every mode. A line that chose the DEPOT then told the supplier to
  // collect from the site — the opposite of what was picked — whenever that depot had no address on
  // file, which every Warehouse address column allows (all of them are optional).
  it("names the depot a warehouse-return line chose, even with no address on file", () => {
    const line = returnLocationLine(ctx({ returnMode: "warehouse", warehouseName: "Leeds DC", warehouseAddress: null }));
    expect(line).toBe("Collection at end of hire: Leeds DC");
  });

  it("falls back to the generic depot wording when the warehouse is not even named", () => {
    const line = returnLocationLine(ctx({ returnMode: "warehouse", warehouseName: null, warehouseAddress: null }));
    expect(line).toBe("Collection at end of hire: Delivery warehouse");
  });

  // Never an empty promise: a line that resolves to nothing still tells the supplier where to go —
  // and now it names the place rather than pointing at an address the document may not carry either.
  it("names the destination warehouse when a same-as-delivery line resolves to nothing", () => {
    const line = returnLocationLine(ctx({ warehouseName: "Leeds DC", warehouseAddress: null }));
    expect(line).toBe("Collection at end of hire: Leeds DC");
  });

  it("still prints the address whenever there is one", () => {
    expect(returnLocationLine(ctx({ returnMode: "warehouse", warehouseName: "Leeds DC", warehouseAddress: "1 Depot Rd, Leeds" })))
      .toBe("Collection at end of hire: 1 Depot Rd, Leeds");
  });
});


// The OUTBOUND leg, from the same chain. Extracted because every screen was deciding it for itself and
// getting it wrong: a line with no address of its own printed the words "Delivery warehouse" on an
// order whose header overrode the destination, so the row named a depot the kit never went to.
describe("resolveDeliveryLocation", () => {
  it("prefers the line's own address", () => {
    expect(resolveDeliveryLocation(ctx({ deliveryAddress: "Site A", orderDeliveryAddress: "Order override" }))).toEqual({
      label: "This line's address",
      address: "Site A",
    });
  });

  it("falls back to the order's override, and says the address belongs to the order", () => {
    expect(resolveDeliveryLocation(ctx({ orderDeliveryAddress: "Order override" }))).toEqual({
      label: "Order delivery address",
      address: "Order override",
    });
  });

  it("falls back to the warehouse, naming the depot", () => {
    expect(resolveDeliveryLocation(ctx())).toEqual({
      label: "Leeds Depot",
      address: "1 Depot Way, Leeds, LS1 1AB",
    });
  });

  it("names the warehouse generically when it has no name", () => {
    expect(resolveDeliveryLocation(ctx({ warehouseName: null })).label).toBe("Delivery warehouse");
  });

  it("treats a whitespace-only address as no address", () => {
    expect(resolveDeliveryLocation(ctx({ deliveryAddress: "   " })).address).toBe("1 Depot Way, Leeds, LS1 1AB");
  });

  // The return leg's `delivery` mode is DEFINED as this one, so the two can never drift apart —
  // which they would the moment either grew a fallback the other did not.
  it("is the same address the return leg's `delivery` mode gives, in every state", () => {
    for (const over of [
      {},
      { deliveryAddress: "Site A" },
      { orderDeliveryAddress: "Order override" },
      { deliveryAddress: "Site A", orderDeliveryAddress: "Order override" },
      { warehouseAddress: null },
    ]) {
      const c = ctx(over);
      expect(resolveReturnLocation(c).address).toBe(resolveDeliveryLocation(c).address);
    }
  });

  // The mode only changes the RETURN leg. Where the kit is delivered is not a function of where it
  // goes back — mixing the two up is how a screen would move a delivery by editing a collection.
  it("ignores the return mode entirely", () => {
    const base = ctx({ deliveryAddress: "Site A" });
    for (const returnMode of ["delivery", "warehouse", "other", "banana"]) {
      expect(resolveDeliveryLocation({ ...base, returnMode, returnAddress: "9 Collection Yard" }).address).toBe("Site A");
    }
  });
});


// The round trip, stated as the cases a reviewer would ask for. Each one pins BOTH legs of one hire,
// because the bugs in this area were never a wrong function — they were two readers of one journey.
describe("both legs, case by case", () => {
  const legs = (over: Partial<ReturnContext> = {}) => {
    const c = ctx(over);
    return { delivery: resolveDeliveryLocation(c).address, collection: resolveReturnLocation(c).address };
  };
  const WH = "1 Depot Way, Leeds, LS1 1AB";

  it("A · no address, same as delivery → warehouse both ways", () => {
    expect(legs()).toEqual({ delivery: WH, collection: WH });
  });

  // Same ADDRESS as case A, different MEANING: this one is pinned to the depot and stops following
  // delivery, which is why the option has to stay available with the address box empty.
  it("B · no address, collect from warehouse → warehouse both ways, but fixed", () => {
    expect(legs({ returnMode: "warehouse" })).toEqual({ delivery: WH, collection: WH });
    expect(resolveReturnLocation(ctx({ returnMode: "warehouse" })).label).toBe("Leeds Depot");
    expect(resolveReturnLocation(ctx()).label).toBe("Same as delivery");
  });

  it("C · custom address, same as delivery → that address both ways", () => {
    expect(legs({ deliveryAddress: "12 Site Road, Leeds" })).toEqual({
      delivery: "12 Site Road, Leeds",
      collection: "12 Site Road, Leeds",
    });
  });

  it("D · custom address, collect from warehouse → out to the site, back to the depot", () => {
    expect(legs({ deliveryAddress: "12 Site Road, Leeds", returnMode: "warehouse" })).toEqual({
      delivery: "12 Site Road, Leeds",
      collection: WH,
    });
  });

  it("E · other → the typed collection address, whatever the delivery leg says", () => {
    expect(legs({ deliveryAddress: "12 Site Road, Leeds", returnMode: "other", returnAddress: "9 Yard" })).toEqual({
      delivery: "12 Site Road, Leeds",
      collection: "9 Yard",
    });
  });

  // The case that proves `delivery` is a RULE and not a snapshot of the warehouse: nobody touched the
  // line, the order moved, and the collection point moved with it.
  it("F · order override, same as delivery → collection follows the override", () => {
    expect(legs({ orderDeliveryAddress: "Site X" })).toEqual({ delivery: "Site X", collection: "Site X" });
  });

  it("G · order override, collect from warehouse → collection stays at the depot", () => {
    expect(legs({ orderDeliveryAddress: "Site X", returnMode: "warehouse" })).toEqual({
      delivery: "Site X",
      collection: WH,
    });
  });

  // H · an impossible value must not pass silently. It still resolves — an order that cannot render is
  // worse than one that renders the value every row carried before this field existed — but it is
  // logged, so corrupt data is findable instead of invisible.
  it("H · an unrecognised mode resolves as delivery AND says so on the way out", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveReturnLocation(ctx({ returnMode: "banana" })).address).toBe(WH);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('unrecognised returnMode "banana"');
    } finally {
      spy.mockRestore();
    }
  });

  it("H · the three real modes never log", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const returnMode of RETURN_MODES) resolveReturnLocation(ctx({ returnMode, returnAddress: "9 Yard" }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(isReturnMode("delivery")).toBe(true);
    expect(isReturnMode("banana")).toBe(false);
  });

  // I · every row that exists today. The mode is the column default and the address box is usually
  // empty, so this is the shape the feature has to keep resolving forever.
  it("I · a legacy row — mode `delivery`, no address — still resolves to the warehouse", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(legs({ returnMode: "delivery" })).toEqual({ delivery: WH, collection: WH });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
