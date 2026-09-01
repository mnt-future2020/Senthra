import { beforeEach, describe, expect, it, vi } from "vitest";

// The Inventory Hub's position reads are the app's widest stock surface, and the LIST endpoint used
// to apply no warehouse scope at all while the CSV export of the same data did. These tests pin the
// rule that closed it: permission scope FIRST, then the user's filters — a filter may only ever
// narrow what authorization already allows.

vi.mock("./inventory.repository.js", () => ({ findAllBalancesForAggregation: vi.fn(async () => []) }));
vi.mock("#modules/engineer/engineer.repository.js", () => ({
  findAllBalances: vi.fn(async () => []),
  findEngineers: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findAllCustomerHoldings: vi.fn(async () => []),
  findAllDamaged: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({
  getOverdueSummary: vi.fn(async () => ({ count: 0, days: 14 })),
}));
vi.mock("#modules/customer/customer.repository.js", () => ({ findActiveStockEntries: vi.fn(async () => []) }));
vi.mock("#modules/job/job.repository.js", () => ({ countActiveJobsByEngineer: vi.fn(async () => new Map()) }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "dd/MM/yyyy" })),
}));
vi.mock("#modules/document/document.formatter.js", () => ({ formatDateTime: () => "" }));

import * as inventoryRepo from "./inventory.repository.js";
import { listStockPositions, exportAllPositionsCsv } from "./aggregation.service.js";

// Two warehouses' worth of company stock. The scoped actor is assigned to ONE of them.
const balance = (warehouseId: string, itemName: string) => ({
  id: `bal-${warehouseId}`,
  irmItemId: `item-${itemName}`,
  warehouseId,
  quantityOnHand: 5,
  updatedAt: new Date("2026-08-31T09:00:00.000Z"),
  irmItem: { id: `item-${itemName}`, name: itemName, sku: itemName, standardCostPence: 100, reorderLevel: 0, category: { name: "Cable" } },
  warehouse: { id: warehouseId, name: warehouseId, code: warehouseId },
});

// A warehouse-SCOPED staff principal is exactly `type: "user"` with a populated assignedWarehouseIds
// (requireAuth sets it to an array only for a warehouse-scoped role). Everyone else is unrestricted.
const SCOPED = { type: "user", id: "u1", assignedWarehouseIds: ["wh-london"] } as never;
const UNRESTRICTED = { type: "user", id: "admin", assignedWarehouseIds: null } as never;

beforeEach(() => {
  vi.mocked(inventoryRepo.findAllBalancesForAggregation).mockResolvedValue([
    balance("wh-london", "Fibre"),
    balance("wh-leeds", "Duct"),
  ] as never);
});

describe("GET /inventory/positions applies the actor's warehouse scope", () => {
  it("hides another warehouse's positions from a scoped user", async () => {
    const res = await listStockPositions({}, SCOPED);
    expect(res.positions.map((p) => p.locationId)).toEqual(["wh-london"]);
    // `total` counts the SCOPED set, so the pager can never walk into rows the user cannot see.
    expect(res.total).toBe(1);
  });

  it("does not let a warehouse FILTER reach outside the scope", async () => {
    // Asking explicitly for the warehouse they are not assigned to must return nothing, not that
    // warehouse's rows. This is the case the filter made trivially reachable.
    const res = await listStockPositions({ warehouseId: "wh-leeds" }, SCOPED);
    expect(res.positions).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("leaves an unrestricted actor unaffected", async () => {
    const res = await listStockPositions({}, UNRESTRICTED);
    expect(res.positions).toHaveLength(2);
  });

  it("scopes an anonymous/actorless read the same way it always did", async () => {
    const res = await listStockPositions({});
    expect(res.positions).toHaveLength(2);
  });

  it("the LIST and the CSV EXPORT now agree on what the actor may see", async () => {
    const list = await listStockPositions({}, SCOPED);
    const { csv } = await exportAllPositionsCsv({}, SCOPED);
    // One data row in the export, matching the one row in the list — the two used to disagree.
    const dataRows = csv.trim().split("\n").slice(1);
    expect(dataRows).toHaveLength(list.positions.length);
    expect(csv).toContain("Fibre");
    expect(csv).not.toContain("Duct");
  });
});
