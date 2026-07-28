import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock the data-access + side-effect modules so these are pure
// unit tests of updateWarehouse's logic (no DB, no network).
vi.mock("./warehouse.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  unsetDefaultExcept: vi.fn(),
  softDelete: vi.fn(),
}));
vi.mock("#modules/user/user-warehouse.repository.js", () => ({
  listManagersForWarehouses: vi.fn().mockResolvedValue([]),
}));
vi.mock("#modules/warehouse-type/warehouse-type.service.js", () => ({
  requireActiveWarehouseType: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/geocode.js", () => ({ geocodePostcode: vi.fn().mockResolvedValue(null) }));
// Delete-dependency checkers — isolate them (no real Prisma). Each defaults to 0 (deletable);
// a test that needs an in-use warehouse overrides the relevant mock.
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({ countByWarehouse: vi.fn().mockResolvedValue(0) }));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ countByWarehouse: vi.fn().mockResolvedValue(0) }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({ countByWarehouse: vi.fn().mockResolvedValue(0) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ countBalancesWithStockByWarehouse: vi.fn().mockResolvedValue(0) }));

import * as warehouseRepo from "./warehouse.repository.js";
import * as userWarehouseRepo from "#modules/user/user-warehouse.repository.js";
import * as warehouseTypeService from "#modules/warehouse-type/warehouse-type.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { deleteWarehouse, updateWarehouse } from "./warehouse.service.js";

const WH_ID = "f".repeat(24);
const MGR_ID = "a".repeat(24);
const TYPE_ID = "d".repeat(24);
const NEW_TYPE_ID = "e".repeat(24);

function whRow(over: Record<string, unknown> = {}) {
  return {
    id: WH_ID,
    code: "WH-0001",
    name: "Leeds Depot",
    description: null,
    typeId: TYPE_ID,
    warehouseType: { id: TYPE_ID, name: "Main Depot" },
    isDefault: false,
    addressLine1: null,
    addressLine2: null,
    city: null,
    county: null,
    postcode: null,
    country: "United Kingdom",
    latitude: null,
    longitude: null,
    contactPerson: null,
    contactEmail: null,
    contactPhone: null,
    operatingHours: null,
    timezone: "Europe/London",
    notes: null,
    status: "active",
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = warehouseRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = warehouseRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = warehouseRepo.softDelete as ReturnType<typeof vi.fn>;
const mockListManagers = userWarehouseRepo.listManagersForWarehouses as ReturnType<typeof vi.fn>;
const mockRequireType = warehouseTypeService.requireActiveWarehouseType as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockListManagers.mockResolvedValue([]);
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve(whRow(data)),
  );
});

// Managers are DERIVED from the Users & Roles warehouse assignments — a warehouse has no manager
// column and the warehouse form can never write one.
describe("updateWarehouse — derived managers", () => {
  it("surfaces the assigned staff as the warehouse's managers", async () => {
    mockFindById.mockResolvedValue(whRow());
    mockListManagers.mockResolvedValue([
      {
        warehouseId: WH_ID,
        user: {
          id: MGR_ID,
          firstName: "Ada",
          lastName: "Keys",
          email: "ada@x.com",
          phone: "0113 496 0000",
          jobTitle: null,
          profileImageUrl: null,
          role: { name: "Warehouse Manager" },
        },
      },
    ]);
    const updated = await updateWarehouse(WH_ID, { name: "Leeds Depot 2" });
    expect(mockListManagers).toHaveBeenCalledWith([WH_ID]);
    // Falls back to the role name when the user has no jobTitle, and carries the name parts +
    // image the avatar chip needs.
    expect(updated.managers).toEqual([
      {
        id: MGR_ID,
        name: "Ada Keys",
        firstName: "Ada",
        lastName: "Keys",
        email: "ada@x.com",
        phone: "0113 496 0000",
        jobTitle: "Warehouse Manager",
        profileImageUrl: null,
      },
    ]);
  });

  it("reports no managers when nobody is assigned — never an error", async () => {
    mockFindById.mockResolvedValue(whRow());
    await expect(updateWarehouse(WH_ID, { name: "Renamed" })).resolves.toMatchObject({ managers: [] });
  });

  it("ignores a manager id smuggled into the update payload", async () => {
    mockFindById.mockResolvedValue(whRow());
    await updateWarehouse(WH_ID, { name: "Renamed", managerUserId: MGR_ID } as never);
    expect("managerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
    expect(auditActions()).not.toContain("warehouse.manager_assigned");
  });
});

describe("updateWarehouse — status / default / type", () => {
  it("blocks deactivating the DEFAULT warehouse", async () => {
    mockFindById.mockResolvedValue(whRow({ isDefault: true, status: "active" }));
    await expect(updateWarehouse(WH_ID, { status: "inactive" })).rejects.toThrow(
      /select another default warehouse first/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows deactivating the default warehouse when also clearing default", async () => {
    mockFindById.mockResolvedValue(whRow({ isDefault: true, status: "active" }));
    await expect(updateWarehouse(WH_ID, { status: "inactive", isDefault: false })).resolves.toBeTruthy();
    expect(auditActions()).toContain("warehouse.deactivated");
  });

  it("records activated / deactivated on a status transition", async () => {
    mockFindById.mockResolvedValue(whRow({ status: "active", isDefault: false }));
    await updateWarehouse(WH_ID, { status: "inactive" });
    expect(auditActions()).toContain("warehouse.deactivated");
    expect(auditActions()).not.toContain("warehouse.updated"); // pure status change
  });

  it("records default_changed and demotes others when set as default", async () => {
    mockFindById.mockResolvedValue(whRow({ isDefault: false }));
    await updateWarehouse(WH_ID, { isDefault: true });
    expect(auditActions()).toContain("warehouse.default_changed");
    expect(warehouseRepo.unsetDefaultExcept).toHaveBeenCalled();
  });

  it("validates the type only when it changes", async () => {
    mockFindById.mockResolvedValue(whRow({ typeId: TYPE_ID }));
    // same type → no validation
    await updateWarehouse(WH_ID, { typeId: TYPE_ID });
    expect(mockRequireType).not.toHaveBeenCalled();
    // different type → validated + written
    await updateWarehouse(WH_ID, { typeId: NEW_TYPE_ID });
    expect(mockRequireType).toHaveBeenCalledWith(NEW_TYPE_ID);
    expect(mockUpdate.mock.calls.at(-1)?.[1].typeId).toBe(NEW_TYPE_ID);
  });
});

describe("deleteWarehouse — default protection", () => {
  it("blocks deleting the DEFAULT warehouse (mirrors the deactivate guard)", async () => {
    mockFindById.mockResolvedValue(whRow({ isDefault: true }));
    await expect(deleteWarehouse(WH_ID)).rejects.toThrow(
      /select another default warehouse before deleting/i,
    );
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a NON-default warehouse and records warehouse.deleted", async () => {
    mockFindById.mockResolvedValue(whRow({ isDefault: false }));
    await expect(deleteWarehouse(WH_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(WH_ID);
    expect(auditActions()).toContain("warehouse.deleted");
  });

  it("throws not found when the warehouse does not exist", async () => {
    mockFindById.mockResolvedValue(null);
    await expect(deleteWarehouse(WH_ID)).rejects.toThrow(/not found/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});
