import { describe, expect, it } from "vitest";

import { kitLineSourceSplit } from "./jobStatus";
import type { JobKitLine } from "@/types/job";

// A kit line merges sources: the same item at the same warehouse is ONE row, so units collected from
// the warehouse and units handed over from another engineer's van land on a single line. These pin
// the breakdown both kit lists render, and `vanOnly` — which decides whether leftovers may be handed
// back at any warehouse (van stock owes no warehouse) or only at the line's own (warehouse-issued).

const line = (over: Partial<JobKitLine> = {}): JobKitLine =>
  ({
    id: "k1",
    lineType: "irm",
    itemName: "Cat6 U/UTP Cable 305m Box",
    warehouseName: "London Fulfillment Centre",
    qty: 4,
    issued: 0,
    used: 0,
    returned: 0,
    remaining: 0,
    vanSources: [],
    ...over,
  }) as JobKitLine;

const van = (quantity: number, status = "completed") => ({ transferCode: "ENG-0026", engineerName: "sahul FE", engineerPhone: "07700900000", quantity, status });

describe("kitLineSourceSplit", () => {
  it("treats a line with no van sources as entirely warehouse-issued", () => {
    // qty 4, all 4 issued ⇒ nothing outstanding, and the warehouse's whole share is those 4.
    expect(kitLineSourceSplit(line({ issued: 4 }))).toEqual({
      warehouseQty: 4, vanQty: 0, vanReturnableQty: 0, pendingVanQty: 0, outstandingWarehouseQty: 0, warehouseShare: 4, vanOnly: false,
    });
  });

  it("marks a fully van-supplied line as returnable anywhere", () => {
    expect(kitLineSourceSplit(line({ issued: 4, vanSources: [van(4)] }))).toEqual({
      warehouseQty: 0, vanQty: 4, vanReturnableQty: 4, pendingVanQty: 0, outstandingWarehouseQty: 0, warehouseShare: 0, vanOnly: true,
    });
  });

  it("splits a MERGED line into its warehouse and van halves", () => {
    // Planned 3 = 2 collected from the warehouse + 1 handed over from a van.
    expect(kitLineSourceSplit(line({ qty: 3, issued: 3, vanSources: [van(1)] }))).toEqual({
      warehouseQty: 2, vanQty: 1, vanReturnableQty: 1, pendingVanQty: 0, outstandingWarehouseQty: 0, warehouseShare: 2, vanOnly: false,
    });
  });

  it("does NOT mark a mixed line van-only — the warehouse part is still owed back", () => {
    expect(kitLineSourceSplit(line({ issued: 6, vanSources: [van(2)] })).vanOnly).toBe(false);
  });

  it("excludes a pending transfer from the van total — nothing has been handed over yet", () => {
    const s = kitLineSourceSplit(line({ issued: 4, vanSources: [van(4, "pending")] }));
    expect(s).toMatchObject({ vanQty: 0, pendingVanQty: 4, vanOnly: false });
    // The 4 issued units must therefore read as warehouse-issued, not vanish from the breakdown.
    expect(s.warehouseQty).toBe(4);
  });

  it("sums several vans supplying one line", () => {
    const sources = [van(2), { ...van(1), transferCode: "ENG-0027", engineerName: "ravi FE" }];
    expect(kitLineSourceSplit(line({ issued: 3, vanSources: sources }))).toMatchObject({ vanQty: 3, warehouseQty: 0, vanOnly: true });
  });

  it("never reports a negative warehouse qty once van stock is returned elsewhere", () => {
    // Returning van stock at another warehouse can drop `issued` below the van total; a negative
    // would render as "×-2" in the kit list.
    expect(kitLineSourceSplit(line({ issued: 2, vanSources: [van(4)] })).warehouseQty).toBe(0);
  });

  it("reports nothing for an unissued line", () => {
    expect(kitLineSourceSplit(line({ issued: 0, vanSources: [van(4, "pending")] }))).toMatchObject({ warehouseQty: 0, vanOnly: false });
  });
});

// `warehouseQty` answers "how much of what ALREADY MOVED came from the warehouse" — it is derived
// from `issued`. That is the right question after the fact and the wrong one before it: on a line the
// planner has just split (say 3 planned, 2 agreed off a colleague's van, nothing issued yet) it is
// max(0, 0 - 0) = 0, so both kit lists hid the warehouse entirely. The engineer saw "Kansha M ×2
// awaiting handover" and a "Return at…" note, and was never told to collect the remaining 1.
//
// `warehouseShare` is the whole warehouse obligation for the line — what it has already supplied plus
// what it still owes — which is what an engineer planning a collection actually needs.
describe("kitLineSourceSplit — what the warehouse still owes", () => {
  it("counts the un-issued remainder of a split line", () => {
    // 3 planned, 2 coming off a van (agreed, not handed over), nothing issued.
    const s = kitLineSourceSplit(line({ qty: 3, issued: 0, vanSources: [van(2, "pending")] }));
    expect(s).toMatchObject({ warehouseQty: 0, pendingVanQty: 2, outstandingWarehouseQty: 1, warehouseShare: 1 });
  });

  it("owes nothing when a van covers the whole line", () => {
    const s = kitLineSourceSplit(line({ qty: 4, issued: 0, vanSources: [van(4, "pending")] }));
    expect(s).toMatchObject({ outstandingWarehouseQty: 0, warehouseShare: 0 });
  });

  // Once the units are issued the original figure is already correct, so the share must not
  // double-count them.
  it("does not double-count units the warehouse has already issued", () => {
    const s = kitLineSourceSplit(line({ qty: 3, issued: 3, vanSources: [van(2, "completed")] }));
    expect(s).toMatchObject({ warehouseQty: 1, outstandingWarehouseQty: 0, warehouseShare: 1 });
  });

  // Part handed over, part still to collect.
  it("adds the outstanding units to what has already been issued", () => {
    const s = kitLineSourceSplit(line({ qty: 5, issued: 2, vanSources: [van(2, "completed"), van(1, "pending")] }));
    // issued 2 of which 2 were the van → warehouse has issued 0; 5 - 2 issued - 1 pending = 2 to come.
    expect(s).toMatchObject({ warehouseQty: 0, outstandingWarehouseQty: 2, warehouseShare: 2 });
  });

  // Never negative: over-issue against a plan (or a return posted elsewhere) must not render as a
  // nonsense "-1 to collect".
  it("floors at zero when more was issued than planned", () => {
    const s = kitLineSourceSplit(line({ qty: 2, issued: 4, vanSources: [van(1, "completed")] }));
    expect(s.outstandingWarehouseQty).toBe(0);
  });
});

