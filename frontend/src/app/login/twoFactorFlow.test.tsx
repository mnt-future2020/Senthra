// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byText, cleanup, click, render, wait } from "@/test/dom";
import { ApiError } from "@/lib/api";

// The login page's two-step behaviour. What these protect:
//  - 2FA OFF must be indistinguishable from before.
//  - A 401 from the challenge endpoint is the NORMAL "no challenge" answer and must not look
//    like an error.
//  - Completion goes through AuthProvider, never straight to the service.

const replace = vi.fn();
// One STABLE router object. Next's useRouter returns a stable instance; a fresh `{ replace }` each
// call would change identity every render and re-run every effect that depends on it, masking the
// stale-dependency bugs below.
const router = { replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const login = vi.fn();
const completeTwoFactor = vi.fn();
// STABLE identities, like the real provider's useCallback([]). An inline `vi.fn()` here would be a
// NEW function every render, so every effect depending on it would re-run each time — which silently
// hides exactly the stale-dependency bugs these tests exist to catch.
const loginWithGoogle = vi.fn();
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ principal: null, loading: false, login, loginWithGoogle, completeTwoFactor }),
}));

vi.mock("@/services/auth.service", () => ({
  getGoogleConfig: vi.fn(),
  getTwoFactorChallenge: vi.fn(),
  resendTwoFactor: vi.fn(),
  cancelTwoFactor: vi.fn(),
}));
vi.mock("@/lib/signedOutNotice", () => ({ takeSignedOutNotice: () => null }));
vi.mock("@/components/auth/AuthLayout", () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import * as authService from "@/services/auth.service";
import LoginPage from "./page";

const PENDING = {
  twoFactorRequired: true as const,
  email: "j•••@acme.com",
  expiresInSeconds: 600,
  resendInSeconds: 60,
  resendsRemaining: 3,
};

const noChallenge = () => new ApiError("No pending verification.", 401);

/** Set a controlled React input's value the way a real keystroke would. */
function type(el: HTMLInputElement | null, value: string): void {
  if (!el) throw new Error("type: input not found");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Fill the credential form and submit it.
 *
 * The email and password inputs are `required`, so requestSubmit() on an empty form is blocked by
 * the browser's own validation and the submit handler never runs.
 */
async function submitCredentials(): Promise<void> {
  type(document.querySelector<HTMLInputElement>('input[autocomplete="email"]'), "a@x.com");
  type(
    document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]'),
    "pw12345678",
  );
  await wait();
  document.querySelector<HTMLFormElement>("form")?.requestSubmit();
  await wait();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authService.getGoogleConfig).mockResolvedValue({ enabled: false, clientId: null });
  vi.mocked(authService.getTwoFactorChallenge).mockRejectedValue(noChallenge());
});

afterEach(cleanup);

describe("no pending challenge (the ordinary visit)", () => {
  it("renders the credential form", async () => {
    await render(<LoginPage />);
    await wait();
    expect(byText("Welcome Back")).not.toBeNull();
  });

  // A 401 here is expected on every normal visit — showing a red banner would be alarming nonsense.
  it("shows NO error banner for the 401", async () => {
    await render(<LoginPage />);
    await wait();
    expect(document.body.textContent).not.toContain("No pending verification");
    expect(byText("Check your email")).toBeNull();
  });
});

describe("2FA disabled — existing behaviour is preserved", () => {
  it("navigates straight to the dashboard after a successful login", async () => {
    login.mockResolvedValue({
      twoFactorRequired: false,
      principal: { type: "admin", id: "a1", email: "a@x.com", permissions: ["*"] },
    });
    await render(<LoginPage />);
    await wait();
    await submitCredentials();
    expect(replace).toHaveBeenCalled();
    expect(byText("Check your email")).toBeNull();
  });
});

