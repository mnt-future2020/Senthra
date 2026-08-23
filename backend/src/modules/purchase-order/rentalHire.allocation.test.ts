import { describe, expect, it } from "vitest";

import { allocateFromHires, hireAvailable, totalAvailable } from "./rentalHire.allocation.js";
import type { HireStockRow } from "./purchase-order.repository.js";

const hire = (id: string, endsOn: string, over: Partial<HireStockRow> = {}): HireStockRow => ({
  id,
  rentalItemId: "d".repeat(24),
  itemName: "Fibre Tester",
  baseUnit: "Each",
  quantity: 3,
  receivedQuantity: 3,
  returnedQuantity: 0,
  issuedQuantity: 0,
  hireEndDate: new Date(endsOn),
  hireStatus: "on_hire",
  purchaseOrderId: "9".repeat(24),
  poCode: `PO-${id}`,
  warehouseId: "b".repeat(24),
  warehouseName: "Leeds",
  warehouseCode: "LDS",
  orderLive: true,
  ...over,
});

describe("hireAvailable", () => {
  it("is received minus what went back to the provider minus what is out with an engineer", () => {
    expect(hireAvailable({ receivedQuantity: 5, returnedQuantity: 1, issuedQuantity: 2 })).toBe(2);
  });

  it("counts a part-delivered hire by what actually turned up, not what was ordered", () => {
    expect(hireAvailable({ receivedQuantity: 1, returnedQuantity: 0, issuedQuantity: 0 })).toBe(1);
  });

  it("clamps at zero rather than reporting negative availability", () => {
    // The three counters move together in one transaction so this should be unreachable; if a hand
    // edit ever makes it so, an allocator reading "minus two" would start handing out phantom units.
    expect(hireAvailable({ receivedQuantity: 1, returnedQuantity: 0, issuedQuantity: 3 })).toBe(0);
  });
});

describe("totalAvailable", () => {
  it("sums across every hire of the item", () => {
    expect(totalAvailable([hire("a", "2026-09-14"), hire("b", "2026-10-30", { receivedQuantity: 2 })])).toBe(5);
  });

  it("is zero for no hires", () => {
    expect(totalAvailable([])).toBe(0);
  });
});

describe("allocateFromHires", () => {
  it("drains the SOONEST deadline first", () => {
    // The rule that stops a hire going overdue while holding kit nobody was using.
    const sept = hire("sept", "2026-09-14");
    const oct = hire("oct", "2026-10-30");
    const out = allocateFromHires([oct, sept], 2);
    expect(out).toEqual([{ hire: sept, qty: 2 }]);
  });

  it("spills onto the next deadline when the first cannot cover it", () => {
    const sept = hire("sept", "2026-09-14", { receivedQuantity: 1 });
    const oct = hire("oct", "2026-10-30", { receivedQuantity: 3 });
    const out = allocateFromHires([oct, sept], 3);
    expect(out).toEqual([{ hire: sept, qty: 1 }, { hire: oct, qty: 2 }]);
  });

  it("returns null rather than a partial allocation", () => {
    // Issuing three of the five an engineer came for, silently, is worse than saying two are missing.
    expect(allocateFromHires([hire("a", "2026-09-14", { receivedQuantity: 2 })], 5)).toBeNull();
  });

  it("skips a hire with nothing left on it", () => {
    const spent = hire("spent", "2026-09-01", { issuedQuantity: 3 });
    const live = hire("live", "2026-10-30");
    expect(allocateFromHires([spent, live], 1)).toEqual([{ hire: live, qty: 1 }]);
  });

  it("is stable when two hires share a deadline", () => {
    // A preview and its post must agree, so same-day hires allocate in a fixed order rather than
    // whatever order the driver happened to return them in.
    const a = hire("aaa", "2026-09-14", { receivedQuantity: 1 });
    const b = hire("bbb", "2026-09-14", { receivedQuantity: 1 });
    expect(allocateFromHires([b, a], 1)).toEqual([{ hire: a, qty: 1 }]);
    expect(allocateFromHires([a, b], 1)).toEqual([{ hire: a, qty: 1 }]);
  });

  it("allocates nothing for a zero request", () => {
    expect(allocateFromHires([hire("a", "2026-09-14")], 0)).toEqual([]);
  });

  it("returns null when there are no hires at all", () => {
    expect(allocateFromHires([], 1)).toBeNull();
  });

  it("does not mutate the caller's array", () => {
    const sept = hire("sept", "2026-09-14");
    const oct = hire("oct", "2026-10-30");
    const input = [oct, sept];
    allocateFromHires(input, 1);
    expect(input).toEqual([oct, sept]);
  });
});
