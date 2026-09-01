import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// getReorderSummary is the dashboard's entry point into the reorder maths. It exists because the
// full suggestion read is four aggregate queries plus an in-memory pass over every stock-managed
// item × warehouse — far too heavy to run on every dashboard load — so it memoises per warehouse
// scope for a short window. These tests pin the two things that make it safe: the counts it derives,
// and the fact that one scope can never serve another scope's numbers.
vi.mock("./inventory.repository.js", () => ({ findAllBalances: vi.fn() }));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({ incomingByItemWarehouse: vi.fn(async () => new Map()) }));
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({ openQuantitiesByItemWarehouse: vi.fn(async () => new Map()) }));
vi.mock("#modules/goods-management/demand.js", () => ({ getOpenDemand: vi.fn(async () => new Map()) }));
vi.mock("#modules/irm/irm.service.js", () => ({ primarySuppliersForItems: vi.fn(async () => new Map()) }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({}));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/warehouse-access.js", () => ({
  assertWarehouseAccess: vi.fn(),
  // Drive the scope directly off the actor stub so a test can say "this caller sees W1 only".
  warehouseScopeFilter: (actor?: { warehouseIds?: string[] }) => actor?.warehouseIds,
}));

import * as inventoryRepo from "./inventory.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import { getReorderSummary, invalidateReorderSummary } from "./inventory.service.js";

const mockFindAll = inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>;
const mockSuppliers = irmService.primarySuppliersForItems as ReturnType<typeof vi.fn>;

// A balance row shaped the way the reorder read consumes it. Defaults sit BELOW the reorder level so
// a row triggers unless a test says otherwise.
function balance(over: Partial<{ id: string; wh: string; onHand: number; reserved: number; reorderLevel: number; criticalLevel: number }> = {}) {
  const { id = "i1", wh = "W1", onHand = 1, reserved = 0, reorderLevel = 10, criticalLevel = 0 } = over;
  return {
    irmItemId: id,
    warehouseId: wh,
    quantityOnHand: onHand,
    quantityReserved: reserved,
    warehouse: { id: wh, name: `Warehouse ${wh}`, code: wh },
    irmItem: {
      id,
      code: id.toUpperCase(),
      name: `Item ${id}`,
      sku: null,
      baseUnit: "ea",
      status: "active",
      trackInventory: true,
      reorderLevel,
      criticalLevel,
      maximumStock: null,
      packSize: null,
      standardCostPence: 100,
      irmCategory: null,
    },
  };
}

beforeEach(() => {
  invalidateReorderSummary();
  mockFindAll.mockReset();
  mockSuppliers.mockReset();
  mockSuppliers.mockResolvedValue(new Map());
  mockFindAll.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getReorderSummary — derived counts", () => {
  it("counts actionable rows, criticals, and rows with no usable supplier", async () => {
    mockFindAll.mockResolvedValue([
      balance({ id: "i1", onHand: 1, criticalLevel: 5 }), // triggers, critical (projected 1 ≤ 5)
      balance({ id: "i2", onHand: 8 }), // triggers, not critical
      balance({ id: "i3", onHand: 50 }), // healthy — never surfaces
    ]);
    // i1 has an active primary supplier; i2 has none → one supplier gap.
    mockSuppliers.mockResolvedValue(new Map([["i1", { id: "s1", name: "Acme", status: "active", leadTimeDays: 7 }]]));

    expect(await getReorderSummary()).toEqual({ count: 2, criticalCount: 1, supplierGaps: 1 });
  });

  it("counts an INACTIVE primary supplier as a gap — a row you cannot actually order", async () => {
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 1 })]);
    mockSuppliers.mockResolvedValue(new Map([["i1", { id: "s1", name: "Acme", status: "inactive", leadTimeDays: 7 }]]));

    expect(await getReorderSummary()).toEqual({ count: 1, criticalCount: 0, supplierGaps: 1 });
  });

  it("returns zeroes when nothing triggers", async () => {
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 500 })]);
    expect(await getReorderSummary()).toEqual({ count: 0, criticalCount: 0, supplierGaps: 0 });
  });

  it("asks the repository for reorder-managed rows only, within the caller's scope", async () => {
    await getReorderSummary({ warehouseIds: ["W1"] } as never);
    expect(mockFindAll).toHaveBeenCalledWith({ warehouseIds: ["W1"], reorderManagedOnly: true });
  });
});

describe("getReorderSummary — memoisation", () => {
  it("serves a repeat call from cache instead of recomputing", async () => {
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 1 })]);

    const first = await getReorderSummary();
    const second = await getReorderSummary();

    expect(second).toEqual(first);
    expect(mockFindAll).toHaveBeenCalledTimes(1); // the whole point: one computation, not two
  });

  it("recomputes once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 1 })]);

    await getReorderSummary();
    vi.advanceTimersByTime(31_000); // past the 30s window
    await getReorderSummary();

    expect(mockFindAll).toHaveBeenCalledTimes(2);
  });

  it("never serves one warehouse scope's numbers to another", async () => {
    // Two callers with DIFFERENT assignments must each get their own computation — a shared cache
    // entry here would leak counts across a warehouse boundary.
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 1 })]);

    await getReorderSummary({ warehouseIds: ["W1"] } as never);
    await getReorderSummary({ warehouseIds: ["W2"] } as never);
    expect(mockFindAll).toHaveBeenCalledTimes(2);

    // ...but the SAME scope (order-insensitive) reuses the entry.
    await getReorderSummary({ warehouseIds: ["W2", "W1"] } as never);
    await getReorderSummary({ warehouseIds: ["W1", "W2"] } as never);
    expect(mockFindAll).toHaveBeenCalledTimes(3);
  });

  it("keeps an unrestricted caller separate from a scoped one", async () => {
    mockFindAll.mockResolvedValue([balance({ id: "i1", onHand: 1 })]);

    await getReorderSummary(); // unrestricted
    await getReorderSummary({ warehouseIds: ["W1"] } as never);

    expect(mockFindAll).toHaveBeenCalledTimes(2);
  });
});
