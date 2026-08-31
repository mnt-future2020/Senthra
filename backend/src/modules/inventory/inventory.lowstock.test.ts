import { beforeEach, describe, expect, it, vi } from "vitest";

// lowStockCounts counts STOCK POSITIONS — one row per item × warehouse — through the same
// `positionStatus` rule the Inventory Hub's table renders, so the Overview's "Low Stock" card and
// the `?status=below_reorder` list it opens are one set of rows. Mock lib/prisma so importing the
// repository never builds a real client, and drive the single findMany the count now makes.
const balanceFindMany = vi.fn();
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    inventoryBalance: { findMany: (...a: unknown[]) => balanceFindMany(...a) },
  },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { lowStockCounts } from "./inventory.repository.js";

/** A balance row in the shape the repository selects it. */
const bal = (quantityOnHand: number, reorderLevel: number | null = 5, criticalLevel: number | null = 2) => ({
  quantityOnHand,
  irmItem: { reorderLevel, criticalLevel },
});

beforeEach(() => {
  balanceFindMany.mockReset();
});

describe("lowStockCounts — the rule", () => {
  it("counts a row at or below its reorder level, and one at zero as the most severe case of it", async () => {
    balanceFindMany.mockResolvedValue([bal(5), bal(3), bal(0)]);
    const r = await lowStockCounts(undefined);
    expect(r.count).toBe(3);
  });

  it("leaves a healthy row alone — strictly above the level is in stock", async () => {
    balanceFindMany.mockResolvedValue([bal(6), bal(20)]);
    expect(await lowStockCounts(undefined)).toEqual({ count: 0, criticalCount: 0 });
  });

  // The boundary the whole card turns on, and the one `positionStatus` defines: at the level is low.
  it("treats exactly-at-the-level as low, not as in stock", async () => {
    balanceFindMany.mockResolvedValue([bal(5)]);
    expect((await lowStockCounts(undefined)).count).toBe(1);
  });

  it("counts an empty row with NO reorder level — out of stock needs no threshold", async () => {
    balanceFindMany.mockResolvedValue([bal(0, null, null)]);
    expect((await lowStockCounts(undefined)).count).toBe(1);
  });

  // The other half of that: without a level, stock on the shelf cannot be "low".
  it("never calls a stocked row with no reorder level low", async () => {
    balanceFindMany.mockResolvedValue([bal(1, null, null)]);
    expect((await lowStockCounts(undefined)).count).toBe(0);
  });

  it("counts one row per item × warehouse, so two depots each short count twice", async () => {
    // The regression the old item-summing version hid: 4 + 4 netted to 8 > 5 and reported nothing,
    // while the Reorder workbench — which reads reorderLevel per warehouse — flagged both rows.
    balanceFindMany.mockResolvedValue([bal(4), bal(4)]);
    expect((await lowStockCounts(undefined)).count).toBe(2);
  });

  it("returns zeroes when nothing is stocked at all", async () => {
    balanceFindMany.mockResolvedValue([]);
    expect(await lowStockCounts(["W1"])).toEqual({ count: 0, criticalCount: 0 });
  });
});

describe("lowStockCounts — critical", () => {
  it("counts rows at or below the critical level", async () => {
    balanceFindMany.mockResolvedValue([bal(2), bal(1), bal(3)]);
    const r = await lowStockCounts(undefined);
    expect(r.criticalCount).toBe(2);
    // Critical is a strict subset of low, never work on top of it.
    expect(r.count).toBe(3);
  });

  // Guarded deliberately: without it every empty shelf in the catalogue would read as critical, and
  // the card's red half would be dominated by items nobody set a critical level for.
  it("never calls a row critical when the item has no critical level set", async () => {
    balanceFindMany.mockResolvedValue([bal(0, 5, null)]);
    const r = await lowStockCounts(undefined);
    expect(r.count).toBe(1);
    expect(r.criticalCount).toBe(0);
  });
});

describe("lowStockCounts — warehouse scoping", () => {
  it("asks Mongo for only the scoped warehouses' live balances", async () => {
    balanceFindMany.mockResolvedValue([]);
    await lowStockCounts(["W1", "W2"]);
    const where = balanceFindMany.mock.calls[0]![0].where;
    expect(where.warehouse.is.id).toEqual({ in: ["W1", "W2"] });
    expect(where.warehouse.is.deletedAt).toBeNull();
    // The same population the positions list selects from — a deleted item's balance is in neither.
    expect(where.irmItem.is.deletedAt).toBeNull();
  });

  it("puts no warehouse constraint on an unscoped actor", async () => {
    balanceFindMany.mockResolvedValue([]);
    await lowStockCounts(undefined);
    expect(balanceFindMany.mock.calls[0]![0].where.warehouse.is.id).toBeUndefined();
  });

  // The defect that made the old count unopenable: an item the company has simply never stocked has
  // no balance row, so no list can show it — and it must not be counted as low either.
  it("does not invent rows for catalogue items that are stocked nowhere", async () => {
    balanceFindMany.mockResolvedValue([bal(20)]);
    expect((await lowStockCounts(undefined)).count).toBe(0);
  });
});
