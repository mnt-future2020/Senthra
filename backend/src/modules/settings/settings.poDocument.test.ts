import type { Settings } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PO document branding — the purchase order PDF's OWN logo + accent colour (Settings → Purchase Orders).
// Unset, the PDF falls back to the app branding, so an install that never configures them is unchanged.
vi.mock("./settings.repository.js", () => ({ getOrCreate: vi.fn(), update: vi.fn() }));
const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({
  // Cloudinary: it rasterises on delivery, so nothing is stored and the derivative columns stay null.
  findActiveStorage: vi.fn(async () => ({ upload, transformsOnDelivery: true })),
}));
vi.mock("../../utils/crypto.js", () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string | null) => v }));

import * as settingsRepo from "./settings.repository.js";

import {
  getBranding,
  getPurchaseOrderDocumentBranding,
  getSettings,
  updateSettings,
  uploadBrandingImage,
} from "./settings.service.js";
import { updateSettingsSchema, uploadBrandingSchema } from "./settings.validation.js";

const row = (over: Partial<Settings> = {}) => ({ id: "s1", ...over }) as Settings;
const mockGet = vi.mocked(settingsRepo.getOrCreate);
const mockUpdate = vi.mocked(settingsRepo.update);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation(async (_id, data) => row(data as Partial<Settings>));
});

describe("getPurchaseOrderDocumentBranding", () => {
  it("falls back to the app logo and brand colour when nothing PO-specific is set", async () => {
    mockGet.mockResolvedValue(row({ logoUrl: "https://cdn/app.png", brandColor: "#123456" }));
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "https://cdn/app.png", logoPdfUrl: null, accentColor: "#123456" });
  });

  it("falls back to the default brand colour — and no logo — on a fresh install", async () => {
    mockGet.mockResolvedValue(row());
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "", logoPdfUrl: null, accentColor: "#7b6ef0" });
  });

  it("uses the PO-specific logo and accent when they are set", async () => {
    mockGet.mockResolvedValue(
      row({ logoUrl: "https://cdn/app.png", brandColor: "#123456", poDocLogoUrl: "https://cdn/po.png", poDocAccentColor: "#0a0" }),
    );
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "https://cdn/po.png", logoPdfUrl: null, accentColor: "#0a0" });
  });

  it("ignores a stored accent the PDF engine cannot draw", async () => {
    mockGet.mockResolvedValue(row({ brandColor: "#123456", poDocAccentColor: "#11223344" }));
    await expect(getPurchaseOrderDocumentBranding()).resolves.toMatchObject({ accentColor: "#123456" });
  });

  // The FALLBACK is the app brand colour — and THAT field accepts the CSS alpha forms (#rgba,
  // #rrggbbaa) the PDF engine cannot draw, so it is normalised on the way through, never mis-printed.
  it.each([
    ["#abc", "#abc"],
    ["#123456", "#123456"],
    ["#abcd", "#aabbcc"],
    ["#11223344", "#112233"],
  ])("makes app brand color %s safe for PDFKit as %s", async (brandColor, accentColor) => {
    mockGet.mockResolvedValue(row({ brandColor }));
    await expect(getPurchaseOrderDocumentBranding()).resolves.toMatchObject({ accentColor });
  });
});

describe("updateSettings — PO document branding", () => {
  it("stores a valid accent, and an empty string clears it back to the app colour", async () => {
    mockGet.mockResolvedValue(row());
    await updateSettings({ poDocAccentColor: " #1F3A8A " });
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ poDocAccentColor: "#1F3A8A" });

    await updateSettings({ poDocAccentColor: "" });
    expect(mockUpdate.mock.calls[1]![1]).toEqual({ poDocAccentColor: null });
  });

  it("clears the PO logo with an empty string — and its stored derivative with it", async () => {
    mockGet.mockResolvedValue(row({ poDocLogoUrl: "https://cdn/po.png" }));
    await updateSettings({ poDocLogoUrl: "" });
    // The derivative describes the logo being cleared, and the PDF renderer PREFERS it over the
    // original — so leaving it set would keep printing a logo that has just been removed. See
    // settings.derivatives.test.ts for the full rule.
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ poDocLogoUrl: null, poDocLogoPdfUrl: null });
  });

  it("never touches the app's own brand colour or logo", async () => {
    mockGet.mockResolvedValue(row({ brandColor: "#123456", logoUrl: "https://cdn/app.png" }));
    await updateSettings({ poDocAccentColor: "#0a0", poDocLogoUrl: "" });
    const data = mockUpdate.mock.calls[0]![1];
    expect(data).not.toHaveProperty("brandColor");
    expect(data).not.toHaveProperty("logoUrl");
  });

  it("returns the stored overrides on the authenticated settings — never on the public branding", async () => {
    mockGet.mockResolvedValue(row({ poDocLogoUrl: "https://cdn/po.png", poDocAccentColor: "#0a0" }));
    await expect(getSettings()).resolves.toMatchObject({ poDocLogoUrl: "https://cdn/po.png", poDocAccentColor: "#0a0" });
    const publicBranding = await getBranding();
    expect(publicBranding).not.toHaveProperty("poDocLogoUrl");
    expect(publicBranding).not.toHaveProperty("poDocAccentColor");
  });

  it("reports unset overrides as empty strings", async () => {
    mockGet.mockResolvedValue(row());
    await expect(getSettings()).resolves.toMatchObject({ poDocLogoUrl: "", poDocAccentColor: "" });
  });
});

