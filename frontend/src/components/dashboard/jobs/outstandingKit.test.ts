import { describe, expect, it } from "vitest";

import { outstandingKit, outstandingKitWarning } from "./outstandingKit";
import type { JobKitLine } from "@/types/job";

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

describe("outstandingKitWarning — the line the cancel dialog shows", () => {
  it("names the engineer and what they hold", () => {
    const msg = outstandingKitWarning([line({ remaining: 3 }), line({ id: "k2", remaining: 12 })], "Shahul FE")!;
    expect(msg).toContain("Shahul FE");
    expect(msg).toContain("15 units across 2 items");
    // The point of the warning: a cancel settles nothing on its own.
    expect(msg).toMatch(/scanned back in or written off/i);
  });

  it("drops the item count when it's all one line", () => {
    expect(outstandingKitWarning([line({ remaining: 4 })], "Shahul FE")).toContain("4 units.");
  });

  it("reads correctly for a single unit", () => {
    expect(outstandingKitWarning([line({ remaining: 1 })], "Shahul FE")).toContain("1 unit.");
  });

  it("falls back when the job has no engineer name", () => {
    expect(outstandingKitWarning([line({ remaining: 2 })], null)).toMatch(/^The engineer is still holding/);
  });

  // Nothing out ⇒ no advisory at all. A "0 units" line would be noise on every ordinary cancel.
  it("says nothing when nothing is out", () => {
    expect(outstandingKitWarning([line({ remaining: 0 })], "Shahul FE")).toBeNull();
    expect(outstandingKitWarning([], "Shahul FE")).toBeNull();
  });
});

// Hired kit is the provider's. An unreturned unit is a liability to settle with them, not a loss we
// can absorb — and the reconcile refuses to write one off — so the sentence must not offer it.
describe("outstandingKitWarning — rental items", () => {
  it("names the rental units and drops the write-off escape", () => {
    const msg = outstandingKitWarning([line({ lineType: "rental", remaining: 2 })], "Dave");
    expect(msg).toMatch(/2 rental units/);
    expect(msg).toMatch(/can't be written off/);
    expect(msg).not.toMatch(/scanned back in or written off/);
  });

  it("still offers the write-off wording when no rental is out", () => {
    const msg = outstandingKitWarning([line({ lineType: "irm", remaining: 2 })], "Dave");
    expect(msg).toMatch(/scanned back in or written off/);
  });

  it("counts a rental line toward the outstanding total", () => {
    // A hire must come back, so it can never be "nothing to settle".
    expect(outstandingKit([line({ lineType: "rental", remaining: 1 })])).toEqual({ units: 1, items: 1 });
  });
});