describe("2FA enabled", () => {
  it("swaps to the OTP step on a 202, showing the masked address", async () => {
    login.mockResolvedValue(PENDING);
    await render(<LoginPage />);
    await wait();
    await submitCredentials();

    expect(byText("Check your email")).not.toBeNull();
    expect(document.body.textContent).toContain("j•••@acme.com");
    // No navigation: there is no session yet.
    expect(replace).not.toHaveBeenCalled();
  });

  it("resumes the OTP step on refresh, from the server's challenge state", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue(PENDING);
    await render(<LoginPage />);
    await wait();
    expect(byText("Check your email")).not.toBeNull();
    expect(byText("Welcome Back")).toBeNull();
  });

  it("shows the REAL remaining cooldown after a refresh, not a fresh 60s", async () => {
    // Sent 15s ago → the server reports the 45s that are really left.
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      resendInSeconds: 45,
    });
    await render(<LoginPage />);
    await wait();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Resend in 4[0-9]s/);
    expect(text).not.toContain("Resend in 60s");
  });

  // Without this the expiry is invisible until the user submits and is bounced back to the password
  // form, with no idea why the code they were carefully typing stopped working.
  it("shows how long the code has left", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      expiresInSeconds: 545,
    });
    await render(<LoginPage />);
    await wait();
    expect(document.body.textContent).toContain("Expires in 9:05");
  });

  it("says the code is dead once it expires, rather than counting into the negative", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      expiresInSeconds: 0,
    });
    await render(<LoginPage />);
    await wait();
    expect(document.body.textContent).toContain("This code has expired");
  });

  // Expiry deletes the whole challenge server-side, so Resend can only ever answer 410 from here.
  // The copy used to say "request a new one" while resends remained, which pointed the user at a
  // button that could only bounce them back to the password form.
  it("points at signing in again, never at a resend that cannot work", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      expiresInSeconds: 0,
      resendsRemaining: 3, // resends nominally left — still not a route once expired
    });
    await render(<LoginPage />);
    await wait();

    const text = document.body.textContent ?? "";
    expect(text).toContain("This code has expired. Please sign in again.");
    expect(text).not.toContain("request a new one");
  });

  // A resend re-bases the expiry server-side; the step must adopt the NEW remainder, not keep
  // counting down the old one.
  it("re-anchors both countdowns to the resent code", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      resendInSeconds: 0,
      expiresInSeconds: 20,
    });
    vi.mocked(authService.resendTwoFactor).mockResolvedValue({
      ...PENDING,
      resendInSeconds: 60,
      expiresInSeconds: 600,
      resendsRemaining: 2,
    });
    await render(<LoginPage />);
    await wait();
    expect(document.body.textContent).toContain("Expires in 0:20");

    await click(byText("Resend code"));
    await wait();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Expires in 10:00");
    expect(text).toMatch(/Resend in (59|60)s/);
  });

  it("completes through AuthProvider, not the service directly", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      resendInSeconds: 0,
    });
    completeTwoFactor.mockResolvedValue({
      type: "admin",
      id: "a1",
      email: "a@x.com",
      permissions: ["*"],
    });
    await render(<LoginPage />);
    await wait();

    type(document.querySelector<HTMLInputElement>("#two-factor-code"), "123456");
    await wait();
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await wait();

    expect(completeTwoFactor).toHaveBeenCalledWith("123456");
    expect(replace).toHaveBeenCalled();
  });

  it("returns to the credential form on Back even when cancel fails", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue(PENDING);
    // The user is not authenticated — a network failure must never trap them on this step.
    vi.mocked(authService.cancelTwoFactor).mockRejectedValue(new Error("network down"));
    await render(<LoginPage />);
    await wait();

    await click(byText("Back to sign in"));
    await wait();
    expect(byText("Welcome Back")).not.toBeNull();
    expect(byText("Check your email")).toBeNull();
  });

  it("shows the generic message and clears the field on a wrong code", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue(PENDING);
    completeTwoFactor.mockRejectedValue(
      new ApiError("That code is incorrect or has expired.", 401),
    );
    await render(<LoginPage />);
    await wait();

    type(document.querySelector<HTMLInputElement>("#two-factor-code"), "000000");
    await wait();
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await wait();

    expect(byText("That code is incorrect or has expired.")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>("#two-factor-code")?.value).toBe("");
    expect(replace).not.toHaveBeenCalled();
  });
});