describe("uploadBrandingImage — the PO logo", () => {
  const creds = { cloudinaryCloudName: "cloud", cloudinaryApiKey: "key", cloudinaryApiSecret: "secret" };
  const image = "data:image/png;base64,iVBORw0KGgo=";

  it("uploads to its OWN asset and saves only the PO logo", async () => {
    mockGet.mockResolvedValue(row(creds));
    upload.mockResolvedValue({ url: "https://res.cloudinary.com/cloud/po-logo.png", publicId: "senthra/branding/po-logo", resourceType: "image", provider: "cloudinary" });
    const out = await uploadBrandingImage("po_logo", image);
    expect(upload.mock.calls[0]![1]).toBe("po-logo");
    // The derivative column is written EXPLICITLY null on this provider, not left absent: null is
    // what the renderers read as "use the delivery transform".
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      poDocLogoUrl: "https://res.cloudinary.com/cloud/po-logo.png",
      poDocLogoPdfUrl: null,
    });
    expect(out.url).toBe("https://res.cloudinary.com/cloud/po-logo.png");
  });

  it("still writes the app logo for a plain logo upload", async () => {
    mockGet.mockResolvedValue(row(creds));
    upload.mockResolvedValue({ url: "https://res.cloudinary.com/cloud/logo.png", publicId: "senthra/branding/logo", resourceType: "image", provider: "cloudinary" });
    await uploadBrandingImage("logo", image);
    expect(upload.mock.calls[0]![1]).toBe("logo");
    // Both of the app logo's derivative columns are written explicitly null on this provider —
    // it rasterises on delivery, so there is nothing to store.
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      logoUrl: "https://res.cloudinary.com/cloud/logo.png",
      logoPdfUrl: null,
      logoEmailUrl: null,
    });
  });
});

describe("settings validation — PO document branding", () => {
  it.each(["#abc", "#AABBCC", "#1f3a8a", ""])("accepts the accent %j", (v) => {
    expect(updateSettingsSchema.safeParse({ poDocAccentColor: v }).success).toBe(true);
  });

  it.each(["#abcd", "#11223344", "red", "#12345", "1f3a8a"])("refuses the accent %j (the PDF cannot draw it)", (v) => {
    expect(updateSettingsSchema.safeParse({ poDocAccentColor: v }).success).toBe(false);
  });

  it("only lets the PO logo be cleared, never pointed at a typed URL", () => {
    expect(updateSettingsSchema.safeParse({ poDocLogoUrl: "" }).success).toBe(true);
    expect(updateSettingsSchema.safeParse({ poDocLogoUrl: "https://evil.example/x.png" }).success).toBe(false);
  });

  it("accepts the po_logo upload type alongside the existing two", () => {
    for (const type of ["logo", "favicon", "po_logo"]) {
      expect(uploadBrandingSchema.safeParse({ type, image: "data:image/png;base64,AAAA" }).success).toBe(true);
    }
    expect(uploadBrandingSchema.safeParse({ type: "po", image: "data:image/png;base64,AAAA" }).success).toBe(false);
  });
});

// ── Derivatives are generated only where they are needed ──────────────────────────────────────
//
// A provider that transforms at delivery needs no stored variant, so nothing extra is uploaded and
// the derivative columns stay null. That is not merely an optimisation: downloading and re-uploading
// a Cloudinary logo to produce a copy of something Cloudinary already generates on demand would be
// pure waste, and would leave a second object nothing tracks.
describe("uploadBrandingImage — derivative generation is provider-driven", () => {
  it("uploads ONLY the source when the provider transforms at delivery", async () => {
    upload.mockResolvedValue({
      url: "https://res.cloudinary.com/cloud/logo.png",
      publicId: "senthra/branding/logo",
      resourceType: "image",
      provider: "cloudinary",
    });

    await uploadBrandingImage("logo", "data:image/png;base64,AAAA");

    // One call: the logo. No __pdf.png, no __email.png.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![1]).toBe("logo");
  });

  it("writes null derivatives rather than leaving the columns absent", async () => {
    upload.mockResolvedValue({
      url: "https://res.cloudinary.com/cloud/logo.png",
      publicId: "senthra/branding/logo",
      resourceType: "image",
      provider: "cloudinary",
    });

    await uploadBrandingImage("logo", "data:image/png;base64,AAAA");

    // Explicit null is what the renderers read as "use the delivery transform". An absent column
    // would mean the same today and stop meaning it the moment a stale value survived a re-upload.
    expect(mockUpdate.mock.calls[0]![1]).toMatchObject({ logoPdfUrl: null, logoEmailUrl: null });
  });

  it("never generates anything for the favicon, which no renderer rasterises", async () => {
    upload.mockResolvedValue({
      url: "https://res.cloudinary.com/cloud/favicon.png",
      publicId: "senthra/branding/favicon",
      resourceType: "image",
      provider: "cloudinary",
    });

    await uploadBrandingImage("favicon", "data:image/png;base64,AAAA");

    expect(upload).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ faviconUrl: "https://res.cloudinary.com/cloud/favicon.png" });
  });
});
