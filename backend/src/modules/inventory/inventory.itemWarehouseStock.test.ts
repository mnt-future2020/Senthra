import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /inventory/items/:irmItemId/warehouse-stock — the job kit picker's, kit-request review's and
// stock-adjust form's "where is this item" read (#26). It replaced the inventory LIST filtered to one
// item, whose rows carry unit cost and stock value; a job planner now reads the quantities and nothing
// else. Same repository stubs as inventory.service.test.
vi.mock("./inventory.repository.js", () => ({
  findAllBalances: vi.fn(),
}));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({ incomingForItemWarehouse: vi.fn() }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({ receivedHistoryForItemWarehouse: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/goods-management/demand.js", () => ({ getOpenDemand: vi.fn() }));

import * as inventoryRepo from "./inventory.repository.js";
import { getOpenDemand } from "#modules/goods-management/demand.js";
import { listItemWarehouseStock } from "./inventory.service.js";

const IRM_ID = "c".repeat(24);
const findAll = inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>;
const openDemand = getOpenDemand as ReturnType<typeof vi.fn>;

function balance(i: number, onHand = 10) {
  return {
    id: `bal${i}`,
    irmItemId: IRM_ID,
    warehouseId: `wh${i}`,
    quantityOnHand: onHand,
    quantityReserved: 0,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    irmItem: {
      id: IRM_ID, code: "IRM-0001", name: "CAT6", sku: null, baseUnit: null, status: "active",
      reorderLevel: null, standardCostPence: 999, currency: "GBP", trackInventory: true, irmCategory: null,
    },
    warehouse: { id: `wh${i}`, code: `WH-${i}`, name: `Warehouse ${i}` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  openDemand.mockResolvedValue(new Map());
});

describe("listItemWarehouseStock", () => {
  it("returns quantities per warehouse — never cost or value", async () => {
    findAll.mockResolvedValue([balance(1, 7)]);
    const [row] = await listItemWarehouseStock(IRM_ID);
    expect(row).toEqual({ warehouseId: "wh1", warehouseName: "Warehouse 1", warehouseCode: "WH-1", onHand: 7, available: 7 });
    expect(Object.keys(row!)).not.toContain("unitCostPence");
    expect(Object.keys(row!)).not.toContain("valuePence");
  });

  it("is limited to one item and scoped to a warehouse-scoped caller", async () => {
    findAll.mockResolvedValue([]);
    await listItemWarehouseStock(IRM_ID, { type: "user", assignedWarehouseIds: ["wh1"] } as never);
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ irmItemId: IRM_ID, warehouseIds: ["wh1"] }));
  });

  it("is unscoped for an unscoped caller", async () => {
    findAll.mockResolvedValue([]);
    await listItemWarehouseStock(IRM_ID, { type: "user", assignedWarehouseIds: null } as never);
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ warehouseIds: undefined }));
  });

  // P4: the pickers asked the list for pageSize 200 and got 100.
  it("returns every stocking warehouse — no page", async () => {
    findAll.mockResolvedValue(Array.from({ length: 130 }, (_, i) => balance(i)));
    expect(await listItemWarehouseStock(IRM_ID)).toHaveLength(130);
  });

  it("rejects a malformed item id", async () => {
    await expect(listItemWarehouseStock("not-an-id")).rejects.toThrow("Select an item.");
    expect(findAll).not.toHaveBeenCalled();
  });
});