// REGRESSION — the reported bug.
//
// After five wrong codes the server destroys the challenge. It used to answer with the SAME generic
// "incorrect or expired" as a bad code, so the page stayed on the OTP step: Verify kept failing and
// Resend silently did nothing, with no way forward but reloading. A dead challenge now answers 410
// and the step hands the user back to the credential form with the reason.
describe("challenge ended (410)", () => {
  const ended = (msg: string) => new ApiError(msg, 410);

  beforeEach(() => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue({
      ...PENDING,
      resendInSeconds: 0,
    });
  });

  it("returns to the credential form, with the reason, after too many wrong codes", async () => {
    completeTwoFactor.mockRejectedValue(
      ended("Too many incorrect codes. For your security, please sign in again."),
    );
    await render(<LoginPage />);
    await wait();

    type(document.querySelector<HTMLInputElement>("#two-factor-code"), "000000");
    await wait();
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await wait();

    expect(byText("Welcome Back")).not.toBeNull();
    expect(byText("Check your email")).toBeNull();
    expect(document.body.textContent).toContain("Too many incorrect codes");
  });

  it("does the same when Resend finds the challenge already gone", async () => {
    vi.mocked(authService.resendTwoFactor).mockRejectedValue(
      ended("For your security, that sign-in attempt has ended. Please sign in again."),
    );
    await render(<LoginPage />);
    await wait();

    await click(byText("Resend code"));
    await wait();

    // Not stuck on a dead step with a silent button.
    expect(byText("Welcome Back")).not.toBeNull();
    expect(document.body.textContent).toContain("that sign-in attempt has ended");
  });

  it("stays on the OTP step for an ordinary wrong code (401), so retrying still works", async () => {
    completeTwoFactor.mockRejectedValue(
      new ApiError("That code is incorrect or has expired.", 401),
    );
    await render(<LoginPage />);
    await wait();

    type(document.querySelector<HTMLInputElement>("#two-factor-code"), "000000");
    await wait();
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await wait();

    expect(byText("Check your email")).not.toBeNull();
    expect(byText("That code is incorrect or has expired.")).not.toBeNull();
  });
});

// REGRESSION — the Google button vanished after returning from the OTP step.
//
// It is drawn IMPERATIVELY into a div by an effect. Switching to the OTP step unmounts that div;
// coming back mounts a fresh empty one. The effect used to depend only on the Google config, so
// nothing changed and it never re-ran — leaving "OR LOGIN WITH" above an empty gap. The node is now
// a dependency (callback ref), so the effect runs every time the node appears.
describe("Google button survives the OTP round trip", () => {
  const renderButton = vi.fn();
  const initialize = vi.fn();

  beforeEach(() => {
    renderButton.mockClear();
    initialize.mockClear();
    vi.mocked(authService.getGoogleConfig).mockResolvedValue({ enabled: true, clientId: "gid" });
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize, renderButton } },
    };
  });

  it("re-renders the button into the fresh node after Back to sign in", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue(PENDING);
    await render(<LoginPage />);
    await wait();

    // On the OTP step: the credential form (and the Google node) is unmounted.
    expect(byText("Check your email")).not.toBeNull();
    const beforeBack = renderButton.mock.calls.length;

    await click(byText("Back to sign in"));
    await wait();

    expect(byText("Welcome Back")).not.toBeNull();
    // The button was drawn into the NEW node, not left empty.
    expect(renderButton.mock.calls.length).toBeGreaterThan(beforeBack);
    const target = renderButton.mock.calls.at(-1)?.[0] as HTMLElement;
    expect(document.body.contains(target)).toBe(true);
  });

  it("renders the button even when the Google script resolves before the resume check", async () => {
    // The ordering that used to lose the button on a cold load with a cached GIS script.
    vi.mocked(authService.getTwoFactorChallenge).mockRejectedValue(noChallenge());
    await render(<LoginPage />);
    await wait();

    expect(byText("Welcome Back")).not.toBeNull();
    expect(renderButton).toHaveBeenCalled();
    const target = renderButton.mock.calls.at(-1)?.[0] as HTMLElement;
    expect(document.body.contains(target)).toBe(true);
  });
});

