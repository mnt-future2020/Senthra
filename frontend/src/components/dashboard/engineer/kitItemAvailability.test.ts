import { describe, expect, it } from "vitest";

import { availabilityParts, kitItemAvailability, rentalAvailabilityParts } from "./kitItemAvailability";
import type { KitItemOption } from "@/services/jobKitRequest.service";

const irm = (quantityOnHand: number, heldByEngineers: number): KitItemOption => ({
  source: "irm",
  irmItemId: "i".repeat(24),
  code: "IRM-1",
  name: "CAT6 Cable",
  sku: null,
  uom: null,
  quantityOnHand,
  heldByEngineers,
});

const customerStock = (qty: number): KitItemOption => ({
  source: "customer_stock",
  customerStockEntryId: "e".repeat(24),
  name: "mouse123",
  sku: null,
  uom: null,
  qty,
  warehouseName: "Testing Ware",
  warehouseCode: "WH-9",
  serialNumber: null,
});

const rental = (quantityOnHand: number, depots: { warehouseId: string; warehouseName: string | null; available: number }[] = []): KitItemOption => ({
  source: "rental",
  rentalItemId: "d".repeat(24),
  code: "RNT-0007",
  name: "Fibre Tester",
  sku: null,
  uom: "Each",
  quantityOnHand,
  heldByEngineers: 0,
  depots,
});

// Hired kit is depot-only, and for a different reason than consignment: custody of a hire is anchored
// to the depot that took delivery and the provider collects it from there, so it is never
// transferable engineer-to-engineer.
describe("kitItemAvailability — rental", () => {
  it("counts what is free on hire and allows the request", () => {
    const a = kitItemAvailability(rental(4, [{ warehouseId: "w1", warehouseName: "Leeds", available: 4 }]));
    expect(a).toMatchObject({ total: 4, requestable: true });
    // Silent: the search sub-line already prints "RNT-0007 · Leeds · 4 free on hire", so a label here
    // would print the figure twice — same rule the consignment branch follows.
    expect(a.label).toBe("");
  });

  it("blocks the request when nothing is on hire, and says what to do instead", () => {
    const a = kitItemAvailability(rental(0));
    expect(a.requestable).toBe(false);
    // NOT "no warehouse or engineer has this" — an engineer can never hold a spare hire, so naming
    // one would point at a source that cannot exist. The real fix is a purchase request.
    expect(a.label).toMatch(/none on hire/i);
    expect(a.label).toMatch(/purchase request/i);
    expect(a.label).not.toMatch(/engineer/i);
  });

  it("never advertises van stock, even if a payload claimed some", () => {
    // heldByEngineers is structurally 0 on the wire; this pins that the branch ignores the field
    // rather than summing it the way the IRM branch does.
    const a = kitItemAvailability({ ...rental(2), heldByEngineers: 9 } as unknown as KitItemOption);
    expect(a.total).toBe(2);
  });
});

// An engineer could add any active catalogue item to a kit request, including ones that existed in no
// warehouse and on no van. The planner then opened the approve dialog with nothing to pick for that
// line and no way to submit — the request just sat pending. Requestability is decided HERE, on the
// only two sources approve() can draw from, so the item is unselectable before it is ever asked for.
describe("kitItemAvailability — can this item actually be fulfilled?", () => {
  it("is requestable when a warehouse holds it", () => {
    expect(kitItemAvailability(irm(7, 0))).toMatchObject({ total: 7, requestable: true });
  });

  // A colleague's van is a real source — approve() transfers from it. Counting warehouses alone would
  // block a request that could have been filled today.
  it("is requestable when only another engineer's van holds it", () => {
    expect(kitItemAvailability(irm(0, 2))).toMatchObject({ total: 2, requestable: true });
  });

  it("sums both sources", () => {
    expect(kitItemAvailability(irm(4, 3))).toMatchObject({ total: 7, requestable: true });
  });

  // The bug: neither source has any, so no planner decision exists that would fulfil it.
  it("is NOT requestable when neither a warehouse nor a van holds it", () => {
    expect(kitItemAvailability(irm(0, 0))).toMatchObject({ total: 0, requestable: false });
  });

  it("explains why an unavailable item is unselectable", () => {
    expect(kitItemAvailability(irm(0, 0)).label).toMatch(/out of stock/i);
  });

  // The counts split across two very different places, and "2 available" alone would send an engineer
  // to a warehouse that has none of it.
  it("says where the stock actually is", () => {
    expect(kitItemAvailability(irm(4, 3)).label).toMatch(/4 in stock/i);
    expect(kitItemAvailability(irm(4, 3)).label).toMatch(/3 .*van/i);
    expect(kitItemAvailability(irm(4, 0)).label).not.toMatch(/van/i);
    expect(kitItemAvailability(irm(0, 3)).label).toMatch(/van/i);
  });

  // Customer stock is the job's own consignment, already scoped and in-stock by the search, and it is
  // never sourced from a van — its own qty is the whole answer.
  it("uses the entry's own quantity for customer stock", () => {
    expect(kitItemAvailability(customerStock(4))).toMatchObject({ total: 4, requestable: true });
    expect(kitItemAvailability(customerStock(0))).toMatchObject({ total: 0, requestable: false });
  });

  // Older clients / cached responses predate the availability fields. Treating missing as ZERO would
  // disable the entire catalogue; the safe default is to allow the request and let approve() decide.
  it("treats missing counts as available rather than locking the catalogue", () => {
    const legacy = { source: "irm", irmItemId: "x", code: "C", name: "N", sku: null, uom: null } as unknown as KitItemOption;
    expect(kitItemAvailability(legacy).requestable).toBe(true);
  });
});

