import type { Settings } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Service-level round trip for the login copy and footer: what the Branding form saves, and what
// the login screen then reads. The pure rules are covered in branding.defaults.test.ts; this pins that the
// service actually routes both directions through them.
vi.mock("./settings.repository.js", () => ({
  getOrCreate: vi.fn(),
  update: vi.fn(),
}));

import * as settingsRepo from "./settings.repository.js";
import { getBranding, updateSettings } from "./settings.service.js";
import { DEFAULT_LOGIN_SUBTEXT } from "./branding.defaults.js";

const RETIRED_SUBTEXT = "Sign in to access your admin dashboard and run everything from one place.";

const row = (over: Partial<Settings> = {}) => ({ id: "s1", ...over }) as Settings;

beforeEach(() => {
  vi.mocked(settingsRepo.update).mockReset();
  vi.mocked(settingsRepo.getOrCreate).mockReset();
});

describe("settings service — login copy", () => {
  it("serves the new default to an install whose row still holds the retired 'admin dashboard' text", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row({ loginSubtext: RETIRED_SUBTEXT }));
    const branding = await getBranding();
    expect(branding.loginSubtext).toBe(DEFAULT_LOGIN_SUBTEXT);
    expect(branding.loginSubtext).not.toMatch(/admin/i);
  });

  it("does not persist the default when the Branding form posts it back unchanged", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row());
    vi.mocked(settingsRepo.update).mockResolvedValue(row());

    await updateSettings({ loginSubtext: DEFAULT_LOGIN_SUBTEXT, brandName: "Senthra" });

    const [, data] = vi.mocked(settingsRepo.update).mock.calls[0]!;
    expect(data.loginSubtext).toBeNull();
  });

  it("persists custom login copy", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row());
    vi.mocked(settingsRepo.update).mockResolvedValue(row({ loginSubtext: "Welcome back." }));

    const saved = await updateSettings({ loginSubtext: " Welcome back. " });

    const [, data] = vi.mocked(settingsRepo.update).mock.calls[0]!;
    expect(data.loginSubtext).toBe("Welcome back.");
    expect(saved.loginSubtext).toBe("Welcome back.");
  });
});

describe("settings service — footer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const savedData = () => vi.mocked(settingsRepo.update).mock.calls[0]![1];

  it("shows the current year to an install whose footer froze in 2026", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(
      row({ footerText: "© 2026 Senthra. All rights reserved." }),
    );
    expect((await getBranding()).footerText).toBe("© 2027 Senthra. All rights reserved.");
  });

  // The client-visible failure: rebrand in one save, with the footer echoed under the old name.
  it("does not store the old brand's footer when a rename arrives in the same save", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row()); // brand unset → install default
    vi.mocked(settingsRepo.update).mockResolvedValue(row({ brandName: "Electra" }));

    const saved = await updateSettings({
      brandName: "Electra",
      footerText: "© 2027 Senthra. All rights reserved.",
    });

    expect(savedData().footerText).toBeNull();
    expect(saved.footerText).toBe("© 2027 Electra. All rights reserved.");
  });

  it("releases a footer frozen under the previous brand when only the name changes", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(
      row({ brandName: "Northwind", footerText: "© 2026 Northwind. All rights reserved." }),
    );
    vi.mocked(settingsRepo.update).mockResolvedValue(row({ brandName: "Electra" }));

    await updateSettings({ brandName: "Electra" });

    expect(savedData().footerText).toBeNull();
  });

  it("keeps a custom footer on a brand-only rename", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(
      row({ brandName: "Northwind", footerText: "Northwind Group plc" }),
    );
    vi.mocked(settingsRepo.update).mockResolvedValue(row());

    await updateSettings({ brandName: "Electra" });

    expect(savedData().footerText).toBe("Northwind Group plc");
  });

  it("persists a custom footer", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row());
    vi.mocked(settingsRepo.update).mockResolvedValue(row({ footerText: "Electra Group plc" }));

    const saved = await updateSettings({ footerText: " Electra Group plc " });

    expect(savedData().footerText).toBe("Electra Group plc");
    expect(saved.footerText).toBe("Electra Group plc");
  });

  it("leaves the footer untouched when neither it nor the brand name is saved", async () => {
    vi.mocked(settingsRepo.getOrCreate).mockResolvedValue(row({ footerText: "Electra Group plc" }));
    vi.mocked(settingsRepo.update).mockResolvedValue(row());

    await updateSettings({ loginSubtext: "Welcome back." });

    expect(savedData()).not.toHaveProperty("footerText");
  });
});
