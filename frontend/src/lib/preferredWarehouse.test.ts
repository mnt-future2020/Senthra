import { describe, expect, it } from "vitest";

import {
  autoSelectedWarehouseId,
  preferenceOutcome,
  preferredWarehouseOptions,
  shouldPrefillAssignment,
  shouldShowPreferredWarehouse,
  type WarehouseOption,
} from "./preferredWarehouse";

const wh = (id: string, name = "London Logistics Hub", code = "WH-0002"): WarehouseOption => ({ id, name, code });
const A = wh("a".repeat(24));
const B = wh("b".repeat(24), "Leeds Depot", "WH-0003");

describe("shouldShowPreferredWarehouse", () => {
  it("hides the field until the warehouse list has loaded", () => {
    expect(shouldShowPreferredWarehouse(false, [A])).toBe(false);
  });
  it("hides the field when there is no selectable warehouse at all — submission is not blocked", () => {
    expect(shouldShowPreferredWarehouse(true, [])).toBe(false);
  });
  it("shows the field once there is something to choose", () => {
    expect(shouldShowPreferredWarehouse(true, [A])).toBe(true);
  });
});

describe("autoSelectedWarehouseId", () => {
  it("auto-selects the ONLY selectable warehouse", () => {
    expect(autoSelectedWarehouseId([A])).toBe(A.id);
  });
  it("selects nothing when there is a real choice — never guess a destination", () => {
    expect(autoSelectedWarehouseId([A, B])).toBe("");
  });
  it("selects nothing when there are no options", () => {
    expect(autoSelectedWarehouseId([])).toBe("");
  });
});

describe("preferredWarehouseOptions", () => {
  it("puts a clearable 'No preference' entry first so a choice can be undone", () => {
    const opts = preferredWarehouseOptions([A]);
    expect(opts[0]).toEqual({ value: "", label: "No preference" });
    expect(opts[1]).toEqual({ value: A.id, label: "London Logistics Hub (WH-0002)" });
  });
  it("offers exactly the warehouses given, in order", () => {
    expect(preferredWarehouseOptions([A, B]).map((o) => o.value)).toEqual(["", A.id, B.id]);
  });
});

describe("shouldPrefillAssignment", () => {
  const untouched = [{ warehouseId: "" }];

  it("pre-fills from a valid, still-active preference on an untouched first row", () => {
    expect(shouldPrefillAssignment(A.id, [A, B], untouched)).toBe(true);
  });
  it("does not pre-fill when there is no preference", () => {
    expect(shouldPrefillAssignment(null, [A], untouched)).toBe(false);
    expect(shouldPrefillAssignment(undefined, [A], untouched)).toBe(false);
  });
  it("does not pre-fill a warehouse that is no longer active (absent from the loaded list)", () => {
    expect(shouldPrefillAssignment(A.id, [B], untouched)).toBe(false);
  });
  it("does not overwrite a warehouse the reviewer already chose", () => {
    expect(shouldPrefillAssignment(A.id, [A, B], [{ warehouseId: B.id }])).toBe(false);
  });
  it("does not touch a split already in progress", () => {
    expect(shouldPrefillAssignment(A.id, [A, B], [{ warehouseId: "" }, { warehouseId: B.id }])).toBe(false);
  });
});

describe("preferenceOutcome", () => {
  const A = "London Logistics Hub";
  const B = "TESTING WARE";

  it("reports nothing when the customer expressed no preference", () => {
    expect(preferenceOutcome(null, [], "pending")).toBeNull();
    expect(preferenceOutcome(undefined, [A], "assigned")).toBeNull();
    // An empty string is "no preference" too, not a warehouse named "".
    expect(preferenceOutcome("", [A], "assigned")).toBeNull();
  });

  it("is PENDING while awaiting review or assignment", () => {
    expect(preferenceOutcome(A, [], "pending")).toBe("pending");
    // Approved but not yet assigned is still genuinely awaiting a destination.
    expect(preferenceOutcome(A, [], "approved")).toBe("pending");
  });

  it("is REJECTED — never 'pending' — for a turned-down submission", () => {
    // The regression: judged on assignments alone a rejected request looks identical to a pending
    // one (both have none), and told the customer their team was still confirming a destination for
    // a request that had already been refused.
    expect(preferenceOutcome(A, [], "rejected")).toBe("rejected");
  });

  it("is HONOURED when the only warehouse used is the preferred one", () => {
    expect(preferenceOutcome(A, [A], "assigned")).toBe("honoured");
  });

  it("is HONOURED when every leg of a split is the preferred warehouse", () => {
    // Two legs at the same warehouse is unusual but not impossible; nothing was overridden.
    expect(preferenceOutcome(A, [A, A], "assigned")).toBe("honoured");
  });

  it("is SPLIT when the preferred warehouse was used alongside another", () => {
    expect(preferenceOutcome(A, [A, B], "assigned")).toBe("split");
    expect(preferenceOutcome(A, [B, A], "partially_received")).toBe("split");
  });

  it("is CHANGED when the preferred warehouse was not used at all", () => {
    expect(preferenceOutcome(A, [B], "assigned")).toBe("changed");
  });

  it("is CHANGED when a multi-warehouse split avoided the preferred one entirely", () => {
    // The real regression this guards: the reviewer overrode the preference AND split it. The
    // customer must be told their choice was not used, not shown two warehouses with no comment.
    expect(preferenceOutcome("test work", [B, A], "partially_received")).toBe("changed");
  });

  it("compares exactly — a different warehouse never counts as the preferred one", () => {
    expect(preferenceOutcome("London", ["London Logistics Hub"], "assigned")).toBe("changed");
  });

  it("reports what ACTUALLY happened when legs exist, whatever the status says", () => {
    // Defensive: rejection is only consulted when nothing was assigned. Real assignments are the
    // truth and must never be hidden behind a status label.
    expect(preferenceOutcome(A, [A], "rejected")).toBe("honoured");
    expect(preferenceOutcome(A, [B], "completed")).toBe("changed");
  });
});