// A CANCELLED job has nothing left to collect: the warehouse can't issue against it (postIssue refuses
// it) and the pending handovers were withdrawn when it was cancelled. Both kit lists were still
// rendering "1 to collect" and counting the never-arriving units into the warehouse's share — telling
// an engineer to drive to a warehouse for a job that no longer exists.
describe("kitLineSourceSplit — a cancelled job has nothing left to collect", () => {
  const partlyCollected = () => line({ qty: 6, issued: 3, remaining: 3 });

  it("drops the outstanding collection", () => {
    expect(kitLineSourceSplit(partlyCollected()).outstandingWarehouseQty).toBe(3);
    expect(kitLineSourceSplit(partlyCollected(), { jobCancelled: true }).outstandingWarehouseQty).toBe(0);
  });

  // warehouseShare is what the kit list prints as "London Logistics Hub ×N". On a cancelled job that
  // must be what actually left the warehouse, not what was once planned to.
  it("shows only what the warehouse actually issued", () => {
    expect(kitLineSourceSplit(partlyCollected()).warehouseShare).toBe(6);
    expect(kitLineSourceSplit(partlyCollected(), { jobCancelled: true }).warehouseShare).toBe(3);
  });

  // What HAS moved is unchanged — those units are real and still have to be returned.
  it("leaves the issued and van figures alone", () => {
    const l = line({ qty: 6, issued: 3, remaining: 3, vanSources: [{ transferCode: "ENG-1", engineerName: "Kansha M", engineerPhone: null, quantity: 2, status: "completed" }] });
    const s = kitLineSourceSplit(l, { jobCancelled: true });
    expect(s.vanQty).toBe(2);
    expect(s.warehouseQty).toBe(1);
    expect(s.vanOnly).toBe(false);
  });

  it("is unchanged for a live job", () => {
    expect(kitLineSourceSplit(partlyCollected(), { jobCancelled: false })).toEqual(kitLineSourceSplit(partlyCollected()));
  });
});

// Van-sourced IRM owes no warehouse, so it can be scanned back anywhere. CUSTOMER stock cannot: a
// CustomerStockEntry IS one location and a return credits that entry, so there is nowhere for an
// away-from-home consignment return to land. The server has always agreed — scanLookup and postReturn
// only do away-returns for irm — but both kit lists printed "Return ×2 at London Logistics Hub, ×1 at
// any warehouse" on a consignment line, sending an engineer to a warehouse whose scan would reject it.
describe("kitLineSourceSplit — only IRM van stock may go back anywhere", () => {
  const van = (quantity: number) => [{ transferCode: "ENG-1", engineerName: "Kansha M", engineerPhone: null, quantity, status: "completed" }];

  it("reports the van portion as returnable anywhere for IRM", () => {
    const s = kitLineSourceSplit(line({ lineType: "irm", qty: 5, issued: 3, vanSources: van(1) }));
    expect(s.vanQty).toBe(1);
    expect(s.vanReturnableQty).toBe(1);
  });

  it("reports none for customer stock, however it arrived", () => {
    const s = kitLineSourceSplit(line({ lineType: "customer_stock", qty: 5, issued: 3, vanSources: van(1) }));
    // The source split still shows where the units came from…
    expect(s.vanQty).toBe(1);
    // …but every unit still owes the entry's own warehouse.
    expect(s.vanReturnableQty).toBe(0);
  });

  // vanOnly is what prints "Return at any warehouse" — it must never fire on consignment.
  it("never marks a customer-stock line as return-anywhere", () => {
    expect(kitLineSourceSplit(line({ lineType: "irm", qty: 3, issued: 3, vanSources: van(3) })).vanOnly).toBe(true);
    expect(kitLineSourceSplit(line({ lineType: "customer_stock", qty: 3, issued: 3, vanSources: van(3) })).vanOnly).toBe(false);
  });

  it("treats misc the same — it is not stock-tracked at all", () => {
    expect(kitLineSourceSplit(line({ lineType: "misc", qty: 3, issued: 3, vanSources: van(3) })).vanReturnableQty).toBe(0);
  });
});