// REGRESSION — Google sign-in looked frozen.
//
// The round trip is slow (token check + the SMTP send the server waits on before answering), and the
// callback set NO busy state, so the page sat visually dead for seconds. Google's button is inside
// Google's iframe and cannot be relabelled, hence a separate progress line beside it.
describe("Google sign-in progress feedback", () => {
  let fireGoogleCallback: (resp: { credential: string }) => Promise<void>;

  beforeEach(() => {
    vi.mocked(authService.getTwoFactorChallenge).mockRejectedValue(noChallenge());
    vi.mocked(authService.getGoogleConfig).mockResolvedValue({ enabled: true, clientId: "gid" });
    (window as unknown as { google: unknown }).google = {
      accounts: {
        id: {
          initialize: (cfg: { callback: (r: { credential: string }) => Promise<void> }) => {
            fireGoogleCallback = cfg.callback;
          },
          renderButton: vi.fn(),
        },
      },
    };
  });

  it("shows progress while the Google round trip is in flight, and clears it after", async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    loginWithGoogle.mockReturnValue(new Promise((r) => { resolveLogin = r; }));

    await render(<LoginPage />);
    await wait();

    // Nothing in flight yet.
    expect(document.body.textContent).not.toContain("Signing you in");

    void fireGoogleCallback({ credential: "tok" });
    await wait();

    expect(document.body.textContent).toContain("Signing you in");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    // Every other way in is locked, so a slow Google call cannot be raced.
    const logIn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Log In");
    expect((logIn as HTMLButtonElement)?.disabled).toBe(true);

    resolveLogin(PENDING);
    await wait();

    expect(byText("Check your email")).not.toBeNull();
  });

  it("clears the progress line when Google sign-in fails, so the button is usable again", async () => {
    loginWithGoogle.mockRejectedValue(new ApiError("Google sign-in failed.", 403));

    await render(<LoginPage />);
    await wait();
    await fireGoogleCallback({ credential: "tok" });
    await wait();

    expect(document.body.textContent).not.toContain("Signing you in");
    expect(byText("Google sign-in failed.")).not.toBeNull();
    const logIn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Log In");
    expect((logIn as HTMLButtonElement)?.disabled).toBe(false);
  });
});

// REGRESSION — the login page used to be held blank until GET /auth/2fa/challenge answered.
//
// That put a spinner in front of EVERY visitor on EVERY visit, for as long as the backend took,
// including everyone with 2FA switched off. The form now renders immediately and the probe runs
// beside it.
describe("credential form is never blocked on the challenge probe", () => {
  it("is usable immediately while a slow probe is still in flight", async () => {
    // Never resolves — the worst case of a cold or wedged backend.
    vi.mocked(authService.getTwoFactorChallenge).mockReturnValue(new Promise(() => {}));

    await render(<LoginPage />);
    await wait();

    expect(byText("Welcome Back")).not.toBeNull();
    const email = document.querySelector<HTMLInputElement>('input[autocomplete="email"]');
    const logIn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Log In");
    expect(email).not.toBeNull();
    expect((logIn as HTMLButtonElement)?.disabled).toBe(false);
  });

  it("can complete a 2FA-OFF sign-in without ever waiting for the probe", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockReturnValue(new Promise(() => {}));
    login.mockResolvedValue({
      twoFactorRequired: false,
      principal: { type: "admin", id: "a1", email: "a@x.com", permissions: ["*"] },
    });

    await render(<LoginPage />);
    await wait();
    await submitCredentials();

    expect(replace).toHaveBeenCalled();
  });

  it("still shows the credential form when the probe FAILS outright", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockRejectedValue(new Error("network down"));
    await render(<LoginPage />);
    await wait();

    expect(byText("Welcome Back")).not.toBeNull();
    // A probe failure is not the user's problem and must not be surfaced.
    expect(document.body.textContent).not.toContain("network down");
  });

  it("still swaps to the OTP step once a pending challenge resolves", async () => {
    vi.mocked(authService.getTwoFactorChallenge).mockResolvedValue(PENDING);
    await render(<LoginPage />);
    await wait();

    expect(byText("Check your email")).not.toBeNull();
  });
});
