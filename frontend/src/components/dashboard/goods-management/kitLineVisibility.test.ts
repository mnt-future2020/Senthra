import { describe, expect, it } from "vitest";

import { isLineActionable, visibleKitLines, type VisibilityKitLine } from "./kitLineVisibility";

const WH = "wh-here";
const OTHER = "wh-elsewhere";

const line = (over: Partial<VisibilityKitLine> = {}): VisibilityKitLine => ({
  lineType: "irm",
  plannedQty: 5,
  issuedQty: 0,
  warehouseId: WH,
  vanReturnableQty: 0,
  ...over,
});

describe("isLineActionable", () => {
  it("accepts a real line homed at this warehouse", () => {
    expect(isLineActionable(line(), WH)).toBe(true);
  });

  it("rejects a real line homed elsewhere with no van stock — it must be issued from its own warehouse", () => {
    expect(isLineActionable(line({ warehouseId: OTHER }), WH)).toBe(false);
  });

  // Van-sourced stock owes no warehouse, so a return must be accepted anywhere. Greying this out would
  // have the manager turn an engineer away for a return the server would have taken.
  it("accepts a line homed elsewhere that still holds van-returnable stock", () => {
    expect(isLineActionable(line({ warehouseId: OTHER, vanReturnableQty: 2 }), WH)).toBe(true);
  });

  it("accepts a misc line until it is fully issued, then stops", () => {
    expect(isLineActionable(line({ lineType: "misc", warehouseId: null, plannedQty: 2, issuedQty: 1 }), WH)).toBe(true);
    expect(isLineActionable(line({ lineType: "misc", warehouseId: null, plannedQty: 2, issuedQty: 2 }), WH)).toBe(false);
  });

  it("treats an over-issued misc line as finished", () => {
    expect(isLineActionable(line({ lineType: "misc", warehouseId: null, plannedQty: 2, issuedQty: 3 }), WH)).toBe(false);
  });
});

describe("visibleKitLines", () => {
  const kit = [
    line({ warehouseId: OTHER }), // elsewhere, nothing to do here
    line(), // here — actionable
    line({ lineType: "misc", warehouseId: null, plannedQty: 2, issuedQty: 2 }), // misc, done
    line({ warehouseId: OTHER, vanReturnableQty: 1 }), // van return, actionable anywhere
  ];

  it("keeps only actionable lines and reports how many were folded away", () => {
    const { lines, hiddenCount } = visibleKitLines(kit, WH, false);
    expect(lines).toHaveLength(2);
    expect(hiddenCount).toBe(2);
  });

  it("returns the kit untouched when showAll is set", () => {
    const { lines, hiddenCount } = visibleKitLines(kit, WH, true);
    expect(lines).toEqual(kit);
    expect(hiddenCount).toBe(0);
  });

  // A job rendering zero rows would corrupt the table's rowSpan grouping, so an all-inactionable kit
  // degrades to showing everything rather than to a broken row.
  it("falls back to the full kit rather than emptying a job", () => {
    const noneActionable = [line({ warehouseId: OTHER }), line({ warehouseId: OTHER })];
    const { lines, hiddenCount } = visibleKitLines(noneActionable, WH, false);
    expect(lines).toEqual(noneActionable);
    expect(hiddenCount).toBe(0);
  });
});

// A CANCELLED job can never be issued against again (postIssue refuses it) and its pending handovers
// are withdrawn the moment it is cancelled. So its never-issued lines are not "work waiting here" —
// they are rows that can only ever be looked at. The queue was still listing them as "Not issued" with
// a planned quantity, which reads as outstanding work at this warehouse.
//
// Display-only: the JOB stays in the queue either way (the server decides that), because a cancelled
// job whose stock is all back still has to be closed from here. If this predicate would empty a job,
// visibleKitLines falls back to the whole kit, so that job never becomes unreachable.
describe("isLineActionable — a cancelled job has nothing left to issue", () => {
  const l = (over: Partial<VisibilityKitLine> = {}): VisibilityKitLine =>
    ({ lineType: "irm", plannedQty: 3, issuedQty: 0, warehouseId: "wh1", vanReturnableQty: 0, ...over });

  it("keeps a line that still has stock out", () => {
    expect(isLineActionable(l({ issuedQty: 3 }), "wh1", true)).toBe(true);
  });

  it("drops a line nothing was ever issued against", () => {
    expect(isLineActionable(l(), "wh1", true)).toBe(false);
    // …while a LIVE job keeps it: that stock is still to be collected.
    expect(isLineActionable(l(), "wh1", false)).toBe(true);
  });

  // Van-sourced stock owes no warehouse, so it can land here even though the line is homed elsewhere.
  it("keeps van-returnable stock from another warehouse's line", () => {
    expect(isLineActionable(l({ warehouseId: "wh2", vanReturnableQty: 2 }), "wh1", true)).toBe(true);
  });

  // Misc is free text, handed over by count and never stock-tracked — it cannot be scanned back at any
  // warehouse. On a cancelled job nothing more is handed over either, so there is no action left on it.
  it("drops every misc line, finished or not", () => {
    for (const issuedQty of [0, 1, 3]) {
      expect(isLineActionable(l({ lineType: "misc", warehouseId: null, issuedQty }), "wh1", true)).toBe(false);
    }
  });

  // …while a LIVE job keeps an unfinished one: any warehouse may still hand the rest over.
  it("leaves a live job's misc line alone", () => {
    expect(isLineActionable(l({ lineType: "misc", warehouseId: null, issuedQty: 1 }), "wh1", false)).toBe(true);
    expect(isLineActionable(l({ lineType: "misc", warehouseId: null, issuedQty: 3 }), "wh1", false)).toBe(false);
  });

  it("thins the rows without ever emptying the job", () => {
    const kit = [l({ issuedQty: 3 }), l(), l()];
    expect(visibleKitLines(kit, "wh1", false, true)).toMatchObject({ hiddenCount: 2 });
    // Nothing out anywhere — the job still has to be closed from here, so the kit stays whole.
    expect(visibleKitLines([l(), l()], "wh1", false, true)).toMatchObject({ hiddenCount: 0 });
  });
});
