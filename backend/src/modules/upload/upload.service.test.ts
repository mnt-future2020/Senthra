import { beforeEach, describe, expect, it, vi } from "vitest";

// The two halves the backend still owns once the file goes straight to Cloudinary: WHO may upload, and
// WHETHER what arrived is what was promised. Nothing else about an upload is checkable any more, so
// these are the whole security surface.
vi.mock("./upload.repository.js", () => ({
  create: vi.fn(),
  findByPublicId: vi.fn(),
  claim: vi.fn(),
  renew: vi.fn(),
  remove: vi.fn(),
  findReapable: vi.fn(),
}));
vi.mock("../../lib/cloudinary.js", () => ({
  signUploadParams: vi.fn(),
  verifyUploadResponse: vi.fn(),
  signedDeliveryUrl: vi.fn(),
  fetchFirstBytes: vi.fn(),
  destroyFromCloudinary: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
// Deliberately NOT the real defaults. If the service ever hard-coded a preset name, these tests would
// keep passing against "senthra_image"/"senthra_raw" and prove nothing.
vi.mock("../../config/env.js", () => ({
  env: { CLOUDINARY_UPLOAD_PRESET_IMAGE: "configured-image", CLOUDINARY_UPLOAD_PRESET_RAW: "configured-raw" },
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
}));

import * as pendingRepo from "./upload.repository.js";
import { fetchFirstBytes, signUploadParams, signedDeliveryUrl, verifyUploadResponse, destroyFromCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { env } from "../../config/env.js";
import { commitAttachment, createSignature, verifyFinalize } from "./upload.service.js";
import { UPLOAD_PURPOSES } from "./upload.catalog.js";

const CREDS = { cloudName: "c", apiKey: "k", apiSecret: "s" };
const ACTOR = { type: "user" as const, id: "u1", email: "buyer@x.co", permissions: ["purchase_orders.edit", "jobs.edit"] };

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.alloc(64, 0x41)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64, 0x41)]);

const create = vi.mocked(pendingRepo.create);
const findByPublicId = vi.mocked(pendingRepo.findByPublicId);
const claim = vi.mocked(pendingRepo.claim);
const renew = vi.mocked(pendingRepo.renew);
const remove = vi.mocked(pendingRepo.remove);

const LEDGER_ID = "senthra/purchase-orders/uuid.pdf";

/**
 * The ledger row's real conditional-update behaviour, in memory.
 *
 * The lease functions used to be stubbed to succeed unconditionally, and that hid a live bug for as
 * long as it existed: finalize took the lease, then the write asked for the SAME lease as though it
 * were free, and the row — correctly — refused its own holder. Against a stub both calls passed;
 * against the database every PRF, PO and GRN attachment failed. So these mocks enforce the semantics
 * the repository actually implements: claim needs the lease free, renew needs it unchanged since.
 */
function installLedger(publicId = LEDGER_ID) {
  const row = { claimExpiresAt: null as Date | null, present: true };
  claim.mockImplementation(async (id, leaseMs) => {
    if (id !== publicId || !row.present) return null;
    const now = new Date();
    if (row.claimExpiresAt && row.claimExpiresAt.getTime() > now.getTime()) return null;
    row.claimExpiresAt = new Date(now.getTime() + leaseMs);
    return row.claimExpiresAt;
  });
  renew.mockImplementation(async (id, held, leaseMs) => {
    if (id !== publicId || !row.present) return false;
    if (row.claimExpiresAt?.getTime() !== held.getTime()) return false;
    row.claimExpiresAt = new Date(Date.now() + leaseMs);
    return true;
  });
  remove.mockImplementation(async (id) => {
    if (id !== publicId || !row.present) return { count: 0 };
    row.present = false;
    return { count: 1 };
  });
  return row;
}
const sign = vi.mocked(signUploadParams);
const verifyResp = vi.mocked(verifyUploadResponse);
const deliveryUrl = vi.mocked(signedDeliveryUrl);
const firstBytes = vi.mocked(fetchFirstBytes);
const destroy = vi.mocked(destroyFromCloudinary);
const creds = vi.mocked(getCloudinaryCreds);

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  publicId: "senthra/purchase-orders/uuid.pdf",
  resourceType: "raw",
  purpose: "po_attachment",
  actorId: "u1",
  createdAt: new Date(),
  claimExpiresAt: null,
  ...over,
}) as never;

