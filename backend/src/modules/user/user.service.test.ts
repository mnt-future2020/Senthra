import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock data-access + the engineer-stock held-stock counter + audit, so these
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
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ countEngineerHeldStock: vi.fn() }));
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({ countHeldRentalsForEngineer: vi.fn(async () => 0) }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// Sign-in artefact cleanup on delete / deactivate. Mocked so these stay pure unit tests — and so the
// calls themselves are assertable (see the "sign-in artefact cleanup" block below).
vi.mock("#modules/auth/session.service.js", () => ({ endAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#modules/notification/notification.service.js", () => ({
  clearDevicesForUser: vi.fn().mockResolvedValue(0),
}));

import * as userRepo from "./user.repository.js";
import * as userWarehouseRepo from "./user-warehouse.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import * as sessionService from "#modules/auth/session.service.js";
import * as notificationService from "#modules/notification/notification.service.js";
import { deleteUser, setUserStatus, updateUser } from "./user.service.js";

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
const mockHeld = engineerStockRepo.countEngineerHeldStock as ReturnType<typeof vi.fn>;
const mockHeldHires = rentalCustodyRepo.countHeldRentalsForEngineer as ReturnType<typeof vi.fn>;
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

// The schema can only see what a request actually submitted. An edit touching ONE
// date has to be checked against the other half still in the database, or a user
// could be given a birth date that contradicts their stored joining date.
describe("updateUser — date-pair check across a partial patch", () => {
  const BORN = new Date("2000-06-01T00:00:00Z");
  const JOINED = new Date("2016-06-01T00:00:00Z"); // exactly their 16th birthday

  it("rejects a birth date that puts the STORED joining date before age 16", async () => {
    mockFindById.mockResolvedValue(userRow({ dateOfJoining: JOINED, dateOfBirth: BORN }));
    await expect(updateUser(USER_ID, { dateOfBirth: "2005-06-01" })).rejects.toThrow(
      /before this person turned 16/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a joining date that precedes the STORED birth date by less than 16 years", async () => {
    mockFindById.mockResolvedValue(userRow({ dateOfBirth: BORN, dateOfJoining: JOINED }));
    await expect(updateUser(USER_ID, { dateOfJoining: "2015-06-01" })).rejects.toThrow(
      /before this person turned 16/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows a patch that keeps the pair consistent", async () => {
    mockFindById.mockResolvedValue(userRow({ dateOfBirth: BORN, dateOfJoining: JOINED }));
    await expect(updateUser(USER_ID, { dateOfBirth: "1990-01-01" })).resolves.toBeTruthy();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("does not fire when the patch CLEARS the other date", async () => {
    mockFindById.mockResolvedValue(userRow({ dateOfBirth: BORN, dateOfJoining: JOINED }));
    await expect(
      updateUser(USER_ID, { dateOfBirth: "2005-06-01", dateOfJoining: "" }),
    ).resolves.toBeTruthy();
  });

  it("does not fire when the record has no counterpart date stored", async () => {
    mockFindById.mockResolvedValue(userRow({ dateOfBirth: null, dateOfJoining: null }));
    await expect(updateUser(USER_ID, { dateOfBirth: "2005-06-01" })).resolves.toBeTruthy();
  });

  // Deliberate and agreed: the rule is authoritative, so legacy data that already
  // violates it must be corrected rather than quietly carried forward. The cost is
  // that an unrelated edit to such a record surfaces the error.
  it("blocks even an unrelated edit when the STORED pair is already inconsistent", async () => {
    // Legacy data written before this rule existed: joined at 10.
    mockFindById.mockResolvedValue(userRow({ dateOfBirth: BORN, dateOfJoining: new Date("2010-06-01T00:00:00Z") }));
    await expect(updateUser(USER_ID, { firstName: "Renamed" })).rejects.toThrow(
      /before this person turned 16/i,
    );
  });
});

describe("setUserStatus — held-stock deactivation guard", () => {
  // Two independent questions now (van stock, hired kit), so each test starts from a clean answer for
  // the one it is not about.
  beforeEach(() => {
    mockHeld.mockResolvedValue(0);
    mockHeldHires.mockResolvedValue(0);
  });

  // Hired equipment is refused with its OWN message, because the consequence differs in kind:
  // stranded van stock is our asset in a van; stranded hired kit belongs to a provider who keeps
  // billing for it, and it cannot be transferred to a colleague to clear.
  it("blocks deactivation when the user still holds rental items", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeldHires.mockResolvedValue(1);
    await expect(setUserStatus(USER_ID, "inactive")).rejects.toThrow(/still holds rental items/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

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

describe("updateUser — held-stock guard on ROLE REASSIGNMENT", () => {
  // Same hazard as deactivation: every route that could move van stock back refuses a role that
  // can't hold stock, so moving a stock-holding engineer onto a non-field role strands it. This
  // path previously only checked escalation.
  const FIELD_ROLE = { id: "r".repeat(24), key: "field_engineer", name: "Field Engineer", permissions: [], canHoldStock: true };
  const OFFICE_ROLE = { id: "o".repeat(24), key: "helpdesk", name: "Helpdesk", permissions: [], canHoldStock: false };

  it("blocks moving a stock-holding engineer onto a non-field role", async () => {
    mockFindById.mockResolvedValue(userRow({ role: FIELD_ROLE, roleId: FIELD_ROLE.id }));
    mockRoleFindById.mockResolvedValue(OFFICE_ROLE);
    mockHeld.mockResolvedValue(2);
    await expect(updateUser(USER_ID, { roleId: OFFICE_ROLE.id })).rejects.toThrow(
      /still holds field stock/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks clearing the role entirely while the user holds stock", async () => {
    mockFindById.mockResolvedValue(userRow({ role: FIELD_ROLE, roleId: FIELD_ROLE.id }));
    mockHeld.mockResolvedValue(1);
    await expect(updateUser(USER_ID, { roleId: "" })).rejects.toThrow(/still holds field stock/i);
  });

  it("allows the move once the stock is returned", async () => {
    mockFindById.mockResolvedValue(userRow({ role: FIELD_ROLE, roleId: FIELD_ROLE.id }));
    mockRoleFindById.mockResolvedValue(OFFICE_ROLE);
    mockHeld.mockResolvedValue(0);
    await expect(updateUser(USER_ID, { roleId: OFFICE_ROLE.id })).resolves.toBeTruthy();
  });

  it("allows a field role → field role move even while holding stock", async () => {
    const OTHER_FIELD = { ...FIELD_ROLE, id: "f".repeat(24), key: "senior_engineer" };
    mockFindById.mockResolvedValue(userRow({ role: FIELD_ROLE, roleId: FIELD_ROLE.id }));
    mockRoleFindById.mockResolvedValue(OTHER_FIELD);
    mockHeld.mockResolvedValue(5);
    await expect(updateUser(USER_ID, { roleId: OTHER_FIELD.id })).resolves.toBeTruthy();
  });

  it("does not run the check for a user who was never on a field role", async () => {
    mockFindById.mockResolvedValue(userRow({ role: OFFICE_ROLE, roleId: OFFICE_ROLE.id }));
    mockRoleFindById.mockResolvedValue(FIELD_ROLE);
    mockHeld.mockResolvedValue(9);
    await expect(updateUser(USER_ID, { roleId: FIELD_ROLE.id })).resolves.toBeTruthy();
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

// Deleting a stock-holding engineer strands their van stock exactly like deactivating them does:
// every route that could move it back resolves the holder and refuses a deleted one. This was also
// the bypass around the role-capability guard — delete the holder, then revoke the capability and
// the guard sees no live holders and reports safe.
describe("deleteUser — stock guard", () => {
  const mockSoftDelete = userRepo.softDelete as ReturnType<typeof vi.fn>;

  it("refuses to delete a user who still holds field stock", async () => {
    mockFindById.mockResolvedValue(userRow());
    mockHeld.mockResolvedValue(3);

    await expect(deleteUser(USER_ID)).rejects.toThrow(/still holds stock/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(auditActions()).not.toContain("user.deleted");
  });

  it("deletes a user holding nothing", async () => {
    mockFindById.mockResolvedValue(userRow());
    mockHeld.mockResolvedValue(0);

    await deleteUser(USER_ID);
    expect(mockSoftDelete).toHaveBeenCalledWith(USER_ID);
    expect(auditActions()).toContain("user.deleted");
  });
});

/**
 * Sessions and device tokens are cleared once an account can no longer sign in. This is a data-
 * retention change, not an access-control one — requireAuth already refuses a soft-deleted or
 * non-active user — so every test here also asserts the ORIGINAL behaviour is untouched.
 */
describe("deleteUser / setUserStatus — sign-in artefact cleanup", () => {
  const mockEndAll = sessionService.endAll as ReturnType<typeof vi.fn>;
  const mockClearDevices = notificationService.clearDevicesForUser as ReturnType<typeof vi.fn>;

  it("clears sessions and device tokens when a user is deleted", async () => {
    mockFindById.mockResolvedValue(userRow());
    mockHeld.mockResolvedValue(0);

    await deleteUser(USER_ID);
    expect(mockEndAll).toHaveBeenCalledWith(USER_ID, "user");
    expect(mockClearDevices).toHaveBeenCalledWith(USER_ID);
  });

  it("does not clear anything when the delete is refused by the stock guard", async () => {
    mockFindById.mockResolvedValue(userRow());
    mockHeld.mockResolvedValue(4);

    await expect(deleteUser(USER_ID)).rejects.toThrow(/still holds stock/i);
    expect(mockEndAll).not.toHaveBeenCalled();
    expect(mockClearDevices).not.toHaveBeenCalled();
  });

  it("clears them on suspension and on deactivation", async () => {
    for (const next of ["suspended", "inactive"]) {
      vi.clearAllMocks();
      mockFindById.mockResolvedValue(userRow({ status: "active" }));
      mockHeld.mockResolvedValue(0);
      mockUpdate.mockResolvedValue(userRow({ status: next }));

      await setUserStatus(USER_ID, next);
      expect(mockEndAll).toHaveBeenCalledWith(USER_ID, "user");
      expect(mockClearDevices).toHaveBeenCalledWith(USER_ID);
    }
  });

  it("does NOT clear anything when a user is reinstated to active", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "suspended" }));
    mockUpdate.mockResolvedValue(userRow({ status: "active" }));

    await setUserStatus(USER_ID, "active");
    expect(mockEndAll).not.toHaveBeenCalled();
    expect(mockClearDevices).not.toHaveBeenCalled();
  });

  it("still deletes the user when session cleanup fails — the state change is authoritative", async () => {
    mockFindById.mockResolvedValue(userRow());
    mockHeld.mockResolvedValue(0);
    mockEndAll.mockRejectedValueOnce(new Error("mongo down"));

    await expect(deleteUser(USER_ID)).resolves.toBeUndefined();
    expect(mockSoftDeleteRef()).toHaveBeenCalledWith(USER_ID);
    expect(auditActions()).toContain("user.deleted");
    // The other cleanup still runs — one failing must not skip the next.
    expect(mockClearDevices).toHaveBeenCalledWith(USER_ID);
  });

  it("still suspends the user when device-token cleanup fails", async () => {
    mockFindById.mockResolvedValue(userRow({ status: "active" }));
    mockHeld.mockResolvedValue(0);
    mockUpdate.mockResolvedValue(userRow({ status: "suspended" }));
    mockClearDevices.mockRejectedValueOnce(new Error("mongo down"));

    const r = await setUserStatus(USER_ID, "suspended");
    expect(r.status).toBe("suspended");
    expect(auditActions()).toContain("user.status.suspended");
  });
});

const mockSoftDeleteRef = () => userRepo.softDelete as ReturnType<typeof vi.fn>;
