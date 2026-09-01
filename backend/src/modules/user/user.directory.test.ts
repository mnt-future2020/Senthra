import { beforeEach, describe, expect, it, vi } from "vitest";

// The staff LIST endpoint must never carry the personnel record. These are pure unit tests of the
// projection, so the repository is mocked and no DB is involved.
vi.mock("./user.repository.js", () => ({
  count: vi.fn(),
  findMany: vi.fn(),
  findById: vi.fn(),
  findByEmployeeIdWithRole: vi.fn(),
}));
vi.mock("./user-warehouse.repository.js", () => ({
  listForUser: vi.fn().mockResolvedValue([]),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn().mockResolvedValue({
    dateFormat: "DD/MM/YYYY",
    timeFormat: "24h",
    timezone: "Europe/London",
  }),
}));

import * as userRepo from "./user.repository.js";
import { exportUsersCsv, getUser, listUsers } from "./user.service.js";

const USER_ID = "a".repeat(24);
const ROLE_ID = "r".repeat(24);

/**
 * A FULL user row as Prisma returns it — every personal column populated, so a field that leaks
 * into the directory shows up as real data rather than as an undefined that happens to look absent.
 */
function fullRow(over: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: "Karthik",
    lastName: "R",
    email: "karthik@example.com",
    phone: "07700900123",
    roleId: ROLE_ID,
    role: {
      id: ROLE_ID,
      key: "field_engineer",
      name: "Field Engineer",
      description: "Field ops",
      permissions: ["engineer.jobs.view"],
      isSystem: true,
      sortOrder: 5,
      isWarehouseScoped: false,
      canHoldStock: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    status: "active",
    profileImageUrl: "https://res.cloudinary.com/demo/image/upload/avatar.png",
    profileImagePublicId: "senthra/users/avatar",
    profileImageResourceType: "image",
    notes: "Off sick March–April; disciplinary on file.",
    signatureUrl: "https://res.cloudinary.com/demo/image/upload/signature-x.png",
    signatureName: "signature.png",
    signatureMimeType: "image/png",
    signatureFileSize: 4096,
    signatureUploadedAt: new Date("2026-02-01T00:00:00.000Z"),
    signatureUpdatedAt: new Date("2026-02-01T00:00:00.000Z"),
    employeeId: "SNT-0007",
    jobTitle: "Field Engineer",
    department: "Operations",
    dateOfJoining: new Date("2026-03-01T00:00:00.000Z"),
    gender: "male",
    dateOfBirth: new Date("1990-06-15T00:00:00.000Z"),
    addressLine1: "12 Example Street",
    addressLine2: "Flat 3",
    city: "London",
    postcode: "EC1A 1BB",
    passwordHash: "$2a$12$hash",
    mustResetPassword: false,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    deletedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    ...over,
  };
}

/**
 * Every column that is personnel data rather than directory data. A regression here means the list
 * endpoint started handing someone's date of birth / home address / sickness notes to every account
 * holding `users.view`.
 */
const FORBIDDEN_ON_LIST = [
  "dateOfBirth",
  "gender",
  "addressLine1",
  "addressLine2",
  "city",
  "postcode",
  "notes",
  "phone",
  "jobTitle",
  "department",
  "dateOfJoining",
  "signatureUrl",
  "signatureName",
  "signatureMimeType",
  "signatureFileSize",
  "signatureUploadedAt",
  "signatureUpdatedAt",
  "mustResetPassword",
  "passwordHash",
  "resetTokenHash",
  "resetTokenExpiresAt",
  "profileImagePublicId",
  "profileImageResourceType",
  "deletedAt",
  "warehouses",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userRepo.count).mockResolvedValue(1);
  vi.mocked(userRepo.findMany).mockResolvedValue([fullRow()] as never);
  vi.mocked(userRepo.findById).mockResolvedValue(fullRow() as never);
});