// The stored size finalize reads back, rather than the one the browser claimed.
//
// `ok` is part of the stub because it is part of what the code reads: a HEAD that failed still
// carries a content-length (its error body's), so finalize checks the status before believing the
// header. A stub without `ok` is not a Response, and modelling it as one is what would let that
// check regress unnoticed.
const mockHead = (bytes: number, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([["content-length", String(bytes)]]) as never,
    })),
  );

beforeEach(() => {
  vi.clearAllMocks();
  creds.mockResolvedValue(CREDS);
  sign.mockReturnValue({ cloudName: "c", apiKey: "k", timestamp: 1, signature: "sig", folder: "senthra/purchase-orders", publicId: "uuid.pdf", resourceType: "raw", uploadUrl: "https://api.cloudinary.com/v1_1/c/raw/upload" });
  verifyResp.mockReturnValue(true);
  deliveryUrl.mockReturnValue("https://res.cloudinary.com/c/raw/upload/s--x--/senthra/purchase-orders/uuid.pdf");
  firstBytes.mockResolvedValue(PDF);
  installLedger();
  destroy.mockResolvedValue(undefined);
  create.mockResolvedValue(pendingRow());
  mockHead(2048);
});

const sigInput = (over: Record<string, unknown> = {}) => ({
  purpose: "po_attachment",
  fileName: "quote.pdf",
  sizeBytes: 2048,
  mediaType: "application/pdf",
  ...over,
});

const finInput = (over: Record<string, unknown> = {}) => ({
  purpose: "po_attachment",
  publicId: "senthra/purchase-orders/uuid.pdf",
  version: 1,
  signature: "cloudinary-sig",
  fileName: "quote.pdf",
  mediaType: "application/pdf",
  ...over,
});

// ── Signature ──────────────────────────────────────────────────────────────────────────────────

