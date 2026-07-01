import { describe, expect, it } from "vitest";

import { reachabilityWarnings } from "./roleReachability";

const labels = (perms: string[]) => reachabilityWarnings(perms).map((w) => w.label).sort();

describe("reachabilityWarnings", () => {
  it("warns when Goods Management is granted without a host module", () => {
    expect(labels(["goods_management.issue"])).toEqual(["Goods Management"]);
  });

  it("is satisfied by either host for Goods Management (warehouse OR inventory view)", () => {
    expect(reachabilityWarnings(["goods_management.issue", "warehouse.view"])).toEqual([]);
    expect(reachabilityWarnings(["goods_management.reconcile", "inventory.view"])).toEqual([]);
  });

  it("warns for each master-data Types/Categories group missing its host", () => {
    expect(labels(["warehouse_types.view"])).toEqual(["Warehouse Types"]);
    expect(labels(["supplier_types.edit"])).toEqual(["Supplier Types"]);
    expect(labels(["irm_types.view"])).toEqual(["IRM Types"]);
    expect(labels(["irm_categories.view"])).toEqual(["IRM Categories"]);
  });

  it("clears the warning once the host View is granted", () => {
    expect(reachabilityWarnings(["warehouse_types.view", "warehouse.view"])).toEqual([]);
    expect(reachabilityWarnings(["supplier_types.view", "suppliers.view"])).toEqual([]);
    expect(reachabilityWarnings(["irm_types.view", "inventory.view"])).toEqual([]);
  });

  it("reports several unreachable groups at once", () => {
    expect(labels(["warehouse_types.view", "goods_management.issue", "irm_types.view"])).toEqual([
      "Goods Management",
      "IRM Types",
      "Warehouse Types",
    ]);
  });

  it("full access (*) can reach everything — never warns", () => {
    expect(reachabilityWarnings(["*"])).toEqual([]);
  });

  it("does not warn about groups that aren't granted", () => {
    expect(reachabilityWarnings(["users.view", "warehouse.view"])).toEqual([]);
    expect(reachabilityWarnings([])).toEqual([]);
  });

  it("does not confuse the goods_management prefix with warehouse (goods_in is unrelated)", () => {
    // goods_in has its own sidebar entry (GRN) — it must not trip the goods_management rule.
    expect(reachabilityWarnings(["goods_in.view"])).toEqual([]);
  });
});
