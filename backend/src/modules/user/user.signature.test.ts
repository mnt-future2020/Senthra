import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure unit test of the self-service signature flow + the document reader. The repository,
// Cloudinary transport, audit log and settings are mocked — no DB / network.
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  findByEmailWithRole: vi.fn(),
  update: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn(), uploadFileToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getEmployeeIdPrefix: vi.fn(),
}));

import * as userRepo from "./user.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import {
  getSignatureForEmail,
  removeMySignature,
  uploadMySignature,
} from "./user.service.js";

const USER_ID = "a".repeat(24);
const CREDS = { cloudName: "c", apiKey: "k", apiSecret: "s" };
const actor = { id: USER_ID, email: "eng@x.com", type: "user" as const, permissions: [] };
// A valid 1×1 PNG data URI.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: "Ava",
    lastName: "Stone",
    email: "eng@x.com",
    jobTitle: "Field Engineer",
    role: null,
    signatureUrl: null,
    signatureName: null,
    signatureMimeType: null,
    signatureFileSize: null,
    signatureUploadedAt: null,
    signatureUpdatedAt: null,
    profileImageUrl: null,
    notes: null,
    status: "active",
    mustResetPassword: false,
    phone: null,
    employeeId: "SNT-0001",
    department: "Ops",
    dateOfJoining: null,
    gender: null,
    dateOfBirth: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = userRepo.findById as ReturnType<typeof vi.fn>;
const mockFindByEmail = userRepo.findByEmailWithRole as ReturnType<typeof vi.fn>;
const mockUpdate = userRepo.update as ReturnType<typeof vi.fn>;
const mockCreds = getCloudinaryCreds as ReturnType<typeof vi.fn>;
const mockUpload = uploadToCloudinary as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreds.mockResolvedValue(CREDS);
  mockUpload.mockResolvedValue({
    url: "https://cdn/senthra/signatures/signature-x.png",
    publicId: "senthra/signatures/signature-x",
    resourceType: "image",
  });
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve(userRow(data)),
  );
});

describe("uploadMySignature", () => {
  it("uploads to a deterministic publicId, derives mime/size, stamps timestamps + audits", async () => {
    mockFindById.mockResolvedValue(userRow());
    const result = await uploadMySignature({ signature: PNG, fileName: "sig.png" }, actor);

    expect(mockUpload).toHaveBeenCalledWith(PNG, `signature-${USER_ID}`, CREDS, "senthra/signatures");
    const data = mockUpdate.mock.calls[0][1];
    expect(data.signatureUrl).toMatch(/^https/);
    expect(data.signatureName).toBe("sig.png");
    expect(data.signatureMimeType).toBe("image/png");
    expect(data.signatureFileSize).toBeGreaterThan(0);
    expect(data.signatureUploadedAt).toBeInstanceOf(Date);
    expect(data.signatureUpdatedAt).toBeInstanceOf(Date);
    expect(result.signatureUrl).toMatch(/^https/);
    expect(mockAudit.mock.calls[0][0].action).toBe("user.signature_uploaded");
  });

  it("keeps the original uploadedAt on re-upload (only updatedAt moves)", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    mockFindById.mockResolvedValue(userRow({ signatureUrl: "https://old", signatureUploadedAt: first }));
    await uploadMySignature({ signature: PNG }, actor);
    expect(mockUpdate.mock.calls[0][1].signatureUploadedAt).toEqual(first);
  });

  it("rejects a non-staff actor (admin) before any upload", async () => {
    await expect(
      uploadMySignature({ signature: PNG }, { id: "x", email: "a@a", type: "admin", permissions: [] }),
    ).rejects.toThrow(/staff/i);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe("removeMySignature", () => {
  it("nulls all six signature fields + audits", async () => {
    mockFindById.mockResolvedValue(userRow({ signatureUrl: "https://x", signatureName: "s.png" }));
    await removeMySignature(actor);
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      signatureUrl: null,
      signatureName: null,
      signatureMimeType: null,
      signatureFileSize: null,
      signatureUploadedAt: null,
      signatureUpdatedAt: null,
    });
    expect(mockAudit.mock.calls[0][0].action).toBe("user.signature_removed");
  });
});

describe("getSignatureForEmail (document reader)", () => {
  it("returns the signer block when a signature exists (email lowercased)", async () => {
    mockFindByEmail.mockResolvedValue(
      userRow({ signatureUrl: "https://cdn/sig.png", signatureMimeType: "image/png" }),
    );
    const sig = await getSignatureForEmail("ENG@x.com");
    expect(mockFindByEmail).toHaveBeenCalledWith("eng@x.com");
    expect(sig).toEqual({
      signerName: "Ava Stone",
      jobTitle: "Field Engineer",
      url: "https://cdn/sig.png",
      mimeType: "image/png",
    });
  });

  it("returns null when the signer has no (non-deleted) account", async () => {
    mockFindByEmail.mockResolvedValue(null);
    expect(await getSignatureForEmail("ghost@x.com")).toBeNull();
  });

  it("returns null when the signer has no signature on file", async () => {
    mockFindByEmail.mockResolvedValue(userRow({ signatureUrl: null }));
    expect(await getSignatureForEmail("eng@x.com")).toBeNull();
  });

  it("returns null for a blank/absent signer email — never hits the DB", async () => {
    expect(await getSignatureForEmail(null)).toBeNull();
    expect(await getSignatureForEmail("")).toBeNull();
    expect(mockFindByEmail).not.toHaveBeenCalled();
  });
});
