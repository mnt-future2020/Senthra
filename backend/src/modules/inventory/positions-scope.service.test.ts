import { beforeEach, describe, expect, it, vi } from "vitest";

// The all-positions CSV must be narrowed to the caller's WAREHOUSE SCOPE. It wasn't: the controller
// never passed an actor, and `assembleAll` scopes only on an explicit `?warehouse=`. This branch is
// what makes it matter — it grants `inventory.export` to the warehouse-manager role, whose comment in
// permissions.ts promises the download is "the same rows the screen already shows them — never the
// company's". A scoped manager calling the route with no filter received every warehouse, every
// engineer's van and every customer's holdings in one file.
//
// The repositories are stubbed so these assert the SCOPE applied to the assembled rows, not database
// behaviour.
const balance = (warehouseId: string, irmItemId: string) => ({
  id: `b-${warehouseId}-${irmItemId}`,
  warehouseId,
  irmItemId,
  quantity: 5,
  reservedQuantity: 0,
  unitCostPence: 100,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  warehouse: { id: warehouseId, name: `WH ${warehouseId}` },
  irmItem: { id: irmItemId, code: `IT-${irmItemId}`, name: `Item ${irmItemId}`, sku: null, category: null, unit: "ea" },
});

vi.mock("./inventory.repository.js", () => ({
  findAllBalancesForAggregation: vi.fn(async () => [balance("wh1", "i1"), balance("wh2", "i2")]),
}));
vi.mock("#modules/engineer/engineer.repository.js", () => ({
  // An engineer's van is not a warehouse the manager holds, so it must not survive scoping.
  findAllBalances: vi.fn(async () => [{
    id: "eb1",
    engineerId: "e1",
    irmItemId: "i3",
    quantity: 2,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    engineer: { firstName: "Sam", lastName: "Vance", email: "sam@x.co" },
    irmItem: { id: "i3", code: "IT-i3", name: "Item i3", sku: null, category: null, unit: "ea" },
  }]),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findAllCustomerHoldings: vi.fn(async () => []),
  findAllDamaged: vi.fn(async () => []),
}));
vi.mock("#modules/customer/customer.repository.js", () => ({
  findActiveStockEntries: vi.fn(async () => []),
}));
vi.mock("#modules/job/job.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({}));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" })),
}));

const { exportAllPositionsCsv } = await import("./aggregation.service.js");

/** A warehouse-scoped staff user — the principal shape requireAuth builds for a scoped role. */
const scopedTo = (ids: string[]) => ({ type: "user", assignedWarehouseIds: ids });
/** Admin / system / any non-warehouse-scoped role. */
const unrestricted = { type: "user", assignedWarehouseIds: null };

beforeEach(() => vi.clearAllMocks());

describe("exportAllPositionsCsv — warehouse scope", () => {
  it("returns every position when the actor is unrestricted", async () => {
    const { csv, count } = await exportAllPositionsCsv({}, unrestricted as never);
    expect(count).toBe(3); // two warehouses + one engineer van
    expect(csv).toContain("WH wh1");
    expect(csv).toContain("WH wh2");
  });

  it("keeps only the warehouses a scoped actor holds", async () => {
    const { csv, count } = await exportAllPositionsCsv({}, scopedTo(["wh1"]) as never);
    expect(count).toBe(1);
    expect(csv).toContain("WH wh1");
    expect(csv).not.toContain("WH wh2");
  });

  it("drops positions that are not in a warehouse at all", async () => {
    // Engineer vans, customer sites and transit are not the manager's warehouses. Dropping them is
    // deliberate: defaulting to "include" for anything unrecognised is what produced the leak.
    const { csv } = await exportAllPositionsCsv({}, scopedTo(["wh1", "wh2"]) as never);
    expect(csv).not.toContain("Sam Vance");
  });

  it("yields nothing for a scoped actor with no assignments", async () => {
    const { count } = await exportAllPositionsCsv({}, scopedTo([]) as never);
    expect(count).toBe(0);
  });

  it("still applies scope when an explicit warehouse filter names another warehouse", async () => {
    // The filter narrows; it must never widen. A scoped manager asking for wh2 gets nothing, not wh2.
    const { count } = await exportAllPositionsCsv({ warehouseId: "wh2" }, scopedTo(["wh1"]) as never);
    expect(count).toBe(0);
  });
});
