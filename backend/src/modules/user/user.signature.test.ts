import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure unit test of the self-service signature flow + the document reader. The repository,
// Cloudinary transport, audit log and settings are mocked — no DB / network.
vi.mock("./user.repository.js", () => ({
  findById: vi.fn(),
  findByEmailWithRole: vi.fn(),
  findNamesByEmails: vi.fn(),
  update: vi.fn(),
}));
vi.mock("#modules/auth/admin.repository.js", () => ({ findNamesByEmails: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn(), uploadFileToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getEmployeeIdPrefix: vi.fn(),
}));

import * as userRepo from "./user.repository.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import {
  getDisplayNamesForEmails,
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

// Documents record their actors by EMAIL (createdBy / approvedBy / sentBy). Resolving those to
// people is one batched lookup — a PDF is rendered on every send, download and archive.
describe("getDisplayNamesForEmails", () => {
  const mockFindNames = userRepo.findNamesByEmails as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindNames.mockResolvedValue([]);
    // Both stores are consulted now — see "which identity wins an email" below.
    (adminRepo.findNamesByEmails as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("maps each email to the person's name and job title, keyed lowercase", async () => {
    mockFindNames.mockResolvedValue([
      { email: "ava@x.com", firstName: "Ava", lastName: "Stone", jobTitle: "Procurement Manager" },
      { email: "ravi@x.com", firstName: "Ravi", lastName: "Kumar", jobTitle: null },
    ]);
    expect(await getDisplayNamesForEmails(["AVA@x.com", "ravi@x.com"])).toEqual({
      "ava@x.com": { name: "Ava Stone", jobTitle: "Procurement Manager" },
      "ravi@x.com": { name: "Ravi Kumar", jobTitle: null },
    });
    expect(mockFindNames).toHaveBeenCalledWith(["ava@x.com", "ravi@x.com"]);
  });

  // The PERMISSION role ("Super Admin") is deliberately not carried: it is internal access-control
  // information with no meaning to a supplier, and it changes when permissions change.
  it("normalises a blank job title to null rather than an empty string", async () => {
    mockFindNames.mockResolvedValue([{ email: "ava@x.com", firstName: "Ava", lastName: "Stone", jobTitle: "  " }]);
    expect(await getDisplayNamesForEmails(["ava@x.com"])).toEqual({ "ava@x.com": { name: "Ava Stone", jobTitle: null } });
  });

  it("de-duplicates and drops blanks before querying", async () => {
    await getDisplayNamesForEmails(["ava@x.com", "Ava@x.com", null, "", undefined, "  "]);
    expect(mockFindNames).toHaveBeenCalledWith(["ava@x.com"]);
  });

  it("never hits the DB when there is nobody to resolve", async () => {
    expect(await getDisplayNamesForEmails([null, ""])).toEqual({});
    expect(mockFindNames).not.toHaveBeenCalled();
  });

  // A name is only useful if it IS a name — a user row with neither part must not resolve to an
  // empty string, or the document would print a blank where the email at least identified someone.
  it("leaves a nameless account unresolved so the caller falls back to the email", async () => {
    mockFindNames.mockResolvedValue([{ email: "ghost@x.com", firstName: "", lastName: "", jobTitle: "Buyer" }]);
    expect(await getDisplayNamesForEmails(["ghost@x.com"])).toEqual({});
  });
});

// A super admin is NOT a User — it is its own record — so a document raised by one resolved to
// nothing here and fell back to printing a raw login. Worse, where a stale staff account happened to
// share that email (legacy data the namespace guard now blocks), the SOFT-DELETED row won and a
// deleted test record's name went out on a supplier's purchase order.
describe("getDisplayNamesForEmails — which identity wins an email", () => {
  const mockUsers = userRepo.findNamesByEmails as ReturnType<typeof vi.fn>;
  const mockAdmins = adminRepo.findNamesByEmails as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.mockResolvedValue([]);
    mockAdmins.mockResolvedValue([]);
  });

  it("resolves a super admin, who has no staff record at all", async () => {
    mockAdmins.mockResolvedValue([{ email: "boss@x.com", name: "Ada Boss" }]);
    expect(await getDisplayNamesForEmails(["boss@x.com"])).toEqual({
      "boss@x.com": { name: "Ada Boss", jobTitle: null },
    });
  });

  // THE bug: one email, two records — a live admin and a leftover deleted staff row.
  it("prefers a live identity over a soft-deleted one on the same email", async () => {
    mockUsers.mockResolvedValue([
      { email: "boss@x.com", firstName: "test", lastName: "sahul", jobTitle: null, deletedAt: new Date("2026-06-04") },
    ]);
    mockAdmins.mockResolvedValue([{ email: "boss@x.com", name: "Ada Boss" }]);
    expect(await getDisplayNamesForEmails(["boss@x.com"])).toEqual({
      "boss@x.com": { name: "Ada Boss", jobTitle: null },
    });
  });

  // A live identity with no name on file must not let the deleted row answer for it — falling back
  // to the email names nobody, which is honest; naming the wrong person is not.
  it("does not let a deleted record stand in for a live one that has no name", async () => {
    mockUsers.mockResolvedValue([
      { email: "boss@x.com", firstName: "test", lastName: "sahul", jobTitle: null, deletedAt: new Date("2026-06-04") },
    ]);
    mockAdmins.mockResolvedValue([{ email: "boss@x.com", name: null }]);
    expect(await getDisplayNamesForEmails(["boss@x.com"])).toEqual({});
  });

  // The staff record is the richer identity (first/last + job title), so it wins over an admin row.
  it("prefers a live staff record over an admin one", async () => {
    mockUsers.mockResolvedValue([
      { email: "both@x.com", firstName: "Ava", lastName: "Stone", jobTitle: "Buyer", deletedAt: null },
    ]);
    mockAdmins.mockResolvedValue([{ email: "both@x.com", name: "Ada Boss" }]);
    expect(await getDisplayNamesForEmails(["both@x.com"])).toEqual({
      "both@x.com": { name: "Ava Stone", jobTitle: "Buyer" },
    });
  });

  // Still names a leaver when they are the ONLY identity — an archived order must keep naming the
  // person who raised it.
  it("falls back to a soft-deleted staff record when nothing live claims the email", async () => {
    mockUsers.mockResolvedValue([
      { email: "gone@x.com", firstName: "Ravi", lastName: "Kumar", jobTitle: "Buyer", deletedAt: new Date("2026-01-01") },
    ]);
    expect(await getDisplayNamesForEmails(["gone@x.com"])).toEqual({
      "gone@x.com": { name: "Ravi Kumar", jobTitle: "Buyer" },
    });
  });

  it("asks both stores in one batched round trip", async () => {
    await getDisplayNamesForEmails(["A@x.com", "b@x.com", "a@x.com"]);
    expect(mockUsers).toHaveBeenCalledWith(["a@x.com", "b@x.com"]);
    expect(mockAdmins).toHaveBeenCalledWith(["a@x.com", "b@x.com"]);
  });
});
