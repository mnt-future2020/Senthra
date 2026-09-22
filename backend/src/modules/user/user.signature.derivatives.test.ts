import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The signature upload on a provider that CANNOT transform at delivery, where a pdfkit-safe raster
// has to be generated at upload time — and, above all, what happens when that generation fails.
// `sharp` is a native binary: it throws on IMPORT when its prebuilt artifact does not match the
// host, and on use for a source it cannot decode. Neither may cost the user the signature they have
// already successfully uploaded.
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  findByEmailWithRole: vi.fn(),
  findNamesByEmails: vi.fn(),
  update: vi.fn(),
}));
vi.mock("#modules/auth/admin.repository.js", () => ({ findNamesByEmails: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
const { mockUpload, generateDerivatives } = vi.hoisted(() => ({ mockUpload: vi.fn(), generateDerivatives: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({
  // Spaces-shaped: stores opaque bytes, so the raster must be rendered here rather than on delivery.
  findActiveStorage: vi.fn(async () => ({ upload: mockUpload, transformsOnDelivery: false, id: "spaces" })),
}));
vi.mock("../../lib/storage/derivatives.js", () => ({
  generateDerivatives,
  derivativeKey: (publicId: string) => `${publicId}__pdf.png`,
}));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getEmployeeIdPrefix: vi.fn(),
}));

import * as userRepo from "./user.repository.js";

import { uploadMySignature } from "./user.service.js";

const USER_ID = "a".repeat(24);
const actor = { id: USER_ID, email: "eng@x.com", type: "user" as const, permissions: [] };
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const mockFindById = userRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = userRepo.update as ReturnType<typeof vi.fn>;

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({ id: USER_ID, email: "eng@x.com", signatureUrl: null, signatureUploadedAt: null });
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve({
      id: USER_ID,
      firstName: "Ava",
      lastName: "Stone",
      email: "eng@x.com",
      status: "active",
      role: null,
      mustResetPassword: false,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
      ...data,
    }),
  );
  mockUpload.mockResolvedValue({
    url: "https://files.example.com/senthra/signatures/sig.png",
    publicId: `senthra/signatures/signature-${USER_ID}`,
    resourceType: "image",
    provider: "spaces",
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("uploadMySignature — derivatives on a store-only provider", () => {
  it("persists the generated derivative URL alongside the provider that stored it", async () => {
    generateDerivatives.mockResolvedValue({ pdf: "https://files.example.com/sig__pdf.png" });
    await uploadMySignature({ signature: PNG, fileName: "sig.png" }, actor);
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      signatureUrl: "https://files.example.com/senthra/signatures/sig.png",
      signaturePdfUrl: "https://files.example.com/sig__pdf.png",
      signatureProvider: "spaces",
    });
  });

  // ── The isolation rule ───────────────────────────────────────────────────────────────────────
  //
  // The signature IS ALREADY STORED by the time a derivative can fail. Rejecting here would tell
  // the user their upload failed while the object sits in the bucket, and on a host with a bad
  // `sharp` binary it would make signatures permanently impossible to set. A null derivative only
  // costs the PDF its rasterised variant, which falls back to the original.
  it("keeps the signature when derivative generation throws, storing a null derivative", async () => {
    generateDerivatives.mockRejectedValue(new Error("Could not load the sharp module"));

    const out = await uploadMySignature({ signature: PNG, fileName: "sig.png" }, actor);

    expect(out.signatureUrl).toBe("https://files.example.com/senthra/signatures/sig.png");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      signatureUrl: "https://files.example.com/senthra/signatures/sig.png",
      signaturePdfUrl: null,
      // Still recorded: the ORIGINAL was stored on this provider, and a later delete has to find it.
      signatureProvider: "spaces",
    });
  });

  it("logs the derivative failure rather than swallowing it silently", async () => {
    generateDerivatives.mockRejectedValue(new Error("Could not load the sharp module"));
    await uploadMySignature({ signature: PNG }, actor);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]!.join(" "))).toContain("Could not load the sharp module");
  });

  // The other half of the rule, and why the catch must stay narrow: failing to store the ORIGINAL
  // is a real failure and has to keep surfacing as one.
  it("still fails when the signature upload itself fails", async () => {
    mockUpload.mockRejectedValue(new Error("File storage isn't configured correctly"));
    await expect(uploadMySignature({ signature: PNG }, actor)).rejects.toThrow(
      "File storage isn't configured correctly",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
