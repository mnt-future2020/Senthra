import { describe, expect, it } from "vitest";

import { crossWarehouseReturnNote, kitLineOutcome, returnLocationNote } from "./jobKit";
import type { JobKitLine, KitRequestLine } from "@/types";

// The three kit helpers with no ported twin: the web computes the same things inside its JSX, so
// there was no test file to copy. They are pinned here because each one is a SENTENCE an engineer
// acts on — where to carry a box back to, and what a reviewer actually granted.

const line = (over: Partial<JobKitLine> = {}): JobKitLine =>
  ({
    id: "l1",
    lineType: "irm",
    qty: 5,
    issued: 5,
    returned: 0,
    remaining: 5,
    warehouseName: null,
    irmItemId: null,
    customerStockEntryId: null,
  }) as unknown as JobKitLine;

const merge = (over: Partial<JobKitLine>): JobKitLine => ({ ...line(), ...over }) as JobKitLine;

describe("returnLocationNote", () => {
  const split = (over: Partial<{ vanOnly: boolean; vanReturnableQty: number; warehouseQty: number }>) =>
    ({ vanOnly: false, vanReturnableQty: 0, warehouseQty: 0, ...over }) as never;

  it("lets a van-only line go back anywhere", () => {
    // Nothing came off a warehouse shelf, so no counter owns the return.
    expect(returnLocationNote(line(), split({ vanOnly: true }))).toBe("Return at any warehouse");
  });

  it("splits the sentence when the line came from both a shelf and the van", () => {
    expect(
      returnLocationNote(
        merge({ warehouseName: "London Logistics Hub" }),
        split({ vanReturnableQty: 2, warehouseQty: 3 }),
      ),
    ).toBe("Return ×3 at London Logistics Hub, ×2 at any warehouse");
  });

  it("names the issuing warehouse for a pure warehouse line", () => {
    expect(returnLocationNote(merge({ warehouseName: "Bristol Depot" }), split({ warehouseQty: 4 }))).toBe(
      "Return at Bristol Depot",
    );
  });

  it("says nothing rather than guessing when no warehouse is known", () => {
    // An empty string renders no advisory at all; inventing "any warehouse" here would contradict
    // the server, which refuses a hired return at the wrong depot.
    expect(returnLocationNote(line(), split({ warehouseQty: 4 }))).toBe("");
  });
});

describe("kitLineOutcome", () => {
  const req = (over: Partial<KitRequestLine>): KitRequestLine => ({ qty: 10, ...over }) as KitRequestLine;

  it("treats a null approval as granted in full — every pre-review row is null", () => {
    expect(kitLineOutcome(req({ approvedQty: null }))).toEqual({ qty: 10, excluded: false, trimmed: false });
  });

  it("reads zero as excluded — and, being less than asked, trimmed as well", () => {
    // Both flags are true at once, deliberately: zero IS less than the quantity requested. Callers
    // ask `excluded` first and never reach the trimmed wording, which is why this has never shown as
    // "trimmed to 0". Pinned so nobody "fixes" the overlap and changes what an excluded line reads
    // as. Verified identical in the web's own copy (EngineerKitRequests.tsx).
    expect(kitLineOutcome(req({ approvedQty: 0 }))).toEqual({ qty: 0, excluded: true, trimmed: true });
  });

  it("marks a partial grant as trimmed and reports what was granted", () => {
    expect(kitLineOutcome(req({ approvedQty: 4 }))).toEqual({ qty: 4, excluded: false, trimmed: true });
  });

  it("is neither trimmed nor excluded when the full quantity was approved explicitly", () => {
    expect(kitLineOutcome(req({ approvedQty: 10 }))).toEqual({ qty: 10, excluded: false, trimmed: false });
  });
});

describe("crossWarehouseReturnNote", () => {
  it("stays silent while returns have not passed issues", () => {
    expect(crossWarehouseReturnNote(merge({ issued: 5, returned: 5 }), [])).toBeNull();
  });

  it("explains a surplus by naming the sibling line it must have come from", () => {
    // The real case: issued from two depots, all of it handed back at one counter.
    const here = merge({ id: "a", issued: 2, returned: 5, irmItemId: "i1" });
    const sibling = merge({ id: "b", issued: 4, returned: 1, irmItemId: "i1", warehouseName: "Bristol Depot" });
    expect(crossWarehouseReturnNote(here, [here, sibling])).toBe("+3 from Bristol Depot");
  });

  it("falls back to 'another warehouse' when no sibling still has stock out", () => {
    const here = merge({ id: "a", issued: 2, returned: 5, irmItemId: "i1" });
    const settled = merge({ id: "b", issued: 4, returned: 4, irmItemId: "i1", warehouseName: "Bristol Depot" });
    expect(crossWarehouseReturnNote(here, [here, settled])).toBe("+3 from another warehouse");
  });

  it("matches customer-stock siblings by their entry, not by item id", () => {
    const here = merge({ id: "a", issued: 1, returned: 3, customerStockEntryId: "c1" });
    const sibling = merge({
      id: "b",
      issued: 5,
      returned: 0,
      customerStockEntryId: "c1",
      warehouseName: "London Logistics Hub",
    });
    expect(crossWarehouseReturnNote(here, [here, sibling])).toBe("+2 from London Logistics Hub");
  });

  it("never names the same warehouse twice", () => {
    const here = merge({ id: "a", issued: 1, returned: 4, irmItemId: "i1" });
    const s1 = merge({ id: "b", issued: 3, returned: 0, irmItemId: "i1", warehouseName: "Bristol Depot" });
    const s2 = merge({ id: "c", issued: 2, returned: 0, irmItemId: "i1", warehouseName: "Bristol Depot" });
    expect(crossWarehouseReturnNote(here, [here, s1, s2])).toBe("+3 from Bristol Depot");
  });
});
