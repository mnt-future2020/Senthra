import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock data-access + the goods-out held-stock counter + audit, so these
// are pure unit tests of the deactivation guard (no DB).
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));
vi.mock("./user-warehouse.repository.js", () => ({
  listForUser: vi.fn().mockResolvedValue([]),
  listWarehouseIds: vi.fn().mockResolvedValue([]),
  syncAssignments: vi.fn().mockResolvedValue({ added: [], removed: [] }),
  clearForUser: vi.fn(),
}));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findActiveByIds: vi.fn() }));
vi.mock("#modules/role/role.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/goods-out/goods-out.repository.js", () => ({ countEngineerHeldStock: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as userRepo from "./user.repository.js";
import * as userWarehouseRepo from "./user-warehouse.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { setUserStatus, updateUser } from "./user.service.js";

const USER_ID = "a".repeat(24);

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: "Karthik",
    lastName: "R",
    email: "karthik@x.com",
    phone: null,
    status: "active",
    profileImageUrl: null,
    notes: null,
    mustResetPassword: false,
    role: { id: "r".repeat(24), key: "field_engineer", name: "Field Engineer" },
    roleId: "r".repeat(24),
    employeeId: "SNT-0007",
    jobTitle: "Field Engineer",
    department: "Operations",
    dateOfJoining: null,
    gender: null,
    dateOfBirth: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    passwordHash: "x",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = userRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = userRepo.update as ReturnType<typeof vi.fn>;
const mockHeld = goodsOutRepo.countEngineerHeldStock as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const mockRoleFindById = roleRepo.findById as ReturnType<typeof vi.fn>;
const mockFindActiveByIds = warehouseRepo.findActiveByIds as ReturnType<typeof vi.fn>;
const mockSync = userWarehouseRepo.syncAssignments as ReturnType<typeof vi.fn>;
const mockListWhIds = userWarehouseRepo.listWarehouseIds as ReturnType<typeof vi.fn>;
const mockClearForUser = userWarehouseRepo.clearForUser as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

const WH_1 = "1".repeat(24);
const WH_2 = "2".repeat(24);
const scopedRole = { id: "w".repeat(24), key: "warehouse_manager", name: "Warehouse Manager", permissions: [], isWarehouseScoped: true };
const plainRole = { id: "p".repeat(24), key: "project_manager", name: "Project Manager", permissions: [], isWarehouseScoped: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(userRow(data)));
  mockHeld.mockResolvedValue(0);
  (userWarehouseRepo.listForUser as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  mockListWhIds.mockResolvedValue([]);
  mockSync.mockResolvedValue({ added: [], removed: [] });
});

describe("setUserStatus — held-stock deactivation guard", () => {
  it("blocks deactivation when the user still holds field stock", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(2);
    await expect(setUserStatus(USER_ID, "inactive")).rejects.toThrow(/still holds stock/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks suspension when the user still holds field stock", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(1);
    await expect(setUserStatus(USER_ID, "suspended")).rejects.toThrow(/still holds stock/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows deactivation when the user holds no stock", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(0);
    const r = await setUserStatus(USER_ID, "inactive");
    expect(r.status).toBe("inactive");
    expect(mockUpdate).toHaveBeenCalledWith(USER_ID, { status: "inactive" });
    expect(auditActions()).toContain("user.status.inactive");
  });

  it("does not run the guard when reactivating (→ active)", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "inactive" }));
    await setUserStatus(USER_ID, "active");
    expect(mockHeld).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(USER_ID, { status: "active" });
  });
});

describe("updateUser — held-stock deactivation guard", () => {
  it("blocks a status change to inactive while the user holds stock", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(3);
    await expect(updateUser(USER_ID, { status: "inactive" })).rejects.toThrow(/still holds stock/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows a status change to inactive when the user holds no stock", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(0);
    const r = await updateUser(USER_ID, { status: "inactive" });
    expect(r.status).toBe("inactive");
  });
});

describe("updateUser — warehouse assignments (warehouse-scoped role)", () => {
  beforeEach(() => {
    // Current user is already a Warehouse Manager (scoped).
    mockFindById.mockResolvedValue(userRow({ role: scopedRole, roleId: scopedRole.id }));
  });

  it("syncs the chosen warehouses and audits the change when all are active", async () => {
    mockRoleFindById.mockResolvedValue(scopedRole);
    mockFindActiveByIds.mockResolvedValue([{ id: WH_1 }, { id: WH_2 }]);
    mockSync.mockResolvedValue({ added: [WH_1, WH_2], removed: [] });

    await updateUser(USER_ID, { roleId: scopedRole.id, warehouseIds: [WH_1, WH_2] });

    expect(mockSync).toHaveBeenCalledWith(USER_ID, [WH_1, WH_2], null);
    expect(auditActions()).toContain("user.warehouse_assigned");
  });

  it("rejects a warehouse-scoped user with no warehouses", async () => {
    mockRoleFindById.mockResolvedValue(scopedRole);
    await expect(
      updateUser(USER_ID, { roleId: scopedRole.id, warehouseIds: [] }),
    ).rejects.toThrow(/at least one active warehouse/i);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("rejects an inactive / removed / unknown warehouse", async () => {
    mockRoleFindById.mockResolvedValue(scopedRole);
    // Only one of the two requested ids comes back active.
    mockFindActiveByIds.mockResolvedValue([{ id: WH_1 }]);
    await expect(
      updateUser(USER_ID, { roleId: scopedRole.id, warehouseIds: [WH_1, WH_2] }),
    ).rejects.toThrow(/invalid, inactive or removed/i);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("dedupes duplicate warehouse ids before validating/syncing", async () => {
    mockRoleFindById.mockResolvedValue(scopedRole);
    mockFindActiveByIds.mockResolvedValue([{ id: WH_1 }]);
    mockSync.mockResolvedValue({ added: [WH_1], removed: [] });

    await updateUser(USER_ID, { roleId: scopedRole.id, warehouseIds: [WH_1, WH_1] });

    expect(mockFindActiveByIds).toHaveBeenCalledWith([WH_1]);
    expect(mockSync).toHaveBeenCalledWith(USER_ID, [WH_1], null);
  });

  it("allows an unrelated edit of an already-scoped user with zero assignments (no lockout)", async () => {
    // A scoped user can legitimately reach a zero-assignment state (e.g. all their warehouses were
    // deactivated). An edit that doesn't touch assignments must still succeed so admins can fix or
    // deactivate the user; assignments are left untouched.
    mockListWhIds.mockResolvedValue([]); // no existing assignments
    const r = await updateUser(USER_ID, { phone: "+44 7700 900111" });
    expect(r.phone).toBe("+44 7700 900111");
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("requires existing warehouses when PROMOTING a non-scoped user into a scoped role with no warehouseIds", async () => {
    mockFindById.mockResolvedValue(userRow({ role: plainRole, roleId: plainRole.id })); // currently non-scoped
    mockRoleFindById.mockResolvedValue(scopedRole); // promote to scoped
    mockListWhIds.mockResolvedValue([]); // and no assignments to restore
    await expect(updateUser(USER_ID, { roleId: scopedRole.id })).rejects.toThrow(
      /at least one active warehouse/i,
    );
  });

  it("PRESERVES assignments when the role changes away from scoped (never auto-deletes)", async () => {
    mockRoleFindById.mockResolvedValue(plainRole); // change to a non-scoped role
    await updateUser(USER_ID, { roleId: plainRole.id });
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
  });
});
