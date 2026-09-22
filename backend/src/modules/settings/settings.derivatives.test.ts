import type { Settings } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Derivative generation on a provider that CANNOT transform at delivery — and, above all, what
// happens when it fails. `sharp` is a native binary: when its prebuilt artifact does not match the
// host it throws on import, and an undecodable source throws on use. Neither may cost the
// administrator the logo they just uploaded, which has already been stored by then.
vi.mock("./settings.repository.js", () => ({ getOrCreate: vi.fn(), update: vi.fn() }));
const { upload, generateDerivatives } = vi.hoisted(() => ({ upload: vi.fn(), generateDerivatives: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({
  // Spaces-shaped: it stores opaque bytes, so derivatives must be rendered at upload time.
  findActiveStorage: vi.fn(async () => ({ upload, transformsOnDelivery: false, id: "spaces" })),
}));
vi.mock("../../lib/storage/derivatives.js", () => ({ generateDerivatives }));
vi.mock("../../utils/crypto.js", () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string | null) => v }));

import * as settingsRepo from "./settings.repository.js";

import { getPurchaseOrderDocumentBranding, updateSettings, uploadBrandingImage } from "./settings.service.js";

const row = (over: Partial<Settings> = {}) => ({ id: "s1", ...over }) as Settings;
const mockGet = vi.mocked(settingsRepo.getOrCreate);
const mockUpdate = vi.mocked(settingsRepo.update);
const image = "data:image/png;base64,iVBORw0KGgo=";
const stored = (name: string) => ({
  url: `https://files.example.com/senthra/branding/${name}.png`,
  publicId: `senthra/branding/${name}`,
  resourceType: "image",
  provider: "spaces",
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(row());
  mockUpdate.mockImplementation(async (_id, data) => row(data as Partial<Settings>));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("uploadBrandingImage — derivatives on a store-only provider", () => {
  it("persists both generated derivative URLs for the app logo", async () => {
    upload.mockResolvedValue(stored("logo"));
    generateDerivatives.mockResolvedValue({ pdf: "https://files.example.com/logo__pdf.png", email: "https://files.example.com/logo__email.png" });
    await uploadBrandingImage("logo", image);
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      logoUrl: "https://files.example.com/senthra/branding/logo.png",
      logoPdfUrl: "https://files.example.com/logo__pdf.png",
      logoEmailUrl: "https://files.example.com/logo__email.png",
    });
  });

  // ── The isolation rule ───────────────────────────────────────────────────────────────────────
  //
  // By the time a derivative can fail, the ORIGINAL IS ALREADY STORED. Turning that into a 500
  // tells the administrator their upload failed while the object sits in the bucket — and on a
  // host with a bad `sharp` binary it makes branding permanently unusable. A missing derivative is
  // a degraded render; a failed upload is a broken screen. Degrade.
  it("keeps the upload when derivative generation throws, storing null derivatives", async () => {
    upload.mockResolvedValue(stored("logo"));
    generateDerivatives.mockRejectedValue(new Error("Could not load the sharp module"));

    const out = await uploadBrandingImage("logo", image);

    expect(out.url).toBe("https://files.example.com/senthra/branding/logo.png");
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      logoUrl: "https://files.example.com/senthra/branding/logo.png",
      logoPdfUrl: null,
      logoEmailUrl: null,
    });
  });

  it("logs the derivative failure rather than swallowing it silently", async () => {
    upload.mockResolvedValue(stored("logo"));
    generateDerivatives.mockRejectedValue(new Error("Could not load the sharp module"));
    await uploadBrandingImage("logo", image);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]!.join(" "))).toContain("Could not load the sharp module");
  });

  it("keeps the PO logo upload too, storing a null derivative", async () => {
    upload.mockResolvedValue(stored("po-logo"));
    generateDerivatives.mockRejectedValue(new Error("unsupported image format"));
    await uploadBrandingImage("po_logo", image);
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      poDocLogoUrl: "https://files.example.com/senthra/branding/po-logo.png",
      poDocLogoPdfUrl: null,
    });
  });

  // The other half of the same rule, and the reason the catch must not be widened: a failure to
  // store the ORIGINAL is a real failure and has to keep surfacing as one.
  it("still fails when the original upload itself fails", async () => {
    upload.mockRejectedValue(new Error("File storage isn't configured correctly"));
    await expect(uploadBrandingImage("logo", image)).rejects.toThrow("File storage isn't configured correctly");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // A favicon is a browser-only asset with no derivative intents, so nothing is generated and
  // nothing can fail — the generator must not even be reached.
  it("never generates anything for a favicon", async () => {
    upload.mockResolvedValue(stored("favicon"));
    await uploadBrandingImage("favicon", image);
    expect(generateDerivatives).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ faviconUrl: "https://files.example.com/senthra/branding/favicon.png" });
  });
});