// Consignment does NOT behave like IRM here, and the earlier version of this file assumed it did.
//
// A field stock request carries only irmItemId — its validation has no customerStockEntryId — so
// consignment never reaches an engineer as free van stock. The only writes to
// EngineerCustomerStockHolding are a JOB ISSUE and a job-scoped transfer, which means every unit an
// engineer holds arrived through a job and is committed to it. That is precisely why
// jobCommittedByEngineer refuses to cover customer stock ("never field-returnable") — and why there
// was no commitment figure to net off. Counting it as available double-booked another job's stock.
describe("kitItemAvailability — consignment is warehouse-only", () => {
  // The option type carries no van field at all now, so "ignores engineer holdings" is enforced by
  // the shape rather than by arithmetic — an empty shelf is simply unavailable.
  it("is unavailable on an empty shelf, whatever an engineer may be holding", () => {
    expect(kitItemAvailability(customerStock(0))).toMatchObject({ total: 0, requestable: false });
  });

  it("counts only the shelf", () => {
    expect(kitItemAvailability(customerStock(4))).toMatchObject({ total: 4, requestable: true });
  });

  // The message named a source that cannot apply: an engineer's consignment holding is never a
  // source for a new request, so "or engineer" was telling the engineer to expect something the
  // system would never offer.
  it("does not blame an engineer for an empty consignment shelf", () => {
    const label = kitItemAvailability(customerStock(0)).label;
    expect(label).toMatch(/out of stock/i);
    expect(label).not.toMatch(/engineer/i);
  });

  // IRM keeps the fuller wording — a colleague's van genuinely IS a source there.
  it("keeps the engineer wording for IRM, where a van really can supply it", () => {
    expect(kitItemAvailability(irm(0, 0)).label).toMatch(/engineer/i);
  });

  it("still adds no second in-stock line when the sub-line already shows it", () => {
    expect(kitItemAvailability(customerStock(5)).label).toBe("");
  });
});

// The composer's quantity steppers and the search rows must describe the same stock with the same
// words. They didn't: the search said "1992 in stock · 3 on another van" while the stepper collapsed
// it to a single "1995 free to request", which also made this modal disagree with the field-stock
// composer's 1992 for no visible reason. One formatter, used by both.
describe("availabilityParts — one vocabulary for where the stock is", () => {
  it("names the warehouse and the van separately", () => {
    expect(availabilityParts(1992, 3)).toBe("1992 in stock · 3 on another van");
  });

  it("omits a part that is zero", () => {
    expect(availabilityParts(1992, 0)).toBe("1992 in stock");
    expect(availabilityParts(0, 3)).toBe("3 on another van");
  });

  it("says nothing when there is nothing", () => {
    expect(availabilityParts(0, 0)).toBe("");
  });

  // The IRM search row's label must BE this, so the two can't drift.
  it("is what the IRM search row renders", () => {
    expect(kitItemAvailability(irm(4, 3)).label).toBe(availabilityParts(4, 3));
  });
});

// ── Hired equipment is not stock we own ────────────────────────────────────────────────────────
//
// The bug: a fibre tester on hire rendered as "23 in stock" on the planned-row sub-line, because that
// row called the generic formatter above. False twice over — it is not our stock, and the figure is
// bounded by a hire period rather than by what we own — and the SEARCH row for the very same item in
// the very same modal described it differently, so the modal contradicted itself.
describe("rentalAvailabilityParts — hired equipment", () => {
  const depot = (warehouseName: string | null) => ({ warehouseName });

  it("never describes hired equipment as stock", () => {
    expect(rentalAvailabilityParts(23, [depot("test work")])).not.toContain("in stock");
  });

  it("states what can actually go out, and from where", () => {
    expect(rentalAvailabilityParts(23, [depot("test work")])).toBe("Available to issue: 23 · test work");
  });

  // An engineer with kit at several depots needs to know there is a choice, not read the list — this
  // is a sub-line under a quantity stepper.
  it("names one depot and counts the rest", () => {
    expect(rentalAvailabilityParts(23, [depot("Leeds"), depot("York"), depot("Hull")])).toBe(
      "Available to issue: 23 · Leeds +2 more",
    );
  });

  it("falls back to a neutral word when a depot has no name", () => {
    expect(rentalAvailabilityParts(4, [depot(null)])).toBe("Available to issue: 4 · Depot");
  });

  // No depots resolved (the lookup returned a total but no breakdown): still say the useful half
  // rather than inventing a location.
  it("omits the location when there is none to name", () => {
    expect(rentalAvailabilityParts(4, [])).toBe("Available to issue: 4");
  });

  // Nothing issuable is a DEAD END for a rental — there is no van fallback, so the only way forward is
  // to hire one. Reusing the search row's sentence keeps that advice in one place.
  it("points at the only way forward when nothing is issuable", () => {
    // The SAME sentence the search row uses, so the advice lives in one place.
    expect(rentalAvailabilityParts(0, [depot("Leeds")])).toBe(kitItemAvailability(rental(0)).label);
    expect(rentalAvailabilityParts(0, [])).toContain("raise a purchase request to hire one");
  });

  it("treats a negative figure as nothing issuable", () => {
    expect(rentalAvailabilityParts(-1, [])).toContain("raise a purchase request");
  });
});
