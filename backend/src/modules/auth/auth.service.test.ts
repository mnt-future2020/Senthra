import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the auth service credential-resolution + refresh + logout logic. Everything with a
// side effect or env/crypto dependency is mocked, so these are pure tests of the branching:
// which principal a (email, password) pair resolves to, and how refresh/logout behave. The principal
// mappers (types/principal) run for real so the returned shape is exercised end-to-end.

vi.mock("../../config/env.js", () => ({ env: { nodeEnv: "test" } }));
vi.mock("google-auth-library", () => ({ OAuth2Client: class {} }));
vi.mock("./admin.repository.js", () => ({ findByEmail: vi.fn(), findById: vi.fn(), update: vi.fn() }));
vi.mock("./session.service.js", () => ({
  startSession: vi.fn(),
  findActive: vi.fn(),
  sessionMatchesPrincipal: vi.fn(),
  touch: vi.fn(),
  endSession: vi.fn(),
  endAll: vi.fn(),
  endOthers: vi.fn(),
}));
vi.mock("./email-namespace.js", () => ({ assertEmailNamespaceFree: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findByEmailWithRole: vi.fn(), findById: vi.fn() }));
vi.mock("#modules/customer/customer.repository.js", () => ({ findLoginByEmail: vi.fn(), findLoginById: vi.fn() }));
vi.mock("#modules/settings/settings.repository.js", () => ({ getSettings: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock("../../utils/password.js", () => ({ hashPassword: vi.fn(), verifyPassword: vi.fn() }));
vi.mock("../../utils/jwt.js", () => ({
  signAccessToken: vi.fn(() => "access-token"),
  signRefreshToken: vi.fn(() => "refresh-token"),
  verifyRefreshToken: vi.fn(),
}));

import * as adminRepo from "./admin.repository.js";
import * as sessionService from "./session.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { verifyPassword } from "../../utils/password.js";
import { verifyRefreshToken } from "../../utils/jwt.js";
import { changeCredentials, login, refreshSession, logout } from "./auth.service.js";

const mockVerifyPassword = verifyPassword as ReturnType<typeof vi.fn>;
const mockVerifyRefresh = verifyRefreshToken as ReturnType<typeof vi.fn>;
const mockStartSession = sessionService.startSession as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminRow = (over: any = {}) => ({ id: "a".repeat(24), email: "admin@x.com", name: "Root", passwordHash: "h", ...over });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userRow = (over: any = {}) => ({
  id: "u".repeat(24), email: "user@x.com", firstName: "Ada", lastName: "Byte",
  profileImageUrl: null, signatureUrl: null, status: "active", mustResetPassword: false,
  passwordHash: "h", role: { id: "r".repeat(24), key: "warehouse_manager", name: "WM", permissions: [], isWarehouseScoped: false },
  ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const customerRow = (over: any = {}) => ({
  id: "c".repeat(24), email: "cust@x.com", fullName: "Cust Person", status: "active",
  mustResetPassword: false, passwordHash: "h",
  customer: { id: "d".repeat(24), name: "Acme", customerCode: "CUST-0001", logoUrl: null, status: "active", deletedAt: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockStartSession.mockResolvedValue("sid-1");
  (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe("login", () => {
  it("resolves the super-admin when the password verifies", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(true);

    const res = await login("Admin@X.com", "pw");

    expect(res.principal.type).toBe("admin");
    expect(res.principal.id).toBe("a".repeat(24));
    expect(res.accessToken).toBe("access-token");
    expect(mockStartSession).toHaveBeenCalledWith("a".repeat(24), "admin", expect.anything());
    expect(audit.record).toHaveBeenCalled();
  });

  it("normalises the email before lookup (trim + lowercase)", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(true);
    await login("  Admin@X.com  ", "pw");
    expect(adminRepo.findByEmail).toHaveBeenCalledWith("admin@x.com");
  });

  it("rejects an unknown email with a generic error", async () => {
    await expect(login("nobody@x.com", "pw")).rejects.toThrow(/invalid email or password/i);
  });

  it("rejects a wrong password with the same generic error (no enumeration)", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(false);
    await expect(login("admin@x.com", "bad")).rejects.toThrow(/invalid email or password/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("resolves an active staff user", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(true);
    const res = await login("user@x.com", "pw");
    expect(res.principal.type).toBe("user");
    expect(mockStartSession).toHaveBeenCalledWith("u".repeat(24), "user", expect.anything());
  });

  it("blocks a correct-password login on a non-active staff user", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow({ status: "suspended" }));
    mockVerifyPassword.mockResolvedValue(true);
    await expect(login("user@x.com", "pw")).rejects.toThrow(/not active/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("resolves an active customer portal user last", async () => {
    (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(customerRow());
    mockVerifyPassword.mockResolvedValue(true);
    const res = await login("cust@x.com", "pw");
    expect(res.principal.type).toBe("customer");
  });

  it("blocks a customer whose company is deleted", async () => {
    (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      customerRow({ customer: { id: "d".repeat(24), name: "Acme", customerCode: "CUST-0001", logoUrl: null, status: "active", deletedAt: new Date() } }),
    );
    mockVerifyPassword.mockResolvedValue(true);
    await expect(login("cust@x.com", "pw")).rejects.toThrow(/not active/i);
  });
});

describe("refreshSession", () => {
  it("rejects an invalid/expired token", async () => {
    mockVerifyRefresh.mockImplementation(() => { throw new Error("bad"); });
    await expect(refreshSession("x")).rejects.toThrow(/invalid or expired/i);
  });

  it("rejects when the session doesn't match the token principal", async () => {
    mockVerifyRefresh.mockReturnValue({ sub: "u".repeat(24), actor: "user", sid: "s" });
    (sessionService.findActive as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s" });
    (sessionService.sessionMatchesPrincipal as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(refreshSession("x")).rejects.toThrow(/session expired/i);
  });

  it("re-issues tokens for a valid active user session", async () => {
    mockVerifyRefresh.mockReturnValue({ sub: "u".repeat(24), actor: "user", sid: "s" });
    (sessionService.findActive as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s" });
    (sessionService.sessionMatchesPrincipal as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    const res = await refreshSession("x");
    expect(res.principal.type).toBe("user");
    expect(res.accessToken).toBe("access-token");
    expect(sessionService.touch).toHaveBeenCalledWith("s");
  });

  it("rejects refresh for a now-inactive user", async () => {
    mockVerifyRefresh.mockReturnValue({ sub: "u".repeat(24), actor: "user", sid: "s" });
    (sessionService.findActive as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s" });
    (sessionService.sessionMatchesPrincipal as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(userRow({ status: "suspended" }));
    await expect(refreshSession("x")).rejects.toThrow(/unauthorized/i);
  });
});

describe("logout", () => {
  it("ends the current session and records an audit event", async () => {
    const principal = { type: "admin" as const, id: "a".repeat(24), email: "admin@x.com", name: "Root" };
    await logout(principal, "sid-9");
    expect(sessionService.endSession).toHaveBeenCalledWith("sid-9");
    expect(audit.record).toHaveBeenCalled();
  });
});

// The super admin's display NAME had no way in. `Admin.name` existed in the schema and nothing ever
// wrote it, so every document a super admin raised printed a raw login where a person's name belongs
// — and where a stale staff row happened to share the address, the wrong person's name.
describe("changeCredentials — the super admin's own name", () => {
  const ADMIN_ID = "a".repeat(24);
  const admin = { id: ADMIN_ID, email: "boss@x.com", passwordHash: "hash", name: null };

  beforeEach(() => {
    vi.clearAllMocks();
    (adminRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(admin);
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (adminRepo.update as ReturnType<typeof vi.fn>).mockImplementation((_id, data) =>
      Promise.resolve({ ...admin, ...data }),
    );
  });

  it("saves a name on its own, without touching the email or password", async () => {
    await changeCredentials(ADMIN_ID, { currentPassword: "pw", name: "Ada Boss" }, "sid");
    expect(adminRepo.update).toHaveBeenCalledWith(ADMIN_ID, { name: "Ada Boss" });
  });

  it("trims what was typed", async () => {
    await changeCredentials(ADMIN_ID, { currentPassword: "pw", name: "  Ada Boss  " }, "sid");
    expect(adminRepo.update).toHaveBeenCalledWith(ADMIN_ID, { name: "Ada Boss" });
  });

  // Clearing it is a real intent — back to no name, which prints the email. An empty string must not
  // be stored as a name, or documents would print a blank where a person belongs.
  it("stores a cleared name as null, not an empty string", async () => {
    (adminRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...admin, name: "Ada Boss" });
    await changeCredentials(ADMIN_ID, { currentPassword: "pw", name: "   " }, "sid");
    expect(adminRepo.update).toHaveBeenCalledWith(ADMIN_ID, { name: null });
  });

  it("still refuses a request that changes nothing", async () => {
    await expect(changeCredentials(ADMIN_ID, { currentPassword: "pw" }, "sid")).rejects.toThrow(/nothing to update/i);
  });

  // The name is not a credential — changing it must not sign the other devices out.
  it("does not end other sessions for a name change", async () => {
    await changeCredentials(ADMIN_ID, { currentPassword: "pw", name: "Ada Boss" }, "sid");
    expect(sessionService.endOthers).not.toHaveBeenCalled();
  });
});
