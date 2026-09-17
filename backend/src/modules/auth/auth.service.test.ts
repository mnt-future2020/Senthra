import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the auth service credential-resolution + refresh + logout logic. Everything with a
// side effect or env/crypto dependency is mocked, so these are pure tests of the branching:
// which principal a (email, password) pair resolves to, and how refresh/logout behave. The principal
// mappers (types/principal) run for real so the returned shape is exercised end-to-end.

vi.mock("../../config/env.js", () => ({ env: { nodeEnv: "test" } }));
const { mockVerifyIdToken } = vi.hoisted(() => ({ mockVerifyIdToken: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mockVerifyIdToken;
  },
}));
vi.mock("./admin.repository.js", () => ({ findByEmail: vi.fn(), findById: vi.fn(), findFirst: vi.fn(), update: vi.fn() }));
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
vi.mock("#modules/settings/settings.repository.js", () => ({ getSettings: vi.fn(), findFirst: vi.fn() }));
vi.mock("./twoFactor.service.js", () => ({ createChallenge: vi.fn(), verifyChallenge: vi.fn(), readChallenge: vi.fn(), resendChallenge: vi.fn(), cancelChallenge: vi.fn(), purgeExpiredChallenges: vi.fn() }));
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
import * as settingsRepo from "#modules/settings/settings.repository.js";
import * as twoFactorService from "./twoFactor.service.js";
import { verifyPassword } from "../../utils/password.js";
import { verifyRefreshToken } from "../../utils/jwt.js";
import {
  changeCredentials,
  completeTwoFactorLogin,
  getGoogleConfig,
  googleLogin,
  login,
  refreshSession,
  logout,
} from "./auth.service.js";
import type { AuthResult } from "./auth.service.js";

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
  // 2FA OFF by default, so every pre-existing assertion below exercises the ORIGINAL login path.
  (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    emailTwoFactorEnabled: false,
    googleEnabled: true,
    googleClientId: "gid",
  });
});

// login() now returns a union. These helpers narrow it so a test that expects a completed sign-in
// fails loudly if a challenge was opened instead (and vice versa).
async function loginOk(email: string, password: string, remember = true): Promise<AuthResult> {
  const res = await login(email, password, remember);
  if (res.twoFactorRequired) throw new Error("expected a completed login, got a 2FA challenge");
  return res;
}

describe("login", () => {
  it("resolves the super-admin when the password verifies", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(true);

    const res = await loginOk("Admin@X.com", "pw");

    expect(res.principal.type).toBe("admin");
    expect(res.principal.id).toBe("a".repeat(24));
    expect(res.accessToken).toBe("access-token");
    expect(mockStartSession).toHaveBeenCalledWith("a".repeat(24), "admin", expect.anything());
    expect(audit.record).toHaveBeenCalled();
  });

  it("normalises the email before lookup (trim + lowercase)", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(true);
    await loginOk("  Admin@X.com  ", "pw");
    expect(adminRepo.findByEmail).toHaveBeenCalledWith("admin@x.com");
  });

  it("rejects an unknown email with a generic error", async () => {
    await expect(loginOk("nobody@x.com", "pw")).rejects.toThrow(/invalid email or password/i);
  });

  it("rejects a wrong password with the same generic error (no enumeration)", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(false);
    await expect(loginOk("admin@x.com", "bad")).rejects.toThrow(/invalid email or password/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("resolves an active staff user", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(true);
    const res = await loginOk("user@x.com", "pw");
    expect(res.principal.type).toBe("user");
    expect(mockStartSession).toHaveBeenCalledWith("u".repeat(24), "user", expect.anything());
  });

  it("blocks a correct-password login on a non-active staff user", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow({ status: "suspended" }));
    mockVerifyPassword.mockResolvedValue(true);
    await expect(loginOk("user@x.com", "pw")).rejects.toThrow(/not active/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("resolves an active customer portal user last", async () => {
    (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(customerRow());
    mockVerifyPassword.mockResolvedValue(true);
    const res = await loginOk("cust@x.com", "pw");
    expect(res.principal.type).toBe("customer");
  });

  it("blocks a customer whose company is deleted", async () => {
    (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      customerRow({ customer: { id: "d".repeat(24), name: "Acme", customerCode: "CUST-0001", logoUrl: null, status: "active", deletedAt: new Date() } }),
    );
    mockVerifyPassword.mockResolvedValue(true);
    await expect(loginOk("cust@x.com", "pw")).rejects.toThrow(/not active/i);
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

// --- Email 2FA -------------------------------------------------------------------------------
// The invariant these protect: with 2FA ON, proving the password must produce NO session. At
// MAX_DEVICES = 1 a premature session would evict the account's real device, so a stolen password
// alone — or a user who simply abandons the OTP step — would sign the legitimate user out.

describe("login with 2FA enabled", () => {
  beforeEach(() => {
    (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailTwoFactorEnabled: true,
      googleEnabled: true,
      googleClientId: "gid",
    });
    (twoFactorService.createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      challengeToken: "raw-token",
      email: "u•••@x.com",
      expiresAt: new Date("2026-01-01T00:10:00Z"),
      resendAvailableAt: new Date("2026-01-01T00:01:00Z"),
      resendsRemaining: 3,
    });
  });

  it("creates NO session and NO tokens for a staff user", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(true);

    const res = await login("user@x.com", "pw", true);

    expect(res.twoFactorRequired).toBe(true);
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("accessToken");
    expect(res).not.toHaveProperty("principal");
  });

  it("challenges the admin and the customer too — all three principal types", async () => {
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow());
    mockVerifyPassword.mockResolvedValue(true);
    expect((await login("admin@x.com", "pw", true)).twoFactorRequired).toBe(true);

    vi.clearAllMocks();
    (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ emailTwoFactorEnabled: true });
    (twoFactorService.createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      challengeToken: "t", email: "c•••@x.com", expiresAt: new Date(),
      resendAvailableAt: new Date(), resendsRemaining: 3,
    });
    (adminRepo.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (customerRepo.findLoginByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(customerRow());
    mockVerifyPassword.mockResolvedValue(true);
    expect((await login("cust@x.com", "pw", true)).twoFactorRequired).toBe(true);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("does NOT record auth.login until the code is verified", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(true);
    await login("user@x.com", "pw", true);

    const actions = (audit.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain("auth.login");
    expect(actions).toContain("auth.2fa_challenged");
  });

  it("carries the remember flag onto the challenge so the eventual session honours it", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(true);
    await login("user@x.com", "pw", false);
    expect(twoFactorService.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ remember: false, firstName: "Ada", email: "user@x.com" }),
    );
  });

  it("still rejects a wrong password BEFORE any challenge is opened", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    mockVerifyPassword.mockResolvedValue(false);
    await expect(login("user@x.com", "bad", true)).rejects.toThrow(/invalid email or password/i);
    expect(twoFactorService.createChallenge).not.toHaveBeenCalled();
  });

  it("still blocks an inactive account BEFORE any challenge is opened", async () => {
    (userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>).mockResolvedValue(userRow({ status: "suspended" }));
    mockVerifyPassword.mockResolvedValue(true);
    await expect(login("user@x.com", "pw", true)).rejects.toThrow(/not active/i);
    expect(twoFactorService.createChallenge).not.toHaveBeenCalled();
  });
});

