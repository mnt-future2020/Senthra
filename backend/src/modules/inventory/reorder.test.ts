import { describe, expect, it } from "vitest";

import { computeReorderMath, REORDER_REASON_RANK } from "./reorder.js";

// The reorder maths is the contract the workbench AND the generate-time revalidation share — every
// rule (netting, trigger, target fallbacks, pack rounding, reasons) is pinned here.

const base = {
  onHand: 0,
  reserved: 0,
  incoming: 0,
  openPrf: 0,
  plannedDemand: 0,
  reorderLevel: null as number | null,
  criticalLevel: null as number | null,
  maximumStock: null as number | null,
  packSize: null as number | null,
};

describe("computeReorderMath — trigger rules", () => {
  it("does not trigger when projected is above the reorder level", () => {
    expect(computeReorderMath({ ...base, onHand: 50, reorderLevel: 20 })).toBeNull();
  });

  it("triggers at exactly the reorder level (≤, not <)", () => {
    const r = computeReorderMath({ ...base, onHand: 20, reorderLevel: 20, maximumStock: 100 });
    expect(r).not.toBeNull();
    expect(r!.suggestedQty).toBe(80);
  });

  it("no policy (null/0 reorderLevel) never triggers on its own", () => {
    expect(computeReorderMath({ ...base, onHand: 0 })).toBeNull();
    expect(computeReorderMath({ ...base, onHand: 5, reorderLevel: 0 })).toBeNull();
  });

  it("a NEGATIVE projected position triggers even without a policy", () => {
    const r = computeReorderMath({ ...base, onHand: 2, reserved: 5 });
    expect(r).not.toBeNull();
    expect(r!.projected).toBe(-3);
  });
});

describe("computeReorderMath — netting", () => {
  it("subtracts reservations from available", () => {
    const r = computeReorderMath({ ...base, onHand: 8, reserved: 4, reorderLevel: 20, maximumStock: 100 });
    expect(r!.available).toBe(4);
    expect(r!.projected).toBe(4);
    expect(r!.suggestedQty).toBe(96);
  });

  it("incoming open-PO stock raises projected (and can fully cover the need)", () => {
    const r = computeReorderMath({ ...base, onHand: 5, incoming: 10, reorderLevel: 20, maximumStock: 100 });
    expect(r!.projected).toBe(15);
    expect(r!.suggestedQty).toBe(85);
    expect(r!.covered).toBe(false);
    // Enough incoming ⇒ physically low but fully covered: an informational COVERED row (nothing to buy).
    const covered = computeReorderMath({ ...base, onHand: 5, incoming: 50, reorderLevel: 20, maximumStock: 100 });
    expect(covered!.covered).toBe(true);
    expect(covered!.suggestedQty).toBe(0);
    expect(covered!.projected).toBe(55);
  });

  it("open PRFs COVER the need (added, like incoming) — stock already being requested is not re-suggested", () => {
    // Without an open PRF: projected 5, suggest 95 (to max 100).
    expect(computeReorderMath({ ...base, onHand: 5, reorderLevel: 20, maximumStock: 100 })!.suggestedQty).toBe(95);
    // A PARTIAL 10-unit draft PRF already open raises projected to 15 (still ≤ reorder level, so the
    // row still triggers) and shrinks the NEW need to 85 (85 + 15 = 100 = target) — 10 less than the
    // 95 above, i.e. the 10 already requested is not bought twice.
    const partial = computeReorderMath({ ...base, onHand: 5, openPrf: 10, reorderLevel: 20, maximumStock: 100 });
    expect(partial!.projected).toBe(15);
    expect(partial!.suggestedQty).toBe(85);
    // A 95-unit draft PRF already open lifts projected to 100 (= target, above the reorder level), so
    // the need is fully covered: an informational COVERED row with nothing to buy — never an actionable
    // suggestion. The generate-time revalidation excludes covered rows, which is what stops a concurrent
    // second user double-raising the same PRF (their row is skipped once the first user's draft is here).
    const fully = computeReorderMath({ ...base, onHand: 5, openPrf: 95, reorderLevel: 20, maximumStock: 100 });
    expect(fully!.covered).toBe(true);
    expect(fully!.suggestedQty).toBe(0);
  });
});

describe("computeReorderMath — target fallbacks + pack rounding", () => {
  it("target = maximumStock when set", () => {
    expect(computeReorderMath({ ...base, onHand: 12, reorderLevel: 30, maximumStock: 100 })!.suggestedQty).toBe(88);
  });

  it("target falls back to the reorder level alone", () => {
    const r = computeReorderMath({ ...base, onHand: 12, reorderLevel: 30 });
    expect(r!.target).toBe(30);
    expect(r!.suggestedQty).toBe(18);
  });

  it("rounds UP to a pack-size multiple", () => {
    const r = computeReorderMath({ ...base, onHand: 12, reorderLevel: 30, maximumStock: 95, packSize: 10 });
    expect(r!.suggestedQty).toBe(90); // raw 83 → 90
  });

  it("suggests at least 1 (pack-rounded) even at the boundary", () => {
    const r = computeReorderMath({ ...base, onHand: 30, reorderLevel: 30, packSize: 10 });
    expect(r!.suggestedQty).toBe(10); // raw target(30)−projected(30)=0 → min 1 → pack 10
  });
});

