import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signature removal through the REAL `attachment.service#releaseAsset`.
 *
 * user.signature.test.ts mocks that service to assert the delegation; this file leaves it in place
 * and mocks only the two things underneath it — the reference count and the Cloudinary transport —
 * so the wiring that actually decides whether a file is destroyed is exercised end to end.
 *
 * Without this, "removal destroys the asset" would be proved only against a stub, and the rule that
 * matters most (never destroy something still referenced) would not be tested at all for signatures.
 */
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  findByEmailWithRole: vi.fn(),
  findNamesByEmails: vi.fn(),
  update: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
const { mockUpload, mockDestroy } = vi.hoisted(() => ({ mockUpload: vi.fn(), mockDestroy: vi.fn() }));
// BOTH halves of the storage layer: `findActiveStorage` for the upload, `getStorageFor` for the
// release — and they are separate on purpose, because a release must resolve the provider from the
// ASSET rather than from whichever provider is currently active.
vi.mock("../../lib/storage/index.js", () => ({
  findActiveStorage: vi.fn(async () => ({ upload: mockUpload, transformsOnDelivery: true })),
  getStorageFor: vi.fn(),
  normalizeProviderId: (v: string | null | undefined) => (v === "spaces" ? "spaces" : "cloudinary"),
}));
vi.mock("#modules/attachment/attachment.repository.js", () => ({ countRefs: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getEmployeeIdPrefix: vi.fn(),
}));

import * as userRepo from "./user.repository.js";
import * as attachmentRepo from "#modules/attachment/attachment.repository.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { getStorageFor } from "../../lib/storage/index.js";
import { removeMySignature } from "./user.service.js";

const USER_ID = "a".repeat(24);
const CREDS = { cloudName: "c", apiKey: "k", apiSecret: "s" };
const actor = { id: USER_ID, email: "eng@x.com", type: "user" as const, permissions: [] };

const SIG_PUBLIC_ID = `senthra/signatures/signature-${USER_ID}`;

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: "Ava",
    lastName: "Stone",
    email: "eng@x.com",
    jobTitle: "Field Engineer",
    role: null,
    signatureUrl: "https://cdn/sig.png",
    signatureName: "sig.png",
    signatureMimeType: "image/png",
    signatureFileSize: 120,
    signatureUploadedAt: new Date("2026-06-01T00:00:00Z"),
    signatureUpdatedAt: new Date("2026-06-01T00:00:00Z"),
    // The provider that stored this signature. Null is the legacy value — see the provider tests
    // at the bottom of this file for why reading it off the row is the whole point.
    signatureProvider: null,
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
const mockUpdate = userRepo.update as ReturnType<typeof vi.fn>;
const mockCountRefs = attachmentRepo.countRefs as ReturnType<typeof vi.fn>;

const mockCreds = getCloudinaryCreds as ReturnType<typeof vi.fn>;
const mockStorageFor = vi.mocked(getStorageFor);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreds.mockResolvedValue(CREDS);
  mockStorageFor.mockResolvedValue({ destroy: mockDestroy } as never);
  mockCountRefs.mockResolvedValue(0);
  mockDestroy.mockResolvedValue(undefined);
  mockFindById.mockResolvedValue(userRow());
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve(userRow({ ...data })),
  );
});

describe("signature removal → destroy, when nothing else references the asset", () => {
  it("destroys the file, addressing it by the publicId + resourceType PAIR", async () => {
    await removeMySignature(actor);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledWith({ provider: "cloudinary", publicId: SIG_PUBLIC_ID, resourceType: "image" });
  });

  it("counts references on the same pair before destroying", async () => {
    await removeMySignature(actor);
    // Scoped to the provider the USER ROW names — null here, meaning Cloudinary.
    expect(mockCountRefs).toHaveBeenCalledWith(null, "image", SIG_PUBLIC_ID);
  });

  it("counts AFTER the record is cleared, never before", async () => {
    const order: string[] = [];
    mockUpdate.mockImplementation(() => {
      order.push("db");
      return Promise.resolve(userRow({ signatureUrl: null }));
    });
    mockCountRefs.mockImplementation(() => {
      order.push("count");
      return Promise.resolve(0);
    });
    await removeMySignature(actor);
    expect(order).toEqual(["db", "count"]);
  });

  it("returns a record with the signature cleared", async () => {
    const result = await removeMySignature(actor);
    expect(result.signatureUrl).toBeNull();
    expect(result.signatureName).toBeNull();
    expect(result.signatureMimeType).toBeNull();
    expect(result.signatureFileSize).toBeNull();
    expect(result.signatureUploadedAt).toBeNull();
    expect(result.signatureUpdatedAt).toBeNull();
  });
});

