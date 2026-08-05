import { describe, expect, it } from "vitest";

import { availabilityParts, kitItemAvailability } from "./kitItemAvailability";
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
