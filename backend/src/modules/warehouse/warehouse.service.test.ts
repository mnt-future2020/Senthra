import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock the data-access + side-effect modules so these are pure
// unit tests of updateWarehouse's logic (no DB, no network).
vi.mock("./warehouse.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  unsetDefaultExcept: vi.fn(),
  softDelete: vi.fn(),
}));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/warehouse-type/warehouse-type.service.js", () => ({
  requireActiveWarehouseType: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/geocode.js", () => ({ geocodePostcode: vi.fn().mockResolvedValue(null) }));

import * as warehouseRepo from "./warehouse.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseTypeService from "#modules/warehouse-type/warehouse-type.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { deleteWarehouse, updateWarehouse } from "./warehouse.service.js";

const WH_ID = "f".repeat(24);
const ACTIVE_MGR = "a".repeat(24);
const INACTIVE_MGR = "b".repeat(24);
const NEW_ACTIVE_MGR = "c".repeat(24);
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
    managerUserId: null,
    manager: null,
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
const mockUserFindById = userRepo.findById as ReturnType<typeof vi.fn>;
const mockRequireType = warehouseTypeService.requireActiveWarehouseType as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve(whRow(data)),
  );
});

describe("updateWarehouse — manager change handling", () => {
  it("edits other fields when the existing manager is INACTIVE — no error, manager untouched", async () => {
    mockFindById.mockResolvedValue(
      whRow({
        managerUserId: INACTIVE_MGR,
        manager: { id: INACTIVE_MGR, firstName: "Ina", lastName: "Ctive", email: "ina@x.com", status: "inactive", jobTitle: null, role: null },
      }),
    );
    await expect(
      updateWarehouse(WH_ID, { name: "Leeds Depot 2", managerUserId: INACTIVE_MGR }),
    ).resolves.toMatchObject({ name: "Leeds Depot 2" });
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect("managerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
    expect(auditActions()).toContain("warehouse.updated");
  });

  it("changes an inactive manager to a different ACTIVE manager → manager_assigned", async () => {
    mockFindById.mockResolvedValue(whRow({ managerUserId: INACTIVE_MGR }));
    mockUserFindById.mockResolvedValue({ id: NEW_ACTIVE_MGR, status: "active" });
    await expect(updateWarehouse(WH_ID, { managerUserId: NEW_ACTIVE_MGR })).resolves.toBeTruthy();
    expect(mockUpdate.mock.calls[0][1].managerUserId).toBe(NEW_ACTIVE_MGR);
    expect(auditActions()).toContain("warehouse.manager_assigned");
  });

  it("clears the manager via the scalar FK → manager_removed", async () => {
    mockFindById.mockResolvedValue(whRow({ managerUserId: ACTIVE_MGR }));
    await expect(updateWarehouse(WH_ID, { managerUserId: null })).resolves.toBeTruthy();
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][1].managerUserId).toBeNull();
    expect(auditActions()).toContain("warehouse.manager_removed");
  });

  it("edits a warehouse that has NO manager — succeeds, manager untouched", async () => {
    mockFindById.mockResolvedValue(whRow({ managerUserId: null }));
    await expect(updateWarehouse(WH_ID, { name: "Renamed", managerUserId: null })).resolves.toBeTruthy();
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect("managerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
  });

  it("rejects assigning an INACTIVE manager", async () => {
    mockFindById.mockResolvedValue(whRow({ managerUserId: null }));
    mockUserFindById.mockResolvedValue({ id: INACTIVE_MGR, status: "inactive" });
    await expect(updateWarehouse(WH_ID, { managerUserId: INACTIVE_MGR })).rejects.toThrow(
      /not an active user/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
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