describe("createSignature — who may upload", () => {
  it("issues a signature for a permitted purpose", async () => {
    const r = await createSignature(sigInput(), ACTOR);
    expect(r.signature).toBe("sig");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller without the purpose's permission", async () => {
    await expect(createSignature(sigInput(), { ...ACTOR, permissions: ["jobs.view"] })).rejects.toThrow(/permission/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    await expect(createSignature(sigInput(), undefined)).rejects.toThrow();
  });

  it("refuses an unknown purpose rather than inventing a folder", async () => {
    await expect(createSignature(sigInput({ purpose: "not_a_purpose" }), ACTOR)).rejects.toThrow(/unknown upload type/i);
  });

  it("refuses a media type the purpose does not accept", async () => {
    await expect(createSignature(sigInput({ mediaType: "application/x-msdownload" }), ACTOR)).rejects.toThrow(/file type/i);
  });

  it("refuses a declared size above the purpose's ceiling", async () => {
    await expect(createSignature(sigInput({ sizeBytes: 11 * 1024 * 1024 }), ACTOR)).rejects.toThrow(/10 MB or smaller/i);
    expect(create).not.toHaveBeenCalled();
  });

  // The folder and the public id are the two values a client must never choose: one decides where the
  // asset lands, the other is what finalize looks up. Both are signed.
  it("signs a server-chosen folder and public id, never the client's", async () => {
    await createSignature(sigInput(), ACTOR);
    const args = sign.mock.calls[0]![0];
    expect(args.folder).toBe(UPLOAD_PURPOSES.po_attachment.folder);
    expect(args.publicId).toMatch(/^quote-[0-9a-f-]{36}\.pdf$/);
    expect(args.resourceType).toBe("raw");
  });

  // The user's own file name is the ONLY record of what they picked for a `String[]` attachment, which
  // stores nothing but the URL. Without it every job attachment displayed as a bare `9096674d-….pdf` —
  // found by uploading through the real form, not by reading the code.
  it("puts the user's file name in front of the uuid so the screens can read it back", async () => {
    await createSignature(sigInput({ fileName: "Site Survey Rev C.pdf" }), ACTOR);
    expect(sign.mock.calls[0]![0].publicId).toMatch(/^site-survey-rev-c-[0-9a-f-]{36}\.pdf$/);
  });

  // A public id is a PATH. A `/` in a file name would move the asset out of the folder the signature
  // committed to, so the name is reduced to the same character set the old server-side path used.
  it("sanitises a file name that could escape the folder", async () => {
    await createSignature(sigInput({ fileName: "../../etc/passwd.pdf" }), ACTOR);
    const id = sign.mock.calls[0]![0].publicId;
    expect(id).not.toContain("/");
    expect(id).toMatch(/^[a-z0-9_-]+-[0-9a-f-]{36}\.pdf$/);
  });

  it("falls back to a bare uuid when the name sanitises to nothing", async () => {
    await createSignature(sigInput({ fileName: "///.pdf" }), ACTOR);
    expect(sign.mock.calls[0]![0].publicId).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });

  // A raw asset is served at exactly its public id, so without the extension the delivery URL ends in
  // a bare UUID and the browser downloads an extensionless blob.
  it("keeps the extension on a raw public id and off an image one", async () => {
    await createSignature(sigInput({ purpose: "damage_photo", mediaType: "image/png", sizeBytes: 1000 }), { ...ACTOR, permissions: ["inventory.adjust"] });
    expect(sign.mock.calls[0]![0].publicId).toMatch(/^quote-[0-9a-f-]{36}$/);
    expect(sign.mock.calls[0]![0].resourceType).toBe("image");
  });

  it("records the ledger row against the requesting actor", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(create.mock.calls[0]![0]).toMatchObject({ actorId: "u1", purpose: "po_attachment", resourceType: "raw" });
  });

  // Cloudinary can refuse a disallowed extension at its own edge, before the file is spent — but only
  // against a preset, and the two allowlists differ by resource type. Picking the wrong one would send
  // a PDF at the image allowlist and break every document upload.
  it("signs a raw upload against the configured raw preset", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(sign.mock.calls[0]![0].uploadPreset).toBe("configured-raw");
  });

  it("signs an image upload against the configured image preset", async () => {
    await createSignature(sigInput({ purpose: "damage_photo", mediaType: "image/png", sizeBytes: 1000 }), {
      ...ACTOR,
      permissions: ["inventory.adjust"],
    });
    expect(sign.mock.calls[0]![0].uploadPreset).toBe("configured-image");
  });

  it("signs without a preset when the configured name is blank", async () => {
    const mutable = env as { CLOUDINARY_UPLOAD_PRESET_RAW: string };
    const configured = mutable.CLOUDINARY_UPLOAD_PRESET_RAW;
    mutable.CLOUDINARY_UPLOAD_PRESET_RAW = "  ";
    try {
      await createSignature(sigInput(), ACTOR);
      expect(sign.mock.calls[0]![0].uploadPreset).toBeUndefined();
    } finally {
      mutable.CLOUDINARY_UPLOAD_PRESET_RAW = configured;
    }
  });

  it("runs the module's pre-check and refuses when it throws", async () => {
    const pre = vi.fn().mockRejectedValue(new Error("A purchase order can have at most 20 documents."));
    await expect(createSignature(sigInput(), ACTOR, pre)).rejects.toThrow(/at most 20/i);
    expect(create).not.toHaveBeenCalled();
  });
});

// ── Finalize ───────────────────────────────────────────────────────────────────────────────────

describe("verifyFinalize — ownership", () => {
  it("accepts an upload this actor was authorised for", async () => {
    findByPublicId.mockResolvedValue(pendingRow());
    const asset = await verifyFinalize(finInput(), ACTOR);
    expect(asset.publicId).toBe("senthra/purchase-orders/uuid.pdf");
    expect(asset.fileSizeBytes).toBe(2048);
  });

  // THE control. Cloudinary's response signature proves the asset is real and in our cloud — every
  // asset in the account satisfies that, including another customer's. The ledger row is what proves
  // it is ours to attach.
  it("refuses a publicId this server never issued", async () => {
    findByPublicId.mockResolvedValue(null);
    await expect(verifyFinalize(finInput({ publicId: "senthra/jobs/someone-elses.pdf" }), ACTOR)).rejects.toThrow(/no longer available/i);
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses another user's pending upload", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ actorId: "someone-else" }));
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/no longer available/i);
    expect(claim).not.toHaveBeenCalled();
  });

  // A signature obtained for a 2 MB engineer photo must not be spendable on a purchase-order document.
  it("refuses a purpose that does not match the row", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ purpose: "damage_photo" }));
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/authorised for something else/i);
  });

  it("refuses a caller without the purpose's permission", async () => {
    findByPublicId.mockResolvedValue(pendingRow());
    await expect(verifyFinalize(finInput(), { ...ACTOR, permissions: [] })).rejects.toThrow(/permission/i);
  });

  it("refuses a response signature that does not verify", async () => {
    findByPublicId.mockResolvedValue(pendingRow());
    verifyResp.mockReturnValue(false);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/could not be verified/i);
  });
});

