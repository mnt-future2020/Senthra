// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";

// ── Settings → Storage ────────────────────────────────────────────────────────────────────────
//
// The ONE page where every storage provider is configured. Four properties carry the design:
//
//   • BOTH providers are always on screen. You must be able to set up and verify a provider while
//     the other one is still serving traffic — the page's earlier shape hid Spaces behind the radio,
//     which made "configure, then switch when ready" impossible to perform;
//   • CONFIGURING ≠ CHOOSING. A credential save must never move the active provider, and the way
//     that is guaranteed is that each card posts only its own fields;
//   • the SWITCH GUARD — selecting Spaces is refused until a test has passed for the values on
//     screen, because saving first and finding out later means every upload fails for everyone;
//   • the SECRETS — entered but never rendered back, because the server does not return them.
const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testStorage: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: h.toast }) }));
vi.mock("@/services/settings.service", () => ({
  getSettings: h.getSettings,
  updateSettings: h.updateSettings,
  testStorage: h.testStorage,
}));

import { StorageSection } from "./StorageSection";

const SECRET = "typed-secret-should-never-render";

const settings = (over: Record<string, unknown> = {}) => ({
  storageProvider: "cloudinary" as const,
  cloudinaryCloudName: "senthra-media",
  cloudinaryApiKey: "123456789012345",
  cloudinaryApiSecretSet: true,
  cloudinaryConfigured: true,
  spacesEndpoint: "https://ams3.digitaloceanspaces.com",
  spacesRegion: "ams3",
  spacesBucket: "senthra-prod",
  spacesAccessKeyId: "DO00EXAMPLE",
  spacesCdnUrl: "",
  spacesSecretKeySet: true,
  spacesConfigured: true,
  ...over,
});