describe("GET /users — directory projection", () => {
  it("omits every personnel field", async () => {
    const { users } = await listUsers();
    expect(users).toHaveLength(1);
    for (const field of FORBIDDEN_ON_LIST) {
      expect(users[0]).not.toHaveProperty(field);
    }
  });

  it("returns exactly the directory keys and nothing more", async () => {
    const { users } = await listUsers();
    expect(Object.keys(users[0]).sort()).toEqual(
      [
        "createdAt",
        "email",
        "employeeId",
        "firstName",
        "id",
        "lastName",
        "profileImageUrl",
        "role",
        "status",
      ].sort(),
    );
  });

  it("still carries what the staff list renders", async () => {
    const { users, total, page, pageSize, totalPages } = await listUsers();
    expect(users[0]).toEqual({
      id: USER_ID,
      firstName: "Karthik",
      lastName: "R",
      email: "karthik@example.com",
      status: "active",
      profileImageUrl: "https://res.cloudinary.com/demo/image/upload/avatar.png",
      role: { id: ROLE_ID, key: "field_engineer", name: "Field Engineer" },
      employeeId: "SNT-0007",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    // Paging envelope unchanged.
    expect({ total, page, pageSize, totalPages }).toEqual({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
  });

  it("carries the role reference only as {id,key,name} — never the permission list", async () => {
    const { users } = await listUsers();
    expect(users[0].role).not.toHaveProperty("permissions");
    expect(users[0].role).not.toHaveProperty("isWarehouseScoped");
  });

  it("keeps a roleless user's null role", async () => {
    vi.mocked(userRepo.findMany).mockResolvedValue([fullRow({ role: null, roleId: null })] as never);
    const { users } = await listUsers();
    expect(users[0].role).toBeNull();
  });

  it("passes the caller's filters, paging and sort straight through to the repository", async () => {
    vi.mocked(userRepo.count).mockResolvedValue(40);
    await listUsers({ search: "kar", status: "active", roleId: ROLE_ID, page: 2, pageSize: 10, sort: "name" });
    // `addedWindow` is empty because no date filter was passed — and it stays EMPTY rather than
    // absent so the count and the page provably describe the same filter object.
    const expected = { search: "kar", status: "active", roleId: ROLE_ID, addedWindow: {} };
    expect(userRepo.count).toHaveBeenCalledWith(expected);
    expect(userRepo.findMany).toHaveBeenCalledWith(
      expected,
      10, // skip = (page 2 - 1) * 10
      10,
      "name",
    );
  });
});

describe("GET /users/:id — the full record is unchanged", () => {
  it("still returns the personnel fields the list drops", async () => {
    const user = await getUser(USER_ID);
    expect(user.dateOfBirth).toBe("1990-06-15T00:00:00.000Z");
    expect(user.gender).toBe("male");
    expect(user.addressLine1).toBe("12 Example Street");
    expect(user.addressLine2).toBe("Flat 3");
    expect(user.city).toBe("London");
    expect(user.postcode).toBe("EC1A 1BB");
    expect(user.notes).toBe("Off sick March–April; disciplinary on file.");
    expect(user.phone).toBe("07700900123");
    expect(user.jobTitle).toBe("Field Engineer");
    expect(user.department).toBe("Operations");
    expect(user.dateOfJoining).toBe("2026-03-01T00:00:00.000Z");
    expect(user.signatureUrl).toBe("https://res.cloudinary.com/demo/image/upload/signature-x.png");
    expect(user.mustResetPassword).toBe(false);
    expect(user.warehouses).toEqual([]);
  });

  it("never returns credential material", async () => {
    const user = await getUser(USER_ID);
    expect(user).not.toHaveProperty("passwordHash");
    expect(user).not.toHaveProperty("resetTokenHash");
  });
});

describe("GET /users/export.csv — output unchanged by the directory narrowing", () => {
  it("still renders the employment columns the directory DTO does not carry", async () => {
    const { csv, capped } = await exportUsersCsv();
    const [header, row] = csv.trim().split(/\r?\n/);
    expect(header).toBe(
      "Employee ID,First Name,Last Name,Email,Phone,Role,Job Title,Department,Status,Joined (Europe/London),Added (Europe/London)",
    );
    expect(row).toBe(
      "SNT-0007,Karthik,R,karthik@example.com,07700900123,Field Engineer,Field Engineer,Operations,active,01/03/2026,01/04/2026",
    );
    expect(capped).toBe(false);
  });

  it("still omits date of birth, gender, home address and notes", async () => {
    const { csv } = await exportUsersCsv();
    expect(csv).not.toContain("1990");
    expect(csv).not.toContain("male");
    expect(csv).not.toContain("Example Street");
    expect(csv).not.toContain("EC1A 1BB");
    expect(csv).not.toContain("disciplinary");
  });

  it("asks the repository for the un-clamped export page, not the 20-row default", async () => {
    await exportUsersCsv();
    const [, , take] = vi.mocked(userRepo.findMany).mock.calls[0];
    expect(take).toBe(50_001);
  });
});