describe("verifyFinalize — content", () => {
  beforeEach(() => findByPublicId.mockResolvedValue(pendingRow()));

  // Cloudinary stores a `raw` asset opaquely: its allowed_formats restriction and the format it
  // reports both come from the extension in the public id. For a PDF that is a label, and this is the
  // only thing that checks it.
  it("reads a raw upload's first bytes and accepts a real PDF", async () => {
    firstBytes.mockResolvedValue(PDF);
    await expect(verifyFinalize(finInput(), ACTOR)).resolves.toBeTruthy();
    expect(firstBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects an executable wearing a .pdf label", async () => {
    firstBytes.mockResolvedValue(EXE);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/isn't a valid PDF/i);
  });

  it("accepts a real DOCX", async () => {
    firstBytes.mockResolvedValue(DOCX);
    const docx = finInput({ mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "spec.docx" });
    await expect(verifyFinalize(docx, ACTOR)).resolves.toBeTruthy();
  });

  it("rejects a PDF label on ZIP bytes", async () => {
    firstBytes.mockResolvedValue(DOCX);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/isn't a valid PDF/i);
  });

  // An unreadable upload is not one to attach — refuse rather than assume.
  it("refuses when the stored file cannot be read back", async () => {
    firstBytes.mockRejectedValue(new Error("HTTP 401"));
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/could not verify/i);
  });

  // Images are decoded by Cloudinary on the way in, so its acceptance IS the content check and no
  // byte read is needed — which is what keeps the common, high-volume path free of extra calls.
  it("does not read bytes for an image upload", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ resourceType: "image", purpose: "damage_photo" }));
    await verifyFinalize(finInput({ purpose: "damage_photo", mediaType: "image/png" }), { ...ACTOR, permissions: ["inventory.adjust"] });
    expect(firstBytes).not.toHaveBeenCalled();
  });

  /**
   * The bypass these close.
   *
   * `mediaType` is re-declared at finalize and was only ever checked against the PURPOSE, never
   * against the row. Since a document purpose accepts PNG as well as PDF, an attacker could sign as
   * `application/pdf` — a `raw` upload, which Cloudinary stores opaquely and inspects not at all —
   * post arbitrary bytes, then finalize declaring `image/png`. The purpose allowed it, the row still
   * said `raw` so the byte check ran, and the byte check had no entry for an image so it returned
   * silently. Arbitrary content, attached, with nothing having looked inside it.
   *
   * Two independent guards now: the declaration must agree with the signed resource type, and a raw
   * type with no signature entry fails closed instead of passing.
   */
  it("refuses an image media type declared against a raw upload", async () => {
    const swapped = finInput({ mediaType: "image/png" });
    await expect(verifyFinalize(swapped, ACTOR)).rejects.toThrow(/authorised for a different file type/i);
  });

  it("does not read — or accept — bytes when the declared type was swapped", async () => {
    firstBytes.mockResolvedValue(EXE);
    await expect(verifyFinalize(finInput({ mediaType: "image/jpeg" }), ACTOR)).rejects.toThrow(
      /authorised for a different file type/i,
    );
    // Refused before any content work, so an EXE never reaches the point of being labelled a JPEG.
    expect(firstBytes).not.toHaveBeenCalled();
  });

  it("refuses a raw media type declared against an image upload", async () => {
    // The mirror image, and the reason the check is an equality rather than a one-way test.
    findByPublicId.mockResolvedValue(pendingRow({ resourceType: "image", purpose: "damage_photo" }));
    await expect(
      verifyFinalize(finInput({ purpose: "damage_photo", mediaType: "application/pdf" }), {
        ...ACTOR,
        permissions: ["inventory.adjust"],
      }),
    ).rejects.toThrow(/file type/i);
  });

  // The size is measured from storage, not taken from the browser — and an oversize asset is removed,
  // because leaving it would be exactly the leak this design exists to prevent.
  it("rejects and destroys a file above the purpose ceiling", async () => {
    mockHead(11 * 1024 * 1024);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/10 MB or smaller/i);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("senthra/purchase-orders/uuid.pdf");
  });

  /**
   * A failed HEAD still carries a content-length — of its own error body. Believing it turns an
   * asset we could not read into a plausible small size, which then sails through the ceiling check
   * directly above. The status has to be tested before the header is used.
   */
  it("refuses a size read from a non-2xx delivery response", async () => {
    mockHead(71, 404);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/could not verify the uploaded file \(http 404\)/i);
  });

  it("refuses when the size probe fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/could not verify/i);
  });
});

