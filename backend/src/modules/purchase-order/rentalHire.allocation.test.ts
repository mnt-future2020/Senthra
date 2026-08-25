import { describe, expect, it } from "vitest";

import { allocateFromHires, hireAtWarehouse, hireHeldByUs, hireIssuable, totalAvailable } from "./rentalHire.allocation.js";
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
  lostQuantity: 0,
  fieldDamageQty: 0,
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

describe("hireIssuable", () => {
  it("is received minus what went back to the provider minus what is out with an engineer", () => {
    expect(hireIssuable({ receivedQuantity: 5, returnedQuantity: 1, issuedQuantity: 2, lostQuantity: 0, fieldDamageQty: 0 })).toBe(2);
  });

  it("counts a part-delivered hire by what actually turned up, not what was ordered", () => {
    expect(hireIssuable({ receivedQuantity: 1, returnedQuantity: 0, issuedQuantity: 0, lostQuantity: 0, fieldDamageQty: 0 })).toBe(1);
  });

  it("clamps at zero rather than reporting negative availability", () => {
    // The three counters move together in one transaction so this should be unreachable; if a hand
    // edit ever makes it so, an allocator reading "minus two" would start handing out phantom units.
    expect(hireIssuable({ receivedQuantity: 1, returnedQuantity: 0, issuedQuantity: 3, lostQuantity: 0, fieldDamageQty: 0 })).toBe(0);
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

// ── THE CANONICAL CUSTODY INVARIANT ─────────────────────────────────────────────────────────────
//
//     received = returned + lost + issued + onShelf
//
// Four mutually exclusive buckets, so every physical unit is deducted exactly once however the three
// derived figures are combined. These cases walk the states a hire actually passes through and assert
// the whole row each time — the invariant first, then what each question answers about it.
describe("custody arithmetic — the four-bucket invariant", () => {
  type Q = { receivedQuantity: number; returnedQuantity: number; lostQuantity: number; issuedQuantity: number; fieldDamageQty: number };
  const q = (received: number, returned: number, lost: number, issued: number, damaged: number): Q => ({
    receivedQuantity: received, returnedQuantity: returned, lostQuantity: lost, issuedQuantity: issued, fieldDamageQty: damaged,
  });
  /** The whole row, so a case cannot pass by accident on the one number it was written for. */
  const row = (v: Q) => ({
    onShelf: v.receivedQuantity - v.returnedQuantity - v.lostQuantity - v.issuedQuantity,
    heldByUs: hireHeldByUs(v),
    atWarehouse: hireAtWarehouse(v),
    issuable: hireIssuable(v),
  });
  /** received = returned + lost + issued + onShelf, restated as the assertion it is. */
  const balances = (v: Q) => v.returnedQuantity + v.lostQuantity + v.issuedQuantity + row(v).onShelf === v.receivedQuantity;

  it("1 — a normal full return, end to end", () => {
    const delivered = q(3, 0, 0, 0, 0);
    expect(row(delivered)).toEqual({ onShelf: 3, heldByUs: 3, atWarehouse: 3, issuable: 3 });
    const issued = q(3, 0, 0, 3, 0);
    expect(row(issued)).toEqual({ onShelf: 0, heldByUs: 3, atWarehouse: 0, issuable: 0 });
    const back = q(3, 0, 0, 0, 0);
    expect(row(back)).toEqual({ onShelf: 3, heldByUs: 3, atWarehouse: 3, issuable: 3 });
    const collected = q(3, 3, 0, 0, 0);
    expect(row(collected)).toEqual({ onShelf: 0, heldByUs: 0, atWarehouse: 0, issuable: 0 });
    for (const v of [delivered, issued, back, collected]) expect(balances(v)).toBe(true);
  });

  it("2 — a partial return to the provider leaves the rest issuable", () => {
    const v = q(3, 1, 0, 0, 0);
    expect(row(v)).toEqual({ onShelf: 2, heldByUs: 2, atWarehouse: 2, issuable: 2 });
    expect(balances(v)).toBe(true);
  });

  it("3 — units in a van are held but not on the shelf", () => {
    const v = q(3, 0, 0, 2, 0);
    // Still ours to give back — which is why `heldByUs` does not net the van off.
    expect(row(v)).toEqual({ onShelf: 1, heldByUs: 3, atWarehouse: 1, issuable: 1 });
    expect(balances(v)).toBe(true);
  });

  it("4 — damage narrows ISSUABLE only, never what we hold or can hand back", () => {
    // Two good and one broken tester back from a job. THE BUG THIS FIXES: `issuable` used to read 3.
    const v = q(3, 0, 0, 0, 1);
    expect(row(v)).toEqual({ onShelf: 3, heldByUs: 3, atWarehouse: 3, issuable: 2 });
    // The broken one is still on the collection note — netting it off `atWarehouse` would make the
    // hire un-returnable, which is a worse dead end than the one being fixed.
    expect(hireAtWarehouse(v)).toBe(3);
    expect(balances(v)).toBe(true);
  });

  it("5 — a loss moves a unit out of ISSUED, and the hire can then finish", () => {
    const declared = q(3, 0, 1, 0, 0); // 2 came back, 1 declared lost
    expect(row(declared)).toEqual({ onShelf: 2, heldByUs: 2, atWarehouse: 2, issuable: 2 });
    const collected = q(3, 2, 1, 0, 0);
    expect(row(collected)).toEqual({ onShelf: 0, heldByUs: 0, atWarehouse: 0, issuable: 0 });
    // received = returned + lost ⇒ nothing left in our hands ⇒ the hire is finishable.
    expect(collected.returnedQuantity + collected.lostQuantity).toBe(collected.receivedQuantity);
    for (const v of [declared, collected]) expect(balances(v)).toBe(true);
  });

  it("6 — damage and loss on one hire are counted once each, not twice", () => {
    const v = q(4, 0, 1, 0, 1);
    expect(row(v)).toEqual({ onShelf: 3, heldByUs: 3, atWarehouse: 3, issuable: 2 });
    expect(balances(v)).toBe(true);
  });

  it("7 — recovering a lost unit puts it straight back on the shelf", () => {
    const lost = q(3, 0, 1, 0, 0);
    const found = q(3, 0, 0, 0, 0);
    expect(row(lost).issuable).toBe(2);
    expect(row(found).issuable).toBe(3);
    // Nothing else moves: recovery decrements ONE bucket and the shelf follows from the invariant.
    expect(found.receivedQuantity).toBe(lost.receivedQuantity);
    expect(found.returnedQuantity).toBe(lost.returnedQuantity);
  });

  it("8 — reversing a supplier charge changes no quantity at all", () => {
    // Settlement is a separate lifecycle. A credit note does not find a missing tester, so every
    // figure here is identical before and after — the row below IS the state both sides of it.
    const v = q(3, 2, 1, 0, 0);
    expect(row(v)).toEqual({ onShelf: 0, heldByUs: 0, atWarehouse: 0, issuable: 0 });
  });

  it("9 — partial return, damage, loss and a van, all at once", () => {
    const v = q(5, 1, 1, 0, 1);
    expect(row(v)).toEqual({ onShelf: 3, heldByUs: 3, atWarehouse: 3, issuable: 2 });
    expect(balances(v)).toBe(true);
    // Not finished: 3 are still on our shelf, one of them broken, and all 3 go back on a note.
    expect(v.returnedQuantity + v.lostQuantity).not.toBe(v.receivedQuantity);
  });

  it("clamps rather than reporting negative availability on a drifted row", () => {
    expect(hireHeldByUs(q(1, 0, 5, 0, 0))).toBe(0);
    expect(hireAtWarehouse(q(1, 0, 0, 9, 0))).toBe(0);
    expect(hireIssuable(q(1, 0, 0, 0, 9))).toBe(0);
  });

  it("reads a row that never stored the newer counters as none-lost, none-damaged", () => {
    // A hire raised before these columns existed has no such field at all, and MongoDB hands back
    // undefined rather than zero. NaN would be the silent failure — every comparison against it is
    // false, so an allocator would report a fully stocked hire as empty instead of throwing.
    const legacy = { receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 0 } as unknown as Q;
    expect(hireIssuable(legacy)).toBe(3);
  });
});

describe("allocateFromHires — damaged and lost units are never handed out", () => {
  it("skips the damaged units on a hire and falls through to the next", () => {
    // 3 delivered on the soonest hire, 1 of them broken: only 2 may go out, and the third unit the
    // engineer asked for has to come off the later hire rather than the broken one.
    const soon = hire("a", "2026-09-14", { fieldDamageQty: 1 });
    const later = hire("b", "2026-10-30");
    const plan = allocateFromHires([soon, later], 3);
    expect(plan).toEqual([
      { hire: soon, qty: 2 },
      { hire: later, qty: 1 },
    ]);
  });

  it("refuses the whole request when damage and loss leave the hires short", () => {
    // Partial allocation is never returned: issuing 2 of the 3 someone came for, silently, is worse
    // than saying so.
    expect(allocateFromHires([hire("a", "2026-09-14", { lostQuantity: 1, fieldDamageQty: 1 })], 3)).toBeNull();
  });
});
