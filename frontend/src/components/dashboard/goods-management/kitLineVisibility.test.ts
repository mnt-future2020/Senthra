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
