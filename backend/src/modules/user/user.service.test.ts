import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock data-access + the goods-out held-stock counter + audit, so these
// are pure unit tests of the deactivation guard (no DB).
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));
vi.mock("#modules/goods-out/goods-out.repository.js", () => ({ countEngineerHeldStock: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as userRepo from "./user.repository.js";
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
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(userRow(data)));
  mockHeld.mockResolvedValue(0);
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