describe("computeReorderMath — planned job demand", () => {
  it("planned demand SUBTRACTS from projected and can trigger a physically-healthy shelf", () => {
    // On hand 120 (healthy vs level 50) but jobs plan to draw 80 → projected 40 ≤ 50 → buy.
    const r = computeReorderMath({ ...base, onHand: 120, plannedDemand: 80, reorderLevel: 50, maximumStock: 200 });
    expect(r).not.toBeNull();
    expect(r!.projected).toBe(40);
    expect(r!.reason).toBe("planned_demand"); // shelf is fine TODAY — the trigger is future job draw
    expect(r!.covered).toBe(false);
    expect(r!.suggestedQty).toBe(160); // top back up to max: 200 − 40
  });

  it("keeps the PHYSICAL reason when the shelf itself is also low", () => {
    const r = computeReorderMath({ ...base, onHand: 10, plannedDemand: 30, reorderLevel: 50, maximumStock: 100 });
    expect(r!.reason).toBe("below_reorder"); // physically short — demand only deepens it
  });

  it("composes with pipeline supply — incoming + open PRFs offset planned demand", () => {
    // available 60 + incoming 40 + openPrf 20 − planned 30 = 90 > level 40, shelf healthy too ⇒ no
    // row at all: the pipeline fully absorbs the planned draw.
    expect(
      computeReorderMath({ ...base, onHand: 60, plannedDemand: 30, incoming: 40, openPrf: 20, reorderLevel: 40, maximumStock: 100 }),
    ).toBeNull();
  });

  it("demand-driven negative projection triggers even without a reorder policy", () => {
    const r = computeReorderMath({ ...base, onHand: 10, plannedDemand: 25 });
    expect(r).not.toBeNull();
    expect(r!.projected).toBe(-15);
    expect(r!.critical).toBe(true); // negative projection is always critical
    expect(r!.reason).toBe("planned_demand");
  });

  it("planned_demand ranks after every physical shortage", () => {
    expect(REORDER_REASON_RANK.below_reorder).toBeLessThan(REORDER_REASON_RANK.planned_demand);
  });
});

describe("computeReorderMath — reasons + urgency rank", () => {
  it("classifies negative / out-of-stock / below-reorder by on-hand", () => {
    expect(computeReorderMath({ ...base, onHand: -2, reserved: 0, reorderLevel: 10 })!.reason).toBe("negative_stock");
    expect(computeReorderMath({ ...base, onHand: 0, reorderLevel: 10 })!.reason).toBe("out_of_stock");
    expect(computeReorderMath({ ...base, onHand: 4, reorderLevel: 10 })!.reason).toBe("below_reorder");
  });

  it("ranks worst-first", () => {
    expect(REORDER_REASON_RANK.negative_stock).toBeLessThan(REORDER_REASON_RANK.out_of_stock);
    expect(REORDER_REASON_RANK.out_of_stock).toBeLessThan(REORDER_REASON_RANK.below_reorder);
  });
});

describe("computeReorderMath — covered rows", () => {
  it("healthy stock (above reorder) returns null — not even a covered row", () => {
    expect(computeReorderMath({ ...base, onHand: 50, reorderLevel: 20 })).toBeNull();
  });

  it("physically low but fully covered by incoming ⇒ covered row, nothing to buy", () => {
    const r = computeReorderMath({ ...base, onHand: 5, incoming: 40, reorderLevel: 20, maximumStock: 100 });
    expect(r!.covered).toBe(true);
    expect(r!.suggestedQty).toBe(0);
    expect(r!.critical).toBe(false);
  });

  it("still actionable when the pipeline only partly covers the shortfall", () => {
    const r = computeReorderMath({ ...base, onHand: 5, incoming: 10, reorderLevel: 20, maximumStock: 100 });
    expect(r!.covered).toBe(false);
    expect(r!.suggestedQty).toBe(85);
  });
});

describe("computeReorderMath — critical urgency (criticalLevel)", () => {
  it("flags critical when projected is at/below criticalLevel", () => {
    const r = computeReorderMath({ ...base, onHand: 3, reorderLevel: 20, criticalLevel: 5, maximumStock: 100 });
    expect(r!.critical).toBe(true);
  });

  it("below reorder but above critical is NOT critical", () => {
    const r = computeReorderMath({ ...base, onHand: 12, reorderLevel: 20, criticalLevel: 5, maximumStock: 100 });
    expect(r!.critical).toBe(false);
  });

  it("negative projected is always critical, even without a criticalLevel", () => {
    const r = computeReorderMath({ ...base, onHand: 2, reserved: 5, reorderLevel: 10 });
    expect(r!.critical).toBe(true);
  });
});
