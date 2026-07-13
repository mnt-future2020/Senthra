import { beforeEach, describe, expect, it, vi } from "vitest";

// lowStockCounts reads two collections: irmItem (the catalogue) and inventoryBalance (on-hand per
// warehouse). Mock lib/prisma so importing the repository never builds a real client, and drive the
// two findMany calls per test.
const irmFindMany = vi.fn();
const balanceFindMany = vi.fn();
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    irmItem: { findMany: (...a: unknown[]) => irmFindMany(...a) },
    inventoryBalance: { findMany: (...a: unknown[]) => balanceFindMany(...a) },
  },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { lowStockCounts } from "./inventory.repository.js";

// Catalogue: three tracked items, each with a reorder level of 5.
const CATALOGUE = [
  { id: "a", reorderLevel: 5, criticalLevel: 2 },
  { id: "b", reorderLevel: 5, criticalLevel: 2 },
  { id: "c", reorderLevel: 5, criticalLevel: 2 },
];

beforeEach(() => {
  irmFindMany.mockReset();
  balanceFindMany.mockReset();
  irmFindMany.mockResolvedValue(CATALOGUE);
});

describe("lowStockCounts — warehouse scoping", () => {
  it("unscoped: an item with no balance row anywhere is genuinely out-of-stock and counts", async () => {
    // Only item 'a' has a balance (healthy); b and c have none → qty 0 → out-of-stock.
    balanceFindMany.mockResolvedValue([{ irmItemId: "a", quantityOnHand: 20 }]);
    const r = await lowStockCounts(undefined);
    expect(r.count).toBe(2); // b and c
    expect(r.criticalCount).toBe(2);
  });

  it("scoped: items NOT stocked in the scoped warehouse are excluded, not counted as out-of-stock", async () => {
    // In warehouse W1 only item 'a' is stocked, and it is low (qty 3 ≤ reorder 5).
    // b and c have no balance in W1 — they must NOT leak in as "out of stock".
    balanceFindMany.mockResolvedValue([{ irmItemId: "a", quantityOnHand: 3 }]);
    const r = await lowStockCounts(["W1"]);
    expect(r.count).toBe(1); // only 'a'
    expect(r.criticalCount).toBe(0); // 'a' at 3 is above criticalLevel 2
  });

  it("scoped: an item stocked here but at zero still counts as out-of-stock", async () => {
    // A balance row with quantityOnHand 0 means the warehouse handles the item — it is genuinely empty.
    balanceFindMany.mockResolvedValue([{ irmItemId: "a", quantityOnHand: 0 }]);
    const r = await lowStockCounts(["W1"]);
    expect(r.count).toBe(1); // 'a' is out-of-stock in-scope
    expect(r.criticalCount).toBe(1);
  });

  it("returns zeroes when the catalogue is empty", async () => {
    irmFindMany.mockResolvedValue([]);
    const r = await lowStockCounts(["W1"]);
    expect(r).toEqual({ count: 0, criticalCount: 0 });
  });
});
