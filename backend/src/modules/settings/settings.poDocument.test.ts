import type { Settings } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PO document branding — the purchase order PDF's OWN logo + accent colour (Settings → Purchase Orders).
// Unset, the PDF falls back to the app branding, so an install that never configures them is unchanged.
vi.mock("./settings.repository.js", () => ({ getOrCreate: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../utils/crypto.js", () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string | null) => v }));

import * as settingsRepo from "./settings.repository.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
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
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "https://cdn/app.png", accentColor: "#123456" });
  });

  it("falls back to the default brand colour — and no logo — on a fresh install", async () => {
    mockGet.mockResolvedValue(row());
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "", accentColor: "#7b6ef0" });
  });

  it("uses the PO-specific logo and accent when they are set", async () => {
    mockGet.mockResolvedValue(
      row({ logoUrl: "https://cdn/app.png", brandColor: "#123456", poDocLogoUrl: "https://cdn/po.png", poDocAccentColor: "#0a0" }),
    );
    await expect(getPurchaseOrderDocumentBranding()).resolves.toEqual({ logoUrl: "https://cdn/po.png", accentColor: "#0a0" });
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

  it("clears the PO logo with an empty string", async () => {
    mockGet.mockResolvedValue(row({ poDocLogoUrl: "https://cdn/po.png" }));
    await updateSettings({ poDocLogoUrl: "" });
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ poDocLogoUrl: null });
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
    vi.mocked(uploadToCloudinary).mockResolvedValue({ url: "https://res.cloudinary.com/cloud/po-logo.png", publicId: "senthra/branding/po-logo", resourceType: "image" });
    const out = await uploadBrandingImage("po_logo", image);
    expect(vi.mocked(uploadToCloudinary).mock.calls[0]![1]).toBe("po-logo");
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ poDocLogoUrl: "https://res.cloudinary.com/cloud/po-logo.png" });
    expect(out.url).toBe("https://res.cloudinary.com/cloud/po-logo.png");
  });

  it("still writes the app logo for a plain logo upload", async () => {
    mockGet.mockResolvedValue(row(creds));
    vi.mocked(uploadToCloudinary).mockResolvedValue({ url: "https://res.cloudinary.com/cloud/logo.png", publicId: "senthra/branding/logo", resourceType: "image" });
    await uploadBrandingImage("logo", image);
    expect(vi.mocked(uploadToCloudinary).mock.calls[0]![1]).toBe("logo");
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ logoUrl: "https://res.cloudinary.com/cloud/logo.png" });
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
