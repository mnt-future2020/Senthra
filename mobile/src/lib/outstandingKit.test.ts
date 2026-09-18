import { describe, expect, it } from "vitest";

// Ported from the web's outstandingKit.test.ts, minus its `outstandingKitWarning` blocks: that
// helper backs the staff cancel dialog and does not exist here, because an engineer cannot cancel
// a job. What IS shared is the count of what is still in the van, and that is what this pins.

import { outstandingKit } from "./jobKit";
import type { JobKitLine } from "@/types";

const line = (over: Partial<JobKitLine>): JobKitLine =>
  ({ id: "k1", lineType: "irm", itemName: "CAT6", qty: 6, issued: 0, used: 0, returned: 0, remaining: 0, vanSources: [], ...over }) as JobKitLine;

describe("outstandingKit — what is still in the engineer's van", () => {
  it("sums what is still held", () => {
    expect(outstandingKit([line({ remaining: 3 }), line({ id: "k2", remaining: 4 })])).toEqual({ units: 7, items: 2 });
  });

  it("ignores lines that are fully settled", () => {
    expect(outstandingKit([line({ issued: 6, returned: 6, remaining: 0 })])).toEqual({ units: 0, items: 0 });
  });

  // Free-text lines are never stock-tracked — they can't be scanned back or written off, so counting
  // them would warn about units nobody is able to return.
  it("excludes misc lines", () => {
    expect(outstandingKit([line({ lineType: "misc", remaining: 5 }), line({ id: "k2", remaining: 2 })])).toEqual({ units: 2, items: 1 });
  });

  it("counts customer stock, which is just as out as IRM", () => {
    expect(outstandingKit([line({ lineType: "customer_stock", remaining: 3 })])).toEqual({ units: 3, items: 1 });
  });
});
