// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byLabel, cleanup, click, render, wait } from "@/test/dom";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  get: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: h.toast }) }));
vi.mock("@/providers/NavigationGuardProvider", () => ({ useReportDirty: () => {} }));
vi.mock("@/services/settings.service", () => ({ getSettings: h.get, updateSettings: h.update }));
vi.mock("@/services/branding.service", () => ({ uploadBrandingImage: h.upload }));
vi.mock("@/lib/image", () => ({
  MAX_IMAGE_BYTES: 2 * 1024 * 1024,
  shrinkImage: async (f: File) => f,
  readFileAsDataUrl: async () => "data:image/png;base64,AAAA",
}));

import { PoDocumentBrandingCard } from "./PoDocumentBrandingCard";

const settings = (over: Record<string, unknown> = {}) => ({
  brandColor: "#7b6ef0",
  logoUrl: "https://cdn/app-logo.png",
  poDocLogoUrl: "",
  poDocAccentColor: "",
  ...over,
});

async function typeInto(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const buttonByText = (t: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === t);
const text = () => document.body.textContent ?? "";

async function mount() {
  await render(<PoDocumentBrandingCard />);
  await wait();
}

beforeEach(() => {
  h.perms = new Set(["settings.view", "settings.manage"]);
  h.get.mockReset().mockResolvedValue(settings());
  h.update.mockReset().mockImplementation(async (patch: Record<string, unknown>) => settings(patch));
  h.upload.mockReset();
  h.toast.mockReset();
});
afterEach(cleanup);

describe("PoDocumentBrandingCard", () => {
  it("shows the app-branding fallback when nothing PO-specific is configured", async () => {
    await mount();
    expect(text()).toContain("Not set — PO documents use the app logo.");
    expect(text()).toContain("Not set — PO documents use the app brand colour");
    expect(text()).toContain("#7b6ef0");
    expect(document.querySelector("img[alt='PO logo']")).toBeNull();
  });

  it("says the PDF prints the company name when there is no logo anywhere", async () => {
    h.get.mockResolvedValue(settings({ logoUrl: "" }));
    await mount();
    expect(text()).toContain("PO documents print the company name");
  });

  it("shows the configured PO logo and colour, with no fallback notes", async () => {
    h.get.mockResolvedValue(settings({ poDocLogoUrl: "https://cdn/po-logo.png", poDocAccentColor: "#1f3a8a" }));
    await mount();
    expect(document.querySelector("img[alt='PO logo']")?.getAttribute("src")).toBe("https://cdn/po-logo.png");
    expect((byLabel("PO accent colour") as HTMLInputElement).value).toBe("#1f3a8a");
    expect(text()).not.toContain("Not set");
  });

  it("saves a valid accent colour", async () => {
    await mount();
    await typeInto(byLabel("PO accent colour"), "#1f3a8a");
    await click(buttonByText("Save PO colour"));
    expect(h.update).toHaveBeenCalledWith({ poDocAccentColor: "#1f3a8a" });
  });

  it("refuses a colour the PDF cannot draw, without saving", async () => {
    await mount();
    await typeInto(byLabel("PO accent colour"), "#11223344");
    await click(buttonByText("Save PO colour"));
    expect(h.update).not.toHaveBeenCalled();
    expect(text()).toContain("Use a hex colour like #1f3a8a");
  });

  it("goes back to the app colour with 'Use app colour'", async () => {
    h.get.mockResolvedValue(settings({ poDocAccentColor: "#1f3a8a" }));
    await mount();
    await click(buttonByText("Use app colour"));
    await click(buttonByText("Save PO colour"));
    expect(h.update).toHaveBeenCalledWith({ poDocAccentColor: "" });
  });

  it("uploads the PO logo through the dedicated upload type — never the app logo", async () => {
    h.upload.mockResolvedValue({ url: "https://cdn/po-logo.png", settings: settings({ poDocLogoUrl: "https://cdn/po-logo.png" }) });
    await mount();
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["x"], "logo.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait();
    expect(h.upload).toHaveBeenCalledWith("po_logo", "data:image/png;base64,AAAA");
    expect(document.querySelector("img[alt='PO logo']")?.getAttribute("src")).toBe("https://cdn/po-logo.png");
  });

  it("removes the PO logo by clearing it", async () => {
    h.get.mockResolvedValue(settings({ poDocLogoUrl: "https://cdn/po-logo.png" }));
    await mount();
    await click(buttonByText("Remove"));
    expect(h.update).toHaveBeenCalledWith({ poDocLogoUrl: "" });
    expect(text()).toContain("Not set — PO documents use the app logo.");
  });

  it("is read-only without settings.manage", async () => {
    h.perms = new Set(["settings.view"]);
    await mount();
    expect((document.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  });
});