describe("signature removal → NO destroy, when the asset is still referenced", () => {
  it("leaves the file in place when a committed attachment row still names it", async () => {
    mockCountRefs.mockResolvedValue(1);
    await removeMySignature(actor);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it("still clears the user's record — the removal succeeds either way", async () => {
    mockCountRefs.mockResolvedValue(3);
    const result = await removeMySignature(actor);
    expect(result.signatureUrl).toBeNull();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("storage failures cannot corrupt the user record", () => {
  it("succeeds when Cloudinary's destroy throws", async () => {
    mockDestroy.mockRejectedValue(new Error("cloudinary down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await removeMySignature(actor);
    expect(result.signatureUrl).toBeNull();
    // The asset is named in the log, which is the record a later reconciliation would read.
    expect(spy.mock.calls.flat().join(" ")).toContain(SIG_PUBLIC_ID);
    spy.mockRestore();
  });

  it("succeeds when the reference count throws", async () => {
    mockCountRefs.mockRejectedValue(new Error("mongo down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await removeMySignature(actor);
    expect(result.signatureUrl).toBeNull();
    expect(mockDestroy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("leaves the file in place — and says so — when the provider is not configured", async () => {
    mockStorageFor.mockResolvedValue(null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await removeMySignature(actor);
    expect(result.signatureUrl).toBeNull();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).toContain(SIG_PUBLIC_ID);
    spy.mockRestore();
  });

  it("does not reach Cloudinary at all when there was no signature to remove", async () => {
    mockFindById.mockResolvedValue(userRow({ signatureUrl: null }));
    await removeMySignature(actor);
    expect(mockCountRefs).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});

// ── Which provider a signature is released from ───────────────────────────────────────────────
//
// The signature is the ONE asset whose delete reference is RECONSTRUCTED rather than stored:
// `signatureAssetRef` rebuilds the key from a constant folder plus the user id. That derivation can
// recover the KEY but never the PROVIDER — so `User.signatureProvider` is the only thing that can
// say where the file actually is. Read the active Settings provider instead and a signature stored
// on one backend would be deleted from another, answer "not found", and survive forever.
describe("signature removal — the provider comes from the user row", () => {
  it('releases a signature stored on "cloudinary" through Cloudinary', async () => {
    mockFindById.mockResolvedValue(userRow({ signatureProvider: "cloudinary" }));
    await removeMySignature(actor);
    expect(mockStorageFor).toHaveBeenCalledWith({ provider: "cloudinary" });
  });

  it('releases a signature stored on "spaces" through Spaces, not the active provider', async () => {
    mockFindById.mockResolvedValue(userRow({ signatureProvider: "spaces" }));
    await removeMySignature(actor);
    expect(mockStorageFor).toHaveBeenCalledWith({ provider: "spaces" });
    expect(mockCountRefs).toHaveBeenCalledWith("spaces", "image", SIG_PUBLIC_ID);
  });

  it("reads an explicit null as Cloudinary", async () => {
    mockFindById.mockResolvedValue(userRow({ signatureProvider: null }));
    await removeMySignature(actor);
    expect(mockStorageFor).toHaveBeenCalledWith({ provider: "cloudinary" });
  });

  // A row written before the column existed has the field ABSENT, not null. Mongo distinguishes the
  // two and this path must not: both are Cloudinary.
  it("reads a MISSING provider field as Cloudinary", async () => {
    const row = userRow();
    delete (row as Record<string, unknown>).signatureProvider;
    mockFindById.mockResolvedValue(row);
    await removeMySignature(actor);
    expect(mockStorageFor).toHaveBeenCalledWith({ provider: "cloudinary" });
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
