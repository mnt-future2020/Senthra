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

const van = (quantity: number, status = "completed") => ({ transferCode: "ENG-0026", engineerName: "sahul FE", quantity, status });

describe("kitLineSourceSplit", () => {
  it("treats a line with no van sources as entirely warehouse-issued", () => {
    expect(kitLineSourceSplit(line({ issued: 4 }))).toEqual({ warehouseQty: 4, vanQty: 0, pendingVanQty: 0, vanOnly: false });
  });

  it("marks a fully van-supplied line as returnable anywhere", () => {
    expect(kitLineSourceSplit(line({ issued: 4, vanSources: [van(4)] }))).toEqual({
      warehouseQty: 0, vanQty: 4, pendingVanQty: 0, vanOnly: true,
    });
  });

  it("splits a MERGED line into its warehouse and van halves", () => {
    // Planned 3 = 2 collected from the warehouse + 1 handed over from a van.
    expect(kitLineSourceSplit(line({ qty: 3, issued: 3, vanSources: [van(1)] }))).toEqual({
      warehouseQty: 2, vanQty: 1, pendingVanQty: 0, vanOnly: false,
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
