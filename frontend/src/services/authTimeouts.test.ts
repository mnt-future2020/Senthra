import { beforeEach, describe, expect, it, vi } from "vitest";

// The SMTP-blocking auth calls must use the LONG timeout.
//
// With 2FA on, /auth/login, /auth/google and /auth/2fa/resend all wait for the server to finish
// sending the OTP email before they answer — a second network round trip the client cannot see.
// On the 20s default a slow mail server produced "the request timed out" for a login that had in
// fact SUCCEEDED, and the user would retry, opening a second challenge and sending a second code.

const api = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});

import { LONG_WRITE_TIMEOUT } from "@/lib/api";
import * as authService from "./auth.service";

const optsFor = (path: string) =>
  api.mock.calls.find((c) => c[0] === path)?.[1] as { timeout?: number } | undefined;

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ principal: { type: "admin" } });
});

describe("auth requests that wait on an email send", () => {
  it("gives /auth/login the long write timeout", async () => {
    await authService.login("a@x.com", "pw");
    expect(optsFor("/auth/login")?.timeout).toBe(LONG_WRITE_TIMEOUT);
  });

  it("gives /auth/google the long write timeout", async () => {
    await authService.loginWithGoogle("tok");
    expect(optsFor("/auth/google")?.timeout).toBe(LONG_WRITE_TIMEOUT);
  });

  it("gives /auth/2fa/resend the long write timeout", async () => {
    await authService.resendTwoFactor();
    expect(optsFor("/auth/2fa/resend")?.timeout).toBe(LONG_WRITE_TIMEOUT);
  });

  // It is a longer ceiling, not no ceiling — a genuinely wedged request must still fail.
  it("keeps a finite ceiling", () => {
    expect(Number.isFinite(LONG_WRITE_TIMEOUT)).toBe(true);
    expect(LONG_WRITE_TIMEOUT).toBeGreaterThan(20_000);
  });

  // The fast-failing calls stay on the default; a status check has no email behind it.
  it("leaves the challenge status check on the default timeout", async () => {
    await authService.getTwoFactorChallenge();
    expect(optsFor("/auth/2fa/challenge")?.timeout).toBeUndefined();
  });
});