describe("verifyFinalize — the lease", () => {
  beforeEach(() => findByPublicId.mockResolvedValue(pendingRow()));

  it("takes the lease before doing any work", async () => {
    await verifyFinalize(finInput(), ACTOR);
    expect(claim).toHaveBeenCalledWith("senthra/purchase-orders/uuid.pdf", expect.any(Number));
  });

  // Exactly one winner: a concurrent finalize, or a reaper that got there first.
  it("refuses when the lease is already held", async () => {
    claim.mockResolvedValue(null);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/already being processed/i);
    expect(verifyResp).not.toHaveBeenCalled();
  });

  // The write needs to prove it holds the lease the verification took, so the lease has to travel.
  it("hands the lease it took back on the verified asset", async () => {
    const asset = await verifyFinalize(finInput(), ACTOR);
    expect(asset.lease).toBeInstanceOf(Date);
    expect(asset.lease.getTime()).toBe((await claim.mock.results[0]!.value as Date).getTime());
  });
});

// ── Commit ─────────────────────────────────────────────────────────────────────────────────────

describe("commitAttachment", () => {
  beforeEach(() => findByPublicId.mockResolvedValue(pendingRow()));

  /** A real finalize, so the lease the commit is handed is the one verification actually holds. */
  const verified = () => verifyFinalize(finInput(), ACTOR);

  // THE regression. Verification holds the lease; the commit then has to write under that same lease.
  // While the commit asked for a FREE lease it was refused by its own hold, so every PRF, PO and GRN
  // attachment ended in "that upload is no longer available" — a 100% failure nobody's mock could see.
  it("attaches under the lease the verification already holds", async () => {
    const asset = await verified();
    await expect(commitAttachment(asset, async () => ({ id: "att1" }))).resolves.toEqual({ id: "att1" });
  });

  // The attachment write and the ledger removal in ONE transaction, with the lease re-asserted inside
  // it. Without that pairing a crash between the two would leave a row the reaper later honours by
  // destroying a LIVE asset.
  it("renews the lease, writes, and removes the row together", async () => {
    const asset = await verified();
    const order: string[] = [];
    const realRenew = renew.getMockImplementation()!;
    renew.mockImplementation(async (...args) => { order.push("lease"); return realRenew(...args); });
    const realRemove = remove.getMockImplementation()!;
    remove.mockImplementation(async (...args) => { order.push("remove"); return realRemove(...args); });

    await commitAttachment(asset, async () => { order.push("write"); return "attached"; });
    expect(order).toEqual(["lease", "write", "remove"]);
  });

  // A reaper that won the row while the file was being validated has already written its own expiry,
  // so the lease presented here no longer matches and the attachment must not be written.
  it("does not write when the lease was taken by someone else", async () => {
    const asset = await verified();
    const write = vi.fn();
    await expect(commitAttachment({ ...asset, lease: new Date(asset.lease.getTime() + 1) }, write)).rejects.toThrow(
      /no longer available/i,
    );
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not write when the row is gone entirely", async () => {
    const asset = await verified();
    renew.mockResolvedValue(false);
    const write = vi.fn();
    await expect(commitAttachment(asset, write)).rejects.toThrow(/no longer available/i);
    expect(write).not.toHaveBeenCalled();
  });
});