/**
 * A derivative describes ONE source image. The moment that source is written through settings, the
 * description stops being true — so it has to go with it.
 *
 * This is not only about clearing. `updateSettings` is the one path that can write a logo URL
 * WITHOUT generating anything (only the branding upload does that), so any value it writes leaves a
 * derivative that no longer matches. Left behind, it is not merely stale: every renderer PREFERS
 * the derivative over the original, so a removed logo would keep being printed on purchase orders.
 */
describe("updateSettings — writing a source logo invalidates its derivatives", () => {
  it("nulls both app-logo derivatives when the logo is cleared", async () => {
    mockGet.mockResolvedValue(
      row({ logoUrl: "https://files.example.com/logo.svg", logoPdfUrl: "https://x/__pdf.png", logoEmailUrl: "https://x/__email.png" }),
    );
    await updateSettings({ logoUrl: "" });
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ logoUrl: null, logoPdfUrl: null, logoEmailUrl: null });
  });

  // The same rule for a REPLACEMENT, which is the case a clear-only fix would miss: the new logo has
  // no derivatives, and the old one's would otherwise be printed in its place.
  it("nulls both app-logo derivatives when the logo is replaced with a different URL", async () => {
    mockGet.mockResolvedValue(
      row({ logoUrl: "https://files.example.com/old.svg", logoPdfUrl: "https://x/old__pdf.png", logoEmailUrl: "https://x/old__email.png" }),
    );
    await updateSettings({ logoUrl: "https://files.example.com/new.svg" });
    expect(mockUpdate.mock.calls[0]![1]).toEqual({
      logoUrl: "https://files.example.com/new.svg",
      logoPdfUrl: null,
      logoEmailUrl: null,
    });
  });

  it("nulls the PO logo's derivative when the PO logo is written", async () => {
    mockGet.mockResolvedValue(row({ poDocLogoUrl: "https://cdn/po.png", poDocLogoPdfUrl: "https://x/po__pdf.png" }));
    await updateSettings({ poDocLogoUrl: "" });
    expect(mockUpdate.mock.calls[0]![1]).toEqual({ poDocLogoUrl: null, poDocLogoPdfUrl: null });
  });

  // Each logo owns only its own derivatives. Clearing the PO logo must not disturb the app logo's,
  // which still describe an app logo that is still set.
  it("leaves the other logo's derivatives alone", async () => {
    mockGet.mockResolvedValue(row({ logoUrl: "https://cdn/app.png", logoPdfUrl: "https://x/app__pdf.png" }));
    await updateSettings({ poDocLogoUrl: "" });
    const data = mockUpdate.mock.calls[0]![1];
    expect(data).not.toHaveProperty("logoPdfUrl");
    expect(data).not.toHaveProperty("logoEmailUrl");
  });

  it("touches no derivative when neither source logo is part of the update", async () => {
    mockGet.mockResolvedValue(row({ logoUrl: "https://cdn/app.png", logoPdfUrl: "https://x/app__pdf.png" }));
    await updateSettings({ brandName: "Senthra" });
    const data = mockUpdate.mock.calls[0]![1];
    expect(data).not.toHaveProperty("logoPdfUrl");
    expect(data).not.toHaveProperty("logoEmailUrl");
    expect(data).not.toHaveProperty("poDocLogoPdfUrl");
  });

  // THE CONSEQUENCE, stated at the boundary that would suffer it. Feed the row this update leaves
  // behind to the PO document's branding reader: with the derivative columns cleared there is
  // nothing for it to prefer, so a removed logo cannot reappear on a supplier-facing PDF.
  it("leaves the PDF branding reader nothing stale to select", async () => {
    mockGet.mockResolvedValue(
      row({ logoUrl: "https://files.example.com/logo.svg", logoPdfUrl: "https://x/__pdf.png", logoEmailUrl: "https://x/__email.png" }),
    );
    const cleared = await updateSettings({ logoUrl: "" });
    expect(cleared.logoUrl).toBe("");

    mockGet.mockResolvedValue(row(mockUpdate.mock.calls[0]![1] as Partial<Settings>));
    await expect(getPurchaseOrderDocumentBranding()).resolves.toMatchObject({ logoUrl: "", logoPdfUrl: null });
  });
});