describe("completeTwoFactorLogin", () => {
  beforeEach(() => {
    (twoFactorService.verifyChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      principalId: "u".repeat(24),
      principalType: "user",
      remember: false,
    });
  });

  it("creates exactly one session and returns the principal", async () => {
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    const res = await completeTwoFactorLogin("tok", "123456");

    expect(res.principal.type).toBe("user");
    expect(res.accessToken).toBe("access-token");
    expect(res.remember).toBe(false);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });

  it("records auth.2fa_verified and THEN auth.login", async () => {
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(userRow());
    await completeTwoFactorLogin("tok", "123456");

    const actions = (audit.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions.indexOf("auth.2fa_verified")).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf("auth.login")).toBeGreaterThan(actions.indexOf("auth.2fa_verified"));
  });

  // Minutes can pass between proving the password and entering the code.
  it("re-checks that the account is still active before opening a session", async () => {
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(userRow({ status: "inactive" }));
    await expect(completeTwoFactorLogin("tok", "123456")).rejects.toThrow(/not active/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("refuses a deleted account", async () => {
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(completeTwoFactorLogin("tok", "123456")).rejects.toThrow(/unauthorized/i);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("opens no session when the code is rejected", async () => {
    (twoFactorService.verifyChallenge as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("That code is incorrect or has expired."),
    );
    await expect(completeTwoFactorLogin("tok", "000000")).rejects.toThrow();
    expect(mockStartSession).not.toHaveBeenCalled();
  });
});

describe("Google sign-in under 2FA", () => {
  // The button STAYS visible when 2FA is on — and Google is subject to the second factor, so it is
  // not a way around it. Exempting Google would mean "2FA is on" protected only the accounts that
  // happen not to have a matching Google account.
  it("still reports the stored Google configuration while 2FA is on", async () => {
    (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailTwoFactorEnabled: true,
      googleEnabled: true,
      googleClientId: "gid",
    });
    await expect(getGoogleConfig()).resolves.toEqual({ enabled: true, clientId: "gid" });
  });

  it("reports Google as off only when it is actually off", async () => {
    (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailTwoFactorEnabled: true,
      googleEnabled: false,
      googleClientId: "gid",
    });
    await expect(getGoogleConfig()).resolves.toEqual({ enabled: false, clientId: null });
  });

  it("opens a 2FA challenge for a Google sign-in, creating NO session", async () => {
    (settingsRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailTwoFactorEnabled: true,
      googleEnabled: true,
      googleClientId: "gid",
    });
    (twoFactorService.createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      challengeToken: "t", email: "u•••@x.com", expiresAt: new Date(),
      resendAvailableAt: new Date(), resendsRemaining: 3,
    });
    (adminRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow({ googleEmail: "admin@x.com" }));
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: "admin@x.com", email_verified: true }) });

    const res = await googleLogin("valid-credential", true);

    expect(res.twoFactorRequired).toBe(true);
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("accessToken");
  });

  it("signs in directly through Google when 2FA is off", async () => {
    (adminRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(adminRow({ googleEmail: "admin@x.com" }));
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: "admin@x.com", email_verified: true }) });

    const res = await googleLogin("valid-credential", true);

    expect(res.twoFactorRequired).toBe(false);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });
});
