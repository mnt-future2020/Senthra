import { describe, expect, it } from "vitest";

import { INVENTORY_TAB_PERMS, stockPoolAccess, type StockPool } from "./stockPools";

// The warehouse Inventory tab (#8, #9): each pool is gated on the read its OWN pane makes, and the tab is
// offered only when at least one pool is. Checked against the keys the seeded roles really hold (the
// backend permission-alignment test pins the same premises against db/seed.ts).

const can = (perms: string[]) => (p: string) => perms.includes(p);
const open = (perms: string[]) =>
  (Object.entries(stockPoolAccess(can(perms))) as [StockPool, boolean][]).filter(([, ok]) => ok).map(([k]) => k).sort();
const tabShown = (perms: string[]) => INVENTORY_TAB_PERMS.some(can(perms));

// Finance Director: warehouse.view + rentals.view — no inventory.view, no stock_requests.view.
const FD = ["warehouse.view", "rentals.view"];
// Project Manager: inventory.view, stock_requests.view (customer-compat backfill), rentals.view — no goods_management.view.
const PM = ["warehouse.view", "inventory.view", "stock_requests.view", "rentals.view"];
// Warehouse Manager: all four.
const WM = ["warehouse.view", "inventory.view", "stock_requests.view", "goods_management.view", "rentals.view"];

describe("stockPoolAccess", () => {
  it("#8 the Finance Director no longer lands on a customer pool that answers 403 — only the hire pool is theirs", () => {
    expect(open(FD)).toEqual(["rental"]);
    expect(tabShown(FD)).toBe(true);
  });

  it("#9 the Project Manager is not offered the damaged pool (goods_management.view)", () => {
    expect(open(PM)).toEqual(["customer", "irm", "rental"]);
  });

  it("the Warehouse Manager keeps every pool", () => {
    expect(open(WM)).toEqual(["customer", "damaged", "irm", "rental"]);
  });

  it("a viewer who can open no pool is not offered the tab at all", () => {
    expect(open(["warehouse.view"])).toEqual([]);
    expect(tabShown(["warehouse.view"])).toBe(false);
  });

  it("the tab's gate admits every permission a pool is gated on — no pool can be unreachable", () => {
    for (const key of ["inventory.view", "stock_requests.view", "goods_management.view", "rentals.view"]) {
      expect(open([key]).length, key).toBe(1);
      expect(INVENTORY_TAB_PERMS).toContain(key);
    }
  });
});
