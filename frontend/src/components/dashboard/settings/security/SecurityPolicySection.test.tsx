// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byLabel, byText, cleanup, click, render, wait } from "@/test/dom";
import { ApiError } from "@/lib/api";

vi.mock("@/services/settings.service", () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
const pushToast = vi.fn();
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast }) }));
const can = vi.fn(() => true);
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can }) }));

import * as settingsService from "@/services/settings.service";
import { SecurityPolicySection } from "./SecurityPolicySection";

const SAVED = {
  emailTwoFactorEnabled: false,
  smtpHost: "smtp.acme.com",
  smtpPort: 587,
  smtpFromEmail: "no-reply@acme.com",
  smtpPasswordSet: true,
};

const saved = (over: Record<string, unknown> = {}) => ({ ...SAVED, ...over });
const toggle = () => byLabel("Require a code at sign-in") as HTMLButtonElement | null;

/** A dialog button by its exact label — the dialog is portalled to document.body. */
const dialogBtn = (label: string): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;

const dialog = () => document.querySelector('[role="dialog"]');

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(true);
  vi.mocked(settingsService.getSettings).mockResolvedValue(saved() as never);
  vi.mocked(settingsService.updateSettings).mockImplementation(
    async (p) => saved({ emailTwoFactorEnabled: p.emailTwoFactorEnabled }) as never,
  );
});

afterEach(cleanup);

// Before the first read lands, this card knows nothing — and its "defaults" are not the neutral
// placeholders the other settings tabs fall back to. They assert that mail is unconfigured and that
// 2FA is off, about the one setting on the page that can lock a whole company out.
describe("before the current policy is known", () => {
  /** A read that never settles, so the card stays in its pre-load state for the assertions. */
  const neverResolves = () => new Promise(() => {}) as Promise<never>;

  it("claims neither that 2FA is off nor that SMTP is missing", async () => {
    vi.mocked(settingsService.getSettings).mockImplementation(neverResolves);
    await render(<SecurityPolicySection />);
    await wait();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Set up SMTP under Settings → Email");
    expect(text).not.toContain("Turn on to add an emailed code");
    expect(text).toContain("Checking the current policy");
  });

  it("does not offer a toggle it cannot yet set correctly", async () => {
    vi.mocked(settingsService.getSettings).mockImplementation(neverResolves);
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(true);
  });

  // A failed read must not leave the card waiting for ever: it falls back to its defaults and
  // becomes usable, so an admin can still change the policy.
  it("stops waiting when the read fails", async () => {
    vi.mocked(settingsService.getSettings).mockRejectedValue(new ApiError("offline", 500));
    await render(<SecurityPolicySection />);
    await wait();
    expect(document.body.textContent).not.toContain("Checking the current policy");
  });
});

describe("SMTP readiness", () => {
  it("disables the toggle and explains why when SMTP is incomplete", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(saved({ smtpHost: "" }) as never);
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Set up SMTP under Settings → Email");
  });

  it("treats an unset SMTP password as incomplete", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(
      saved({ smtpPasswordSet: false }) as never,
    );
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(true);
  });

  it("enables the toggle when SMTP is complete", async () => {
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(false);
  });

  // Disabling must never be blocked — otherwise a broken mail server traps everyone behind a
  // factor nobody can receive.
  it("leaves the toggle usable for DISABLING even when SMTP is broken", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(
      saved({ smtpHost: "", emailTwoFactorEnabled: true }) as never,
    );
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(false);
  });
});

describe("permissions", () => {
  it("is read-only without settings.manage", async () => {
    can.mockReturnValue(false);
    await render(<SecurityPolicySection />);
    await wait();
    expect(toggle()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Read-only");
  });
});

// The app's ConfirmDialog, never window.confirm — this is the only confirmation surface in the app
// that is keyboard reachable and announced to assistive tech.
describe("confirmation dialog", () => {
  it("opens a real dialog rather than a native confirm", async () => {
    await render(<SecurityPolicySection />);
    await wait();
    await click(toggle());
    await wait();

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d?.getAttribute("aria-modal")).toBe("true");
    expect(byText("Turn on two-factor authentication?")).not.toBeNull();
    // Nothing is sent until the dialog is confirmed.
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it("sends nothing when the enable dialog is cancelled", async () => {
    await render(<SecurityPolicySection />);
    await wait();
    await click(toggle());
    await wait();
    await click(dialogBtn("Cancel"));
    await wait();

    expect(settingsService.updateSettings).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("asks a different question when turning it OFF", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(
      saved({ emailTwoFactorEnabled: true }) as never,
    );
    await render(<SecurityPolicySection />);
    await wait();
    await click(toggle());
    await wait();

    expect(byText("Turn off two-factor authentication?")).not.toBeNull();
    expect(dialogBtn("Turn off")).not.toBeNull();
  });

  it("saves when confirmed", async () => {
    await render(<SecurityPolicySection />);
    await wait();
    await click(toggle());
    await wait();
    await click(dialogBtn("Turn on"));
    await wait();

    expect(settingsService.updateSettings).toHaveBeenCalledWith({ emailTwoFactorEnabled: true });
    expect(pushToast).toHaveBeenCalledWith("Two-factor authentication is on.");
    expect(dialog()).toBeNull();
  });
});


describe("Google cross-reference", () => {
  // Google stays available when 2FA is on and is subject to it, so the hint says so rather than
  // warning that Google disappears.
  it("says Google keeps working and is covered by the code too", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(
      saved({ emailTwoFactorEnabled: true }) as never,
    );
    await render(<SecurityPolicySection />);
    await wait();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Google Sign-In keeps working and asks for the code too");
    // The old behaviour hid Google entirely — make sure that copy can never come back.
    expect(text).not.toContain("unavailable");
  });

  // When the toggle is blocked, the blocker is the only thing worth saying.
  it("replaces the hint with the SMTP blocker when SMTP is incomplete", async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue(saved({ smtpHost: "" }) as never);
    await render(<SecurityPolicySection />);
    await wait();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Set up SMTP under Settings → Email");
    expect(text).not.toContain("Google Sign-In keeps working");
  });
});

describe("error handling", () => {
  it("surfaces a save failure without toasting success", async () => {
    vi.mocked(settingsService.updateSettings).mockRejectedValue(new ApiError("Boom.", 500));
    await render(<SecurityPolicySection />);
    await wait();
    await click(toggle());
    await wait();
    await click(dialogBtn("Turn on"));
    await wait();

    expect(byText("Boom.")).not.toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
    // The dialog closes so the error is readable on the card behind it.
    expect(dialog()).toBeNull();
  });
});
