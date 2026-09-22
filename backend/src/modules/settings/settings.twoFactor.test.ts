import { beforeEach, describe, expect, it, vi } from "vitest";

// The two pre-enable guards on the global email-2FA switch, and its audit trail.
//
// The guard exists because turning 2FA ON without SMTP locks EVERYONE out — nobody can receive a
// code at all, including the administrator who would need to turn it back off. It never runs when
// DISABLING, for that same reason.
//
// There is deliberately no "customers without a password" guard: Google sign-in stays available
// while 2FA is on (and is subject to it), so those accounts keep working and simply get a code.

vi.mock("./settings.repository.js", () => ({
  getOrCreate: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("../../utils/crypto.js", () => ({
  decryptSecret: vi.fn((v: string) => v),
  encryptSecret: vi.fn((v: string) => v),
}));

import * as settingsRepo from "./settings.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { updateSettings } from "./settings.service.js";

// A saved row with SMTP fully configured and Google off.
const SAVED = {
  id: "s1",
  smtpHost: "smtp.acme.com",
  smtpPort: 587,
  smtpFromEmail: "no-reply@acme.com",
  smtpPassword: "enc",
  googleEnabled: false,
  emailTwoFactorEnabled: false,
};

const saved = (over: Record<string, unknown> = {}) => ({ ...SAVED, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(saved() as never);
  vi.mocked(settingsRepo.update).mockImplementation(
    async (_id, d) => ({ ...SAVED, ...d }) as never,
  );
});

describe("SMTP guard", () => {
  it("refuses to enable 2FA when SMTP is incomplete", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(saved({ smtpHost: null }) as never);
    await expect(updateSettings({ emailTwoFactorEnabled: true })).rejects.toMatchObject({
      status: 400,
    });
    // Nothing is written — the flag must not land even partially.
    expect(settingsRepo.update).not.toHaveBeenCalled();
  });

  it("checks every SMTP field the sender requires, not just the host", async () => {
    for (const missing of ["smtpHost", "smtpPort", "smtpFromEmail", "smtpPassword"]) {
      vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(saved({ [missing]: null }) as never);
      await expect(updateSettings({ emailTwoFactorEnabled: true })).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("allows enabling when SMTP is complete", async () => {
    await expect(updateSettings({ emailTwoFactorEnabled: true })).resolves.toMatchObject({
      emailTwoFactorEnabled: true,
    });
  });

  // The lockout escape hatch: disabling must never be blocked.
  it("never blocks DISABLING, even with SMTP broken", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(
      saved({ smtpHost: null, emailTwoFactorEnabled: true }) as never,
    );
    await expect(updateSettings({ emailTwoFactorEnabled: false })).resolves.toBeTruthy();
  });

  it("allows an unrelated edit that leaves SMTP as it was", async () => {
    await expect(updateSettings({ brandName: "X" })).resolves.toBeTruthy();
  });
});

// THE SECOND LOCKOUT DOOR. Guarding only the moment 2FA is switched ON left this wide open: with
// 2FA already running, clearing SMTP from the Email tab locked out the whole company — including
// the administrator who would have to turn 2FA back off. The guard now judges the configuration the
// save LEAVES BEHIND, which closes both doors with one rule.
describe("SMTP cannot be broken while 2FA is enabled", () => {
  const twoFactorOn = (over: Record<string, unknown> = {}) =>
    saved({ emailTwoFactorEnabled: true, ...over });

  beforeEach(() => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(twoFactorOn() as never);
  });

  // Every field sendConfiguredEmail requires. Clearing ANY of them breaks delivery just as
  // completely as clearing the host.
  it.each([
    ["smtpHost", { smtpHost: "" }],
    ["smtpFromEmail", { smtpFromEmail: "" }],
    ["smtpPort", { smtpPort: "" }],
  ])("rejects clearing %s while 2FA is on", async (_field, patch) => {
    await expect(updateSettings(patch)).rejects.toMatchObject({ status: 400 });
    // Nothing is written — the break must not land even partially.
    expect(settingsRepo.update).not.toHaveBeenCalled();
  });

  it("rejects a port that parses to nothing", async () => {
    await expect(updateSettings({ smtpPort: "not-a-port" })).rejects.toMatchObject({ status: 400 });
    expect(settingsRepo.update).not.toHaveBeenCalled();
  });

  it("explains that 2FA is the reason, and offers the way out", async () => {
    await expect(updateSettings({ smtpHost: "" })).rejects.toThrow(
      /two-factor authentication is on[\s\S]*turn two-factor authentication off first/i,
    );
  });

  // A: an edit that leaves the config VALID is still allowed.
  it("allows an SMTP edit that leaves the configuration complete", async () => {
    await expect(updateSettings({ smtpHost: "smtp.other.com" })).resolves.toBeTruthy();
    expect(settingsRepo.update).toHaveBeenCalled();
  });

  it("allows editing fields delivery does not depend on", async () => {
    await expect(
      updateSettings({ smtpUsername: "", smtpFromName: "", smtpSecure: true }),
    ).resolves.toBeTruthy();
  });

  // D: the escape hatch. Disabling must NEVER be blocked, whatever SMTP looks like.
  it("allows turning 2FA OFF in the same save that clears SMTP", async () => {
    await expect(
      updateSettings({ emailTwoFactorEnabled: false, smtpHost: "" }),
    ).resolves.toBeTruthy();
  });

  it("allows turning 2FA OFF when SMTP is already broken", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(twoFactorOn({ smtpHost: null }) as never);
    await expect(updateSettings({ emailTwoFactorEnabled: false })).resolves.toBeTruthy();
  });

  // Enabling and repairing SMTP in ONE save is legitimate — the state left behind is valid.
  it("allows enabling 2FA in the same save that completes SMTP", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(saved({ smtpHost: null }) as never);
    await expect(
      updateSettings({ emailTwoFactorEnabled: true, smtpHost: "smtp.acme.com" }),
    ).resolves.toBeTruthy();
  });

  // C: with 2FA off, clearing SMTP is ordinary configuration and stays allowed.
  it("leaves the 2FA-OFF behaviour untouched", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(saved() as never);
    await expect(updateSettings({ smtpHost: "" })).resolves.toBeTruthy();
  });
});


describe("audit", () => {
  it("records settings.2fa_enabled with the acting principal", async () => {
    await updateSettings({ emailTwoFactorEnabled: true }, {
      id: "a1",
      email: "admin@x.com",
      type: "admin",
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.2fa_enabled",
        actor: expect.objectContaining({ email: "admin@x.com" }),
      }),
    );
  });

  it("records settings.2fa_disabled", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(
      saved({ emailTwoFactorEnabled: true }) as never,
    );
    await updateSettings({ emailTwoFactorEnabled: false });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.2fa_disabled" }),
    );
  });

  it("records nothing when the flag did not actually change", async () => {
    await updateSettings({ emailTwoFactorEnabled: false });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records nothing for an unrelated settings edit", async () => {
    await updateSettings({ brandName: "Acme" });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