const radio = (value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="storageProvider"][value="${value}"]`);
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
const inputWithValue = (value: string) =>
  Array.from(document.querySelectorAll("input")).find((i) => i.value === value)!;
const testResult = (id: string) => byTestId(`${id}-test-result`)?.textContent ?? "";

/**
 * Type into a controlled input.
 *
 * React tracks the value setter on the element, so assigning `.value` directly is invisible to it —
 * the change event fires and `onChange` never runs. Going through the prototype's own setter is what
 * makes React notice the value moved.
 */
const typeInto = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
};

/** Click through React's synthetic event system. */
const click = async (el: Element | null | undefined) => {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await wait();
};

const mounted = async () => {
  await render(<StorageSection />);
  await wait();
};

const dialog = () => document.querySelector('[role="dialog"]');
const dialogText = () => dialog()?.textContent ?? "";

/** Click Save on the active-provider card, then confirm the dialog it raises. */
const saveProviderConfirmed = async () => {
  await click(button("Save active provider"));
  await click(button("Change provider"));
};

/** Payload of the `updateSettings` call made by a given save. */
const savedPayload = (n = 0) => h.updateSettings.mock.calls[n]![0] as Record<string, unknown>;

beforeEach(() => {
  h.perms = new Set(["settings.view", "settings.manage"]);
  h.getSettings.mockReset().mockResolvedValue(settings());
  h.updateSettings.mockReset().mockImplementation(async (p: Record<string, unknown>) => settings(p));
  h.testStorage.mockReset().mockResolvedValue({ ok: true, message: "Connected to senthra-prod (ams3)." });
  h.toast.mockReset();
});
afterEach(cleanup);

describe("both providers are always configurable", () => {
  // The whole point of the page. Previously the Spaces fields appeared only once you had already
  // selected Spaces, and Cloudinary's lived on a different settings tab entirely.
  it("shows the Cloudinary and the Spaces fields together, whichever provider is active", async () => {
    await mounted();

    expect(document.body.textContent).toMatch(/Cloud name/i);
    expect(document.body.textContent).toMatch(/Access key ID/i);
    expect(document.body.textContent).toMatch(/Endpoint/i);
    expect(document.body.textContent).toMatch(/Bucket/i);
  });

  it("still shows both when Spaces is the active provider", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();

    expect(radio("spaces")!.checked).toBe(true);
    expect(document.body.textContent).toMatch(/Cloud name/i);
    expect(document.body.textContent).toMatch(/Access key ID/i);
  });

  it("does not hide a provider's fields when the radio moves", async () => {
    await mounted();
    await click(radio("spaces"));

    expect(document.body.textContent).toMatch(/Cloud name/i);
    expect(document.body.textContent).toMatch(/Access key ID/i);
  });

  it("gives each provider its own connection test", async () => {
    await mounted();
    expect(byTestId("cloudinary-test")).toBeTruthy();
    expect(byTestId("spaces-test")).toBeTruthy();
  });

  it("populates both providers' saved values", async () => {
    await mounted();
    expect(inputWithValue("senthra-media")).toBeTruthy();
    expect(inputWithValue("senthra-prod")).toBeTruthy();
  });
});

describe("configuring is not choosing", () => {
  // The guarantee that matters most on this page, and it is structural: the payload contains only
  // that card's fields, so there is no `storageProvider` for the server to act on.
  it("sends no storageProvider when Cloudinary credentials are saved", async () => {
    await mounted();
    await click(button("Save Cloudinary settings"));

    expect(savedPayload()).not.toHaveProperty("storageProvider");
    expect(savedPayload()).toMatchObject({ cloudinaryCloudName: "senthra-media" });
  });

  it("sends no storageProvider when Spaces credentials are saved", async () => {
    await mounted();
    await click(button("Save DigitalOcean Spaces settings"));

    expect(savedPayload()).not.toHaveProperty("storageProvider");
    expect(savedPayload()).toMatchObject({ spacesBucket: "senthra-prod" });
  });

  it("sends no credentials when the active provider is saved", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();
    await click(radio("cloudinary"));
    await saveProviderConfirmed();

    expect(savedPayload()).toEqual({ storageProvider: "cloudinary" });
  });

  // Saving Spaces credentials must not yank a pending selection back to what the server still holds.
  it("keeps a pending provider selection while credentials are saved", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(button("Save DigitalOcean Spaces settings"));

    expect(radio("spaces")!.checked).toBe(true);
  });

  it("can save Spaces credentials while Cloudinary is active, with no switch guard in the way", async () => {
    await mounted();
    expect(button("Save DigitalOcean Spaces settings")!.disabled).toBe(false);

    await click(button("Save DigitalOcean Spaces settings"));
    expect(h.toast).toHaveBeenCalledWith("DigitalOcean Spaces settings saved.");
  });
});

describe("the secrets", () => {
  it("are password fields, never readable ones", async () => {
    await mounted();

    const secrets = Array.from(document.querySelectorAll("input")).filter(
      (i) => i.placeholder?.includes("saved") || i.placeholder === "Secret key" || i.placeholder === "API secret",
    );
    expect(secrets).toHaveLength(2);
    for (const s of secrets) expect(s.type).toBe("password");
  });

  // The server returns `*Set` flags, never the secrets, so there is nothing to render back.
  it("render no stored value — only that one is saved", async () => {
    await mounted();

    expect(document.body.textContent).toMatch(/leave blank to keep/i);
    for (const input of Array.from(document.querySelectorAll("input"))) {
      expect(input.value).not.toContain(SECRET);
    }
  });

  it("are omitted from the save entirely when left blank", async () => {
    await mounted();
    await click(button("Save Cloudinary settings"));
    await click(button("Save DigitalOcean Spaces settings"));

    // Absent, not empty-string: the server reads a blank as "keep the stored one", and sending one
    // would be relying on that rather than saying it.
    expect(savedPayload(0)).not.toHaveProperty("cloudinaryApiSecret");
    expect(savedPayload(1)).not.toHaveProperty("spacesSecretKey");
  });

  it("are sent, and then cleared from the form, when one is typed", async () => {
    await mounted();
    await typeInto(
      Array.from(document.querySelectorAll("input")).find((i) => i.placeholder?.includes("saved"))!,
      SECRET,
    );
    await click(button("Save Cloudinary settings"));

    expect(savedPayload()).toMatchObject({ cloudinaryApiSecret: SECRET });
    for (const input of Array.from(document.querySelectorAll("input"))) {
      expect(input.value).not.toContain(SECRET);
    }
  });
});

describe("the connection tests", () => {
  it("test each provider independently, with the values on that card", async () => {
    await mounted();
    await click(byTestId("cloudinary-test"));
    await click(byTestId("spaces-test"));

    expect(h.testStorage.mock.calls[0]![0]).toMatchObject({
      provider: "cloudinary",
      cloudinaryCloudName: "senthra-media",
      cloudinaryApiKey: "123456789012345",
    });
    expect(h.testStorage.mock.calls[1]![0]).toMatchObject({
      provider: "spaces",
      spacesBucket: "senthra-prod",
      spacesRegion: "ams3",
    });
  });

  // Testing the provider that is NOT active is the normal case here — that is how you verify a new
  // provider before trusting it with uploads.
  it("tests Cloudinary even while Spaces is active", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();
    await click(byTestId("cloudinary-test"));

    expect(h.testStorage.mock.calls[0]![0]).toMatchObject({ provider: "cloudinary" });
  });

  it("reports each result against its own card", async () => {
    h.testStorage.mockImplementation(async ({ provider }: { provider: string }) =>
      provider === "cloudinary"
        ? { ok: true, message: 'Cloudinary is configured (cloud "senthra-media").' }
        : { ok: false, message: "Could not reach the bucket — access was denied." },
    );
    await mounted();
    await click(byTestId("cloudinary-test"));
    await click(byTestId("spaces-test"));

    expect(testResult("cloudinary")).toMatch(/senthra-media/i);
    expect(testResult("spaces")).toMatch(/access was denied/i);
  });

  it("surfaces a thrown error as a failure, not a silent no-op", async () => {
    h.testStorage.mockRejectedValue(new Error("Network unreachable"));
    await mounted();
    await click(byTestId("spaces-test"));

    expect(testResult("spaces")).toMatch(/network unreachable/i);
  });

  it("tests the values on screen, not the ones last saved", async () => {
    await mounted();
    await typeInto(inputWithValue("senthra-prod"), "a-different-bucket");
    await click(byTestId("spaces-test"));

    expect(h.testStorage.mock.calls[0]![0]).toMatchObject({ spacesBucket: "a-different-bucket" });
  });
});

describe("the switch guard", () => {
  const saveProvider = () => button("Save active provider");

  it("blocks making Spaces active before any test has passed", async () => {
    await mounted();
    await click(radio("spaces"));

    expect(saveProvider()!.disabled).toBe(true);
    expect(document.body.textContent).toMatch(/test the digitalocean spaces connection/i);
  });

  it("permits it once the Spaces test has passed", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));

    expect(saveProvider()!.disabled).toBe(false);
  });

  it("stays blocked when the Spaces test FAILS", async () => {
    h.testStorage.mockResolvedValue({ ok: false, message: "the secret key was rejected" });
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));

    expect(saveProvider()!.disabled).toBe(true);
  });

  // A Cloudinary pass says nothing about whether Spaces works.
  it("is not satisfied by a passing Cloudinary test", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("cloudinary-test"));

    expect(saveProvider()!.disabled).toBe(true);
  });

  // What was verified must be what gets saved. Editing after a pass invalidates it — the server
  // fingerprints the tested configuration and would refuse anyway, but the UI must not keep showing
  // a tick that no longer applies.
  it("clears a passing Spaces test when a Spaces field is edited afterwards", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    expect(saveProvider()!.disabled).toBe(false);

    await typeInto(inputWithValue("senthra-prod"), "a-different-bucket");

    expect(testResult("spaces")).toBe("");
    expect(saveProvider()!.disabled).toBe(true);
  });

  it("leaves a Spaces pass alone when a Cloudinary field is edited", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await typeInto(inputWithValue("senthra-media"), "another-cloud");

    expect(saveProvider()!.disabled).toBe(false);
  });

  // The one direction that must always stay open: Cloudinary is the default every install runs on.
  it("never blocks switching back to Cloudinary", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();
    await click(radio("cloudinary"));

    expect(saveProvider()!.disabled).toBe(false);
  });

  // It guards the SWITCH, not the credential cards. Locking those would make the guard
  // unsatisfiable — you could never fix the credentials that are failing the test.
  it("never blocks saving either provider's credentials", async () => {
    await mounted();
    await click(radio("spaces"));

    expect(button("Save Cloudinary settings")!.disabled).toBe(false);
    expect(button("Save DigitalOcean Spaces settings")!.disabled).toBe(false);
  });
});

describe("saving the active provider", () => {
  it("reflects the saved provider afterwards", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await saveProviderConfirmed();

    expect(h.toast).toHaveBeenCalledWith("Active storage provider saved.");
    expect(radio("spaces")!.checked).toBe(true);
  });

  it("shows the server's refusal rather than a generic failure", async () => {
    h.updateSettings.mockRejectedValue(
      new Error("Test the DigitalOcean Spaces connection before making it the active storage provider."),
    );
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await saveProviderConfirmed();

    expect(document.body.textContent).toMatch(/test the digitalocean spaces connection/i);
  });

  // The instinct on seeing a provider choice is that switching it MOVES things. It does not, and
  // the copy has to say so.
  it("says plainly that the setting applies to new uploads only", async () => {
    await mounted();
    expect(document.body.textContent).toMatch(/new uploads/i);
    expect(document.body.textContent).toMatch(/existing files|stay where they are/i);
  });
});

// ── The confirmation ──────────────────────────────────────────────────────────────────────────
//
// Deliberately NOT the same thing as the Spaces connection-test guard, and the two must not be
// collapsed into one. The guard answers "does this configuration actually work?"; the dialog asks
// "do you mean for new uploads to start going somewhere else?" A provider switch is reversible in
// one click, but its EFFECTS are not: every file uploaded in the meantime stays on the provider
// that took it, so each switch permanently splits the corpus. That is what the dialog names.
describe("the provider-change confirmation", () => {
  it("asks before switching Cloudinary -> Spaces", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await click(button("Save active provider"));

    expect(dialog()).toBeTruthy();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("asks before switching Spaces -> Cloudinary", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();
    await click(radio("cloudinary"));
    await click(button("Save active provider"));

    expect(dialog()).toBeTruthy();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  // Re-saving the provider already in force changes nothing, so there is nothing to warn about. A
  // dialog there would be noise, and noise is what teaches people to click through the one that
  // matters.
  it("does not ask when the provider is unchanged", async () => {
    await mounted();
    await click(button("Save active provider"));

    expect(dialog()).toBeFalsy();
    expect(savedPayload()).toEqual({ storageProvider: "cloudinary" });
  });

  it("performs the save on confirm", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await saveProviderConfirmed();

    expect(savedPayload()).toEqual({ storageProvider: "spaces" });
    expect(radio("spaces")!.checked).toBe(true);
  });

  it("saves nothing on cancel, and leaves the selection alone to try again", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await click(button("Save active provider"));
    await click(button("Cancel"));

    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(dialog()).toBeFalsy();
    expect(radio("spaces")!.checked).toBe(true);
  });

  // The dialog is a question, not a new code path. Confirming must send exactly what the bare save
  // sent before it existed — no migration flag, no second call, nothing that would touch assets.
  it("changes nothing about what a provider save does", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await saveProviderConfirmed();

    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(Object.keys(savedPayload())).toEqual(["storageProvider"]);
  });

  it("says existing files are not migrated", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await click(button("Save active provider"));

    expect(dialogText()).toMatch(/remain on the provider where they were originally stored/i);
    expect(dialogText()).toMatch(/not be migrated/i);
  });

  // Named in BOTH directions — the wording is generated from the target, not hard-coded for the
  // switch people were expected to make.
  it("names Spaces as the destination when switching to it", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await click(button("Save active provider"));

    expect(dialogText()).toMatch(/new uploads will use DigitalOcean Spaces/i);
  });

  it("names Cloudinary as the destination when switching to it", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces" }));
    await mounted();
    await click(radio("cloudinary"));
    await click(button("Save active provider"));

    expect(dialogText()).toMatch(/new uploads will use Cloudinary/i);
  });

  // The hole this closes: switching BACK to Cloudinary is ungated by design, so an install that has
  // been on Spaces for months can return to credentials nobody has checked since — and every upload
  // breaks with no warning at all.
  it("warns when the target provider is not configured", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces", cloudinaryConfigured: false }));
    await mounted();
    await click(radio("cloudinary"));
    await click(button("Save active provider"));

    expect(dialogText()).toMatch(/Cloudinary is not configured/i);
    expect(dialogText()).toMatch(/uploads may fail/i);
  });

  // Informational, not a gate. Refusing to return to Cloudinary would be the trap the backend's
  // asymmetry exists to avoid — the way back must always stay open.
  it("still allows the unconfigured switch once confirmed", async () => {
    h.getSettings.mockResolvedValue(settings({ storageProvider: "spaces", cloudinaryConfigured: false }));
    await mounted();
    await click(radio("cloudinary"));

    expect(button("Save active provider")!.disabled).toBe(false);
    await saveProviderConfirmed();
    expect(savedPayload()).toEqual({ storageProvider: "cloudinary" });
  });

  it("does not warn when the target IS configured", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(byTestId("spaces-test"));
    await click(button("Save active provider"));

    expect(dialogText()).not.toMatch(/not configured/i);
  });

  // The guard comes first, and the dialog never reaches past it.
  it("is never reached while the Spaces guard is blocking", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(button("Save active provider"));

    expect(dialog()).toBeFalsy();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it("does not appear for a credential save", async () => {
    await mounted();
    await click(radio("spaces"));
    await click(button("Save Cloudinary settings"));
    await click(button("Save DigitalOcean Spaces settings"));

    expect(dialog()).toBeFalsy();
    expect(h.updateSettings).toHaveBeenCalledTimes(2);
  });
});

describe("permissions", () => {
  it("is read-only for someone who can view but not manage settings", async () => {
    h.perms = new Set(["settings.view"]);
    await mounted();

    const fieldsets = Array.from(document.querySelectorAll("fieldset"));
    expect(fieldsets).toHaveLength(3);
    for (const f of fieldsets) expect(f.disabled).toBe(true);
  });
});
