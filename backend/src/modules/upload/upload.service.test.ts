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
// NO Cloudinary import. The service signs through whatever the ACTIVE provider is and verifies
// through whatever the ROW names, so both halves are mocked as storage backends — which is exactly
// the property under test: this file can no longer tell you which vendor is involved.
const { confirmUpload, deliveryUrl, readRange, destroy, head, signUpload, promoteUpload } = vi.hoisted(() => ({
  confirmUpload: vi.fn(),
  promoteUpload: vi.fn(),
  deliveryUrl: vi.fn(),
  readRange: vi.fn(),
  destroy: vi.fn(),
  head: vi.fn(),
  signUpload: vi.fn(),
}));
vi.mock("../../lib/storage/index.js", () => ({
  getStorageFor: vi.fn(),
  findActiveStorage: vi.fn(),
  normalizeProviderId: (v: string | null | undefined) => (v === "spaces" ? "spaces" : "cloudinary"),
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
import { findActiveStorage, getStorageFor } from "../../lib/storage/index.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { commitAttachment, createSignature, verifyFinalize } from "./upload.service.js";
import { CONTENT_PROBE_BYTES, UPLOAD_PURPOSES } from "./upload.catalog.js";

const CREDS = { cloudName: "c", apiKey: "k", apiSecret: "s" };
const ACTOR = { type: "user" as const, id: "u1", email: "buyer@x.co", permissions: ["purchase_orders.edit", "jobs.edit"] };

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.alloc(64, 0x41)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64, 0x41)]);
// OLE2 compound file — the legacy .xls container.
const OLE2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 0x41)]);
// A CSV has no signature at all; this is simply text. That is exactly why it needs the inverted check.
const CSV_BYTES = Buffer.from("code,description,qty\nSKU-1,Cable tray 3m,12\n", "utf8");

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
const sign = signUpload; // the ACTIVE provider's signing call
const firstBytes = readRange; // the provider's ranged read — same role the transport's had
const storage = vi.mocked(getStorageFor);
const activeStorage = vi.mocked(findActiveStorage);
const creds = vi.mocked(getCloudinaryCreds);

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  publicId: "senthra/purchase-orders/uuid.pdf",
  resourceType: "raw",
  purpose: "po_attachment",
  actorId: "u1",
  createdAt: new Date(),
  claimExpiresAt: null,
  // The provider the signature was minted against. Null is the legacy value — see the provider
  // tests at the bottom of this file.
  storageProvider: null,
  ...over,
}) as never;

// The stored size finalize reads back, rather than the one the browser claimed.
//
// It is the PROVIDER that reads it now. The rule that made this stub a Response — a failed HEAD
// still carries a content-length, so the status must be checked before the header is believed —
// moved with `measure()` into lib/storage/cloudinary.test.ts, where the reading actually happens.
// What finalize still owns, and what is tested here, is what it does with the number it gets back.
const mockHead = (bytes: number) => head.mockResolvedValue({ sizeBytes: bytes, contentType: null });

beforeEach(() => {
  vi.clearAllMocks();
  creds.mockResolvedValue(CREDS);
  storage.mockResolvedValue({
    confirmUpload,
    deliveryUrl,
    readRange,
    destroy,
    head,
    promoteUpload,
    // The default provider here IS Cloudinary, which decodes an image as it arrives.
    validatesImagesOnIngest: true,
  } as never);
  confirmUpload.mockResolvedValue(undefined);
  // Cloudinary's promotion is an identity — it signs `overwrite: false`, so nothing is staged.
  // Defaulting to that keeps every existing expectation in this file describing the same asset.
  promoteUpload.mockImplementation(async (ref: unknown) => ref);
  // What an adapter returns: a neutral envelope. The FIELDS are opaque to the service — these
  // happen to be Cloudinary's, and the service neither reads nor reshapes them.
  sign.mockResolvedValue({
    method: "POST",
    url: "https://api.cloudinary.com/v1_1/c/raw/upload",
    fields: { api_key: "k", timestamp: "1", signature: "sig", folder: "senthra/purchase-orders", public_id: "uuid.pdf", overwrite: "false", upload_preset: "configured-raw" },
    publicId: "senthra/purchase-orders/uuid.pdf",
    resourceType: "raw",
    provider: "cloudinary",
  });
  activeStorage.mockResolvedValue({ id: "cloudinary", signUpload } as never);
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
    expect(r).toMatchObject({ method: "POST", url: expect.any(String), purpose: "po_attachment" });
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
    expect(args.publicId).toMatch(/^[0-9a-f-]{36}\/quote\.pdf$/);
    expect(args.resourceType).toBe("raw");
  });

  // A raw asset is served at exactly its public id, so without the extension the delivery URL ends in
  // a bare UUID and the browser downloads an extensionless blob.
  it("keeps the extension on a raw public id and off an image one", async () => {
    await createSignature(sigInput({ purpose: "damage_photo", mediaType: "image/png", sizeBytes: 1000 }), { ...ACTOR, permissions: ["inventory.adjust"] });
    expect(sign.mock.calls[0]![0].publicId).toMatch(/^quote-[0-9a-f-]{36}$/);
    expect(sign.mock.calls[0]![0].resourceType).toBe("image");
  });
});

// ── The name a document downloads as ───────────────────────────────────────────────────────────
//
// Cloudinary sends no Content-Disposition, so the browser names a saved file after the LAST PATH
// SEGMENT of the delivery URL — which is the public id. That single fact is what every test here is
// about: the uuid has to stay (it is the uniqueness), and it has to stay out of the segment the user
// reads, so it becomes a folder and the file name becomes the leaf.
describe("createSignature — the name a raw document downloads as", () => {
  /** The public id minted for one document, by media type. */
  const idFor = async (fileName: string, mediaType = "application/pdf") => {
    await createSignature(sigInput({ fileName, mediaType }), ACTOR);
    return sign.mock.calls.at(-1)![0].publicId;
  };

  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // The whole point. Before this the URL ended `finance_report_2026-08-26-d817abf6-….xlsx` and that
  // is what Chrome wrote to the user's Downloads folder.
  it("ends in the user's own file name, with the uuid moved into a folder", async () => {
    expect(await idFor("Finance_Report_2026-08-26.xlsx", XLSX))
      .toMatch(/^[0-9a-f-]{36}\/Finance_Report_2026-08-26\.xlsx$/);
  });

  // The old sanitiser lowercased, because the id was never meant to be read as a file name. Now it is
  // one, and `FINANCE_REPORT` coming back as `finance_report` is a name the user did not choose.
  it("preserves the case the user typed", async () => {
    expect(await idFor("Quarterly_Report.PDF")).toContain("/Quarterly_Report.pdf");
  });

  // A dot is only dangerous at the START of a segment (or doubled). Interior dots are how half the
  // world versions a document, and flattening them renames the file for no gain.
  it("keeps interior dots so a versioned name survives", async () => {
    expect(await idFor("invoice.final.v2.pdf")).toContain("/invoice.final.v2.pdf");
  });

  // Spaces, brackets and commas all occur in real supplier paperwork. None of them is safe to put in
  // a signed URL path verbatim — a comma is Cloudinary's own transformation separator — so they are
  // folded to a hyphen rather than dropped, which keeps the words apart.
  it("folds characters that are unsafe in a delivery path down to hyphens", async () => {
    expect(await idFor("PO-0064 (2).pdf")).toContain("/PO-0064-2.pdf");
    expect(await idFor("MZ1200,Bracket,4.csv", "text/csv")).toContain("/MZ1200-Bracket-4.csv");
  });

  // THE security invariant. A public id is a PATH: a name that added a second `/`, or climbed with
  // `..`, would move the asset out of the folder the signature committed to — and out of the uuid
  // folder that makes it unique, which is how one upload could land on another's id.
  it.each([
    ["../../evil.xlsx", XLSX],
    ["..\\evil.xlsx", XLSX],
    ["A/B.xlsx", XLSX],
    ["..", "application/pdf"],
    ["....//....//passwd.pdf", "application/pdf"],
  ])("cannot escape the uuid folder: %s", async (fileName, mediaType) => {
    const id = await idFor(fileName, mediaType);
    // Exactly one separator — the one this code put there.
    expect(id.split("/")).toHaveLength(2);
    const [uuid, leaf] = id.split("/");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(leaf!.startsWith(".")).toBe(false);
    expect(leaf).not.toContain("..");
    expect(leaf).not.toContain("\\");
  });

  // A name of nothing but characters we fold away is not an error — the uuid folder already carries
  // the uniqueness, so the leaf only has to be a legible placeholder.
  it("falls back to a readable leaf when nothing of the name survives", async () => {
    expect(await idFor("日本語.xlsx", XLSX)).toMatch(/^[0-9a-f-]{36}\/file\.xlsx$/);
    expect(await idFor("   .pdf")).toMatch(/^[0-9a-f-]{36}\/file\.pdf$/);
  });

  // Cloudinary caps a public id at 255 characters and the folder and uuid have already spent 60 of
  // them. Trimming must not leave the name ending on a separator it was cut through.
  it("caps a very long name without leaving it ending in a separator", async () => {
    const id = await idFor(`${"a-".repeat(200)}.pdf`);
    const leaf = id.split("/")[1]!;
    expect(leaf.length).toBeLessThanOrEqual(64);
    expect(leaf).toBe(leaf.replace(/-+\.pdf$/, ".pdf"));
    expect(leaf.endsWith(".pdf")).toBe(true);
  });

  // Images are OUT OF SCOPE and must stay byte-for-byte as they were: they are previewed inline and
  // never downloaded by name, and their delivery URL carries no extension for Cloudinary to key its
  // format off. Changing their shape would buy nothing and put every avatar and photo at risk.
  it("leaves an image public id in its existing shape", async () => {
    await createSignature(
      sigInput({ purpose: "damage_photo", mediaType: "image/jpeg", fileName: "Damaged Pallet.JPG", sizeBytes: 1000 }),
      { ...ACTOR, permissions: ["inventory.adjust"] },
    );
    expect(sign.mock.calls.at(-1)![0].publicId).toMatch(/^damaged-pallet-[0-9a-f-]{36}$/);
  });
});

describe("createSignature — the ledger row and the preset", () => {
  it("records the ledger row against the requesting actor", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(create.mock.calls[0]![0]).toMatchObject({ actorId: "u1", purpose: "po_attachment", resourceType: "raw" });
  });

  // The RESOURCE TYPE is still the service's decision — it comes from the declared media type and
  // decides the delivery path. Which preset that maps to is the adapter's, and is asserted in
  // lib/storage/cloudinary.test.ts, where the preset actually lives now.
  it("asks the adapter to sign a document as raw", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(sign.mock.calls[0]![0]).toMatchObject({ resourceType: "raw", mediaType: "application/pdf" });
  });

  it("asks the adapter to sign a photo as an image", async () => {
    await createSignature(sigInput({ purpose: "damage_photo", mediaType: "image/png", sizeBytes: 1000 }), {
      ...ACTOR,
      permissions: ["inventory.adjust"],
    });
    expect(sign.mock.calls[0]![0]).toMatchObject({ resourceType: "image", mediaType: "image/png" });
  });

  // The purpose's own ceiling travels to the adapter, so a provider that can enforce a size limit at
  // its edge (an S3 POST policy's content-length-range) has the number to do it with.
  it("hands the purpose's byte ceiling to the adapter", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(sign.mock.calls[0]![0]).toMatchObject({ maxBytes: UPLOAD_PURPOSES.po_attachment.maxBytes });
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

  // ── Promotion ───────────────────────────────────────────────────────────────────────────────
  //
  // A browser upload is authorised by a permit the client keeps, and that permit stays valid for
  // its whole life rather than for a single use. So without this step the client can post AGAIN,
  // after finalize has approved the bytes, and replace them: same URL, same row, different file.
  // Cloudinary refuses that itself; an S3 POST policy has no such condition, so the object is
  // instead MOVED out of the permit's reach once it has been checked.
  describe("promotion out of the permit's reach", () => {
    it("records the promoted identity, not the one the browser uploaded to", async () => {
      findByPublicId.mockResolvedValue(pendingRow());
      // A deliberately distinct key: if the row still took its identity from the browser's input,
      // this assertion could not tell the difference.
      promoteUpload.mockResolvedValue({
        provider: "spaces",
        publicId: "senthra/purchase-orders/promoted.pdf",
        resourceType: "raw",
      });
      deliveryUrl.mockReturnValue("https://cdn.example.com/senthra/purchase-orders/promoted.pdf");

      const asset = await verifyFinalize(finInput(), ACTOR);

      expect(asset.publicId).toBe("senthra/purchase-orders/promoted.pdf");
      // The stored URL must describe where the object ENDED UP, not where the browser put it.
      expect(deliveryUrl).toHaveBeenLastCalledWith(
        expect.objectContaining({ publicId: "senthra/purchase-orders/promoted.pdf" }),
      );
      expect(asset.url).toBe("https://cdn.example.com/senthra/purchase-orders/promoted.pdf");
    });

    // Ordering is the guarantee. Promote anything before it has been checked and the object under
    // the served key is one nobody has looked inside.
    it("promotes only AFTER the content and size checks", async () => {
      findByPublicId.mockResolvedValue(pendingRow());
      const order: string[] = [];
      readRange.mockImplementation(async () => { order.push("content"); return PDF; });
      head.mockImplementation(async () => { order.push("size"); return { sizeBytes: 2048 }; });
      promoteUpload.mockImplementation(async (ref: unknown) => { order.push("promote"); return ref; });

      await verifyFinalize(finInput(), ACTOR);

      expect(order).toEqual(["content", "size", "promote"]);
    });

    it("promotes nothing when the size check rejects the upload", async () => {
      findByPublicId.mockResolvedValue(pendingRow());
      head.mockResolvedValue({ sizeBytes: 999 * 1024 * 1024 });

      await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/MB or smaller/i);
      expect(promoteUpload).not.toHaveBeenCalled();
    });
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
    confirmUpload.mockRejectedValue(new Error("That upload could not be verified."));
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
  it("does not read bytes for an image upload on a provider that decodes on ingest", async () => {
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

  // ── Spreadsheets ─────────────────────────────────────────────────────────────────────────────
  //
  // All three are `raw`, so all three reach the magic-byte pass — which is the point of accepting
  // them here rather than waving them through on their extension.

  const XLS = "application/vnd.ms-excel";
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const CSV = "text/csv";

  it("accepts a real XLSX", async () => {
    // OOXML — the same ZIP container as DOCX, so these are the correct bytes for a workbook.
    firstBytes.mockResolvedValue(DOCX);
    await expect(verifyFinalize(finInput({ mediaType: XLSX, fileName: "prices.xlsx" }), ACTOR)).resolves.toBeTruthy();
  });

  it("accepts a real legacy XLS", async () => {
    firstBytes.mockResolvedValue(OLE2);
    await expect(verifyFinalize(finInput({ mediaType: XLS, fileName: "prices.xls" }), ACTOR)).resolves.toBeTruthy();
  });

  it("accepts a plain-text CSV", async () => {
    firstBytes.mockResolvedValue(CSV_BYTES);
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "boq.csv" }), ACTOR)).resolves.toBeTruthy();
  });

  // A CSV that opens with a UTF-8 BOM is what Excel writes by default — refusing it would refuse the
  // single most common way a real CSV reaches this app.
  it("accepts a CSV written with a UTF-8 BOM", async () => {
    firstBytes.mockResolvedValue(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CSV_BYTES]));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "boq.csv" }), ACTOR)).resolves.toBeTruthy();
  });

  // THE case the negative check exists for: CSV has no signature, so without it an .exe renamed
  // .csv would be stored with nothing having looked inside it.
  it("rejects an executable wearing a .csv label", async () => {
    firstBytes.mockResolvedValue(EXE);
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /isn't a valid CSV/i,
    );
  });

  it("rejects an archive wearing a .csv label", async () => {
    firstBytes.mockResolvedValue(DOCX); // ZIP header
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /isn't a valid CSV/i,
    );
  });

  // A binary whose header is not in the list is still caught: a NUL byte is not text.
  it("rejects binary content with an unlisted header wearing a .csv label", async () => {
    firstBytes.mockResolvedValue(Buffer.from([0x11, 0x22, 0x33, 0x00, 0x44]));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /isn't a valid CSV/i,
    );
  });

  // The message never names the format it detected. An attachment field must not double as a file
  // identification oracle, and the honest user who picked the wrong file is not helped by knowing.
  it("does not disclose what the rejected CSV actually was", async () => {
    firstBytes.mockResolvedValue(EXE);
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /^That file isn't a valid CSV\.$/,
    );
  });

  // ── The "MZ" false positive ──────────────────────────────────────────────────────────────────
  //
  // `MZ` is two printable letters, and the header check matched them as a Windows executable — so a
  // genuine parts list whose first cell is the SKU prefix `MZ1200` was refused as a renamed .exe,
  // AFTER the whole file had uploaded, with a message that deliberately would not say why.
  //
  // The fix is not "stop checking CSVs". It is that a two-byte all-printable prefix is not evidence:
  // a real PE is caught a layer earlier by the text sweep, because its DOS header, stub and `PE\0\0`
  // marker are full of NULs long before byte 128. These pin both halves — the false positive gone,
  // the executable still refused.
  it("accepts a CSV whose first cell starts with the letters MZ", async () => {
    firstBytes.mockResolvedValue(Buffer.from("MZ1200,Bracket,4\nMZ1201,Bracket,8\n", "utf8"));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "parts.csv" }), ACTOR)).resolves.toBeTruthy();
  });

  it("accepts a multiline CSV with quoted fields and accented text", async () => {
    // Bytes >= 0x80 are text: a UTF-8 supplier name is not a binary tell.
    firstBytes.mockResolvedValue(
      Buffer.from('code,supplier,qty\r\n"A-1","Müller & Co, Ltd",12\r\n"B-2","Ø Fabrikk",3\r\n', "utf8"),
    );
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "boq.csv" }), ACTOR)).resolves.toBeTruthy();
  });

  // Every other all-printable prefix a real CSV could plausibly open with. None of these is a
  // catalogued header, and none may be refused for looking like one.
  it.each([
    ["a single column with no delimiter at all", "PartNumber\nMZ1200\nMZ1201\n"],
    ["a header row of ordinary words", "description,qty\nCable tray 3m,12\n"],
    ["a leading percent that is not %PDF", "%complete,stage\n80,fit-out\n"],
    ["a leading GIF-like token that is not GIF8", "GIF,format,count\nyes,animated,3\n"],
  ])("accepts %s", async (_label, text) => {
    firstBytes.mockResolvedValue(Buffer.from(text, "utf8"));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "x.csv" }), ACTOR)).resolves.toBeTruthy();
  });

  // A REAL PE, not just its two-letter prefix: the MS-DOS stub as every linker emits it. The point
  // is that demoting `MZ` cost nothing — this is still refused, by the text sweep.
  it("still rejects a genuine PE executable wearing a .csv label", async () => {
    const dosHeader = Buffer.alloc(64);
    dosHeader.write("MZ", 0, "ascii");
    dosHeader.writeUInt16LE(0x0090, 2); // e_cblp
    dosHeader.writeUInt32LE(0x00000080, 0x3c); // e_lfanew — NUL-bearing, as it must be
    const stub = Buffer.from("This program cannot be run in DOS mode.\r\r\n$\0\0\0\0\0\0\0", "binary");
    firstBytes.mockResolvedValue(Buffer.concat([dosHeader, stub, Buffer.from("PE\0\0", "binary")]));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /^That file isn't a valid CSV\.$/,
    );
  });

  // The rest of the catalogue, each by its own real header bytes.
  it.each([
    ["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]],
    ["Mach-O", [0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]],
    ["Java class", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]],
    ["RAR", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
    ["7-Zip", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ["gzip", [0x1f, 0x8b, 0x08, 0x00]],
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["GIF", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00]],
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]],
    ["PDF", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]],
  ])("still rejects %s bytes wearing a .csv label", async (_label, bytes) => {
    firstBytes.mockResolvedValue(Buffer.from(bytes));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "payload.csv" }), ACTOR)).rejects.toThrow(
      /^That file isn't a valid CSV\.$/,
    );
  });

  // The text sweep is the general rule, so a control byte anywhere in the probe is refused — not
  // only a NUL, and not only at the front.
  it.each([
    ["a NUL late in the probe", [0x61, 0x2c, 0x62, 0x0a, 0x00]],
    ["a DEL byte", [0x61, 0x2c, 0x62, 0x7f]],
    ["an ESC byte", [0x61, 0x2c, 0x62, 0x1b, 0x5b]],
  ])("rejects %s", async (_label, bytes) => {
    firstBytes.mockResolvedValue(Buffer.from(bytes));
    await expect(verifyFinalize(finInput({ mediaType: CSV, fileName: "x.csv" }), ACTOR)).rejects.toThrow(
      /isn't a valid CSV/i,
    );
  });

  // A spreadsheet label on the wrong bytes is refused the same way a PDF label is.
  it("rejects a CSV's text bytes wearing an .xls label", async () => {
    firstBytes.mockResolvedValue(CSV_BYTES);
    await expect(verifyFinalize(finInput({ mediaType: XLS, fileName: "prices.xls" }), ACTOR)).rejects.toThrow(
      /isn't a valid/i,
    );
  });

  // GRN does NOT accept spreadsheets, and the refusal is the CATALOG's, not the content check's —
  // the file never reaches a byte read. This is the backend half of the surface-aware policy.
  it("refuses a spreadsheet on the goods-receipt purpose", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ purpose: "grn_attachment" }));
    await expect(
      verifyFinalize(finInput({ purpose: "grn_attachment", mediaType: XLSX, fileName: "packing.xlsx" }), {
        ...ACTOR,
        permissions: ["goods_in.edit"],
      }),
    ).rejects.toThrow(/isn't accepted here/i);
    expect(firstBytes).not.toHaveBeenCalled();
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
  // The status-before-header rule these used to pin now lives with the read itself, in
  // lib/storage/cloudinary.test.ts. What finalize owns is the consequence: a size it cannot read is
  // a refusal, never an attachment.
  it("refuses when the size probe fails", async () => {
    head.mockRejectedValue(new Error("Could not verify the uploaded file (HTTP 404)."));
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
    expect(confirmUpload).not.toHaveBeenCalled();
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

// ── Finalize resolves the provider from the LEDGER ROW ────────────────────────────────────────
//
// An upload is authorised against one provider and finalized moments later. If an administrator
// switches provider in between, finalize must still verify the object where it was actually
// written — otherwise a perfectly good upload is refused because it was looked for on a backend it
// never touched. The active Settings provider has no say here; the row does.
//
// The Spaces adapter does not exist yet, so what these pin is the RESOLUTION: `getStorageFor` is
// asked for the provider the row names.
describe("verifyFinalize — the provider comes from the pending row", () => {
  beforeEach(() => {
    // The ACTIVE provider is deliberately the opposite of what each row says, so a test can only
    // pass by reading the row.
    activeStorage.mockResolvedValue({ id: "spaces", signUpload } as never);
  });

  it("finalizes a Cloudinary-signed upload against Cloudinary while Spaces is active", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ storageProvider: "cloudinary" }));
    await verifyFinalize(finInput(), ACTOR);
    expect(storage).toHaveBeenCalledWith(expect.objectContaining({ provider: "cloudinary" }));
  });

  it("finalizes a Spaces-signed upload against Spaces while Cloudinary is active", async () => {
    activeStorage.mockResolvedValue({ id: "cloudinary", signUpload } as never);
    findByPublicId.mockResolvedValue(pendingRow({ storageProvider: "spaces" }));
    await verifyFinalize(finInput(), ACTOR);
    expect(storage).toHaveBeenCalledWith(expect.objectContaining({ provider: "spaces" }));
  });

  it("finalizes a legacy null-provider row against Cloudinary while Spaces is active", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ storageProvider: null }));
    await verifyFinalize(finInput(), ACTOR);
    expect(storage).toHaveBeenCalledWith(expect.objectContaining({ provider: "cloudinary" }));
  });

  // A row written before the column existed has the field ABSENT, not null.
  it("finalizes a row with a MISSING provider field against Cloudinary", async () => {
    const row = pendingRow() as unknown as Record<string, unknown>;
    delete row.storageProvider;
    findByPublicId.mockResolvedValue(row as never);
    await verifyFinalize(finInput(), ACTOR);
    expect(storage).toHaveBeenCalledWith(expect.objectContaining({ provider: "cloudinary" }));
  });

  // Every asset the finalize touches — the delivery URL, the byte probe, the size read — is
  // addressed on the row's provider, not just the first call.
  it("addresses the asset on the row's provider throughout", async () => {
    findByPublicId.mockResolvedValue(pendingRow({ storageProvider: "spaces" }));
    await verifyFinalize(finInput(), ACTOR);
    for (const call of storage.mock.calls) expect(call[0]).toMatchObject({ provider: "spaces" });
    expect(deliveryUrl).toHaveBeenCalledWith(expect.objectContaining({ provider: "spaces" }));
  });
});

// The signature stamps the ACTIVE provider onto the ledger row — that is the only place the active
// provider legitimately decides anything, because this is where a NEW upload is being authorised.
describe("createSignature — stamps the active provider on the ledger row", () => {
  it("records where the upload was authorised to go", async () => {
    activeStorage.mockResolvedValue({ id: "cloudinary", signUpload } as never);
    await createSignature(sigInput(), ACTOR);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ storageProvider: "cloudinary" }));
  });
});

// ── The neutral browser envelope ──────────────────────────────────────────────────────────────
//
// What crosses to the browser, and what must NOT. The client performs the protocol it is handed; if
// it could tell which backend was on the other end it would eventually branch on it, and then every
// new provider would mean a frontend change.
describe("createSignature — the envelope handed to the browser", () => {
  it("returns the adapter's method, url and fields untouched", async () => {
    const r = await createSignature(sigInput(), ACTOR);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.cloudinary.com/v1_1/c/raw/upload");
    // Forwarded verbatim — the service does not read, rename, reorder or re-stringify a signed field.
    expect(r.fields).toEqual({
      api_key: "k",
      timestamp: "1",
      signature: "sig",
      folder: "senthra/purchase-orders",
      public_id: "uuid.pdf",
      overwrite: "false",
      upload_preset: "configured-raw",
    });
  });

  // The identity finalize will look up, so a provider that answers 204 with no body still leaves the
  // browser able to name what it uploaded.
  it("returns the full key, folder included", async () => {
    const r = await createSignature(sigInput(), ACTOR);
    expect(r.publicId).toBe("senthra/purchase-orders/uuid.pdf");
  });

  // THE property of this task. Every provider-specific concept lives inside `fields`, which is
  // opaque; none of it is a named part of the contract, and neither is the provider itself.
  it("names no provider-specific concept at the top level", async () => {
    const r = (await createSignature(sigInput(), ACTOR)) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["fields", "method", "publicId", "purpose", "url"]);
    for (const leaked of ["provider", "cloudName", "apiKey", "timestamp", "signature", "uploadPreset", "resourceType", "uploadUrl"]) {
      expect(r, leaked).not.toHaveProperty(leaked);
    }
  });

  // The upload URL necessarily names the destination host, and that is not a leak — it is where the
  // file has to go. What must not cross is a provider IDENTIFIER: a value the client could compare
  // against to decide what to do differently.
  it("carries no provider identifier the client could branch on", async () => {
    const r = (await createSignature(sigInput(), ACTOR)) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(r)) {
      if (key === "url" || key === "fields") continue;
      expect(String(value), key).not.toMatch(/^(cloudinary|spaces)$/i);
    }
  });
});

// The ledger records the provider that SIGNED, at signing time — never a second lookup that could
// disagree, and never deferred to finalize.
describe("createSignature — the provider is stamped at signing time", () => {
  it("records the id of the provider that actually signed", async () => {
    activeStorage.mockResolvedValue({ id: "cloudinary", signUpload } as never);
    await createSignature(sigInput(), ACTOR);
    expect(create.mock.calls[0]![0]).toMatchObject({ storageProvider: "cloudinary" });
  });

  // Proves the stamp follows the SIGNER rather than a separately-read setting: a provider whose
  // adapter signs the upload is the one recorded, whatever else is going on.
  it("records whichever provider signed, not a hard-coded default", async () => {
    activeStorage.mockResolvedValue({ id: "spaces", signUpload } as never);
    await createSignature(sigInput(), ACTOR);
    expect(create.mock.calls[0]![0]).toMatchObject({ storageProvider: "spaces" });
  });

  it("records the FULL key the adapter minted, so finalize can find the row", async () => {
    await createSignature(sigInput(), ACTOR);
    expect(create.mock.calls[0]![0]).toMatchObject({ publicId: "senthra/purchase-orders/uuid.pdf" });
  });

  // The existing message, preserved: a configuration problem, naming no provider internals.
  it("refuses with the configuration message when no provider is active", async () => {
    activeStorage.mockResolvedValue(null);
    await expect(createSignature(sigInput(), ACTOR)).rejects.toThrow(/uploads aren't configured/i);
    expect(create).not.toHaveBeenCalled();
  });
});

// ── Image validation on a provider that does not decode ───────────────────────────────────────
//
// Cloudinary refuses an image it cannot read, so its acceptance has always been the content check
// for photos. An object store accepts any bytes at all — so a file of arbitrary content uploaded as
// `image/png` would be stored, finalized and attached with nothing ever having looked at it.
//
// These pin the restored invariant, and pin that it is driven by the provider's CAPABILITY rather
// than by its name: a provider is asked what it does, not recognised by who it is.
describe("verifyFinalize — image content is checked when the provider does not decode", () => {
  /** A provider that stores opaque bytes, i.e. what Spaces is. */
  const opaque = () =>
    storage.mockResolvedValue({
      confirmUpload,
      deliveryUrl,
      readRange,
      destroy,
      head,
      promoteUpload,
      validatesImagesOnIngest: false,
    } as never);

  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const WEBP_BYTES = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]), // length — varies, not checked
    Buffer.from("WEBP", "ascii"),
  ]);
  /** A RIFF container that is NOT a WebP: a WAV. Passes the first anchor, fails the second. */
  const WAV_BYTES = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WAVE", "ascii"),
  ]);
  const JUNK = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);

  const photo = (mediaType: string) =>
    verifyFinalize(finInput({ purpose: "damage_photo", mediaType }), {
      ...ACTOR,
      permissions: ["inventory.adjust"],
    });

  beforeEach(() => {
    opaque();
    findByPublicId.mockResolvedValue(pendingRow({ resourceType: "image", purpose: "damage_photo" }));
  });

  it.each([
    ["image/png", PNG_BYTES],
    ["image/jpeg", JPEG_BYTES],
    ["image/gif", GIF_BYTES],
    ["image/webp", WEBP_BYTES],
  ])("accepts a real %s", async (mediaType, bytes) => {
    firstBytes.mockResolvedValue(bytes);
    await expect(photo(mediaType)).resolves.toMatchObject({ publicId: expect.any(String) });
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "refuses arbitrary bytes labelled %s",
    async (mediaType) => {
      firstBytes.mockResolvedValue(JUNK);
      await expect(photo(mediaType)).rejects.toThrow(/isn't a valid/i);
    },
  );

  it("refuses a truncated header", async () => {
    // The first three bytes of a PNG signature and nothing else.
    firstBytes.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e]));
    await expect(photo("image/png")).rejects.toThrow(/isn't a valid/i);
  });

  // THE declared-vs-actual invariant, and it is the one this codebase already applies to documents:
  // the bytes must match what the upload SAID it was, not merely be some recognised format. A JPEG
  // attached as a PNG is a mislabelled file, and the label is what everything downstream trusts.
  it("refuses JPEG bytes declared as image/png", async () => {
    firstBytes.mockResolvedValue(JPEG_BYTES);
    await expect(photo("image/png")).rejects.toThrow(/isn't a valid/i);
  });

  // `RIFF` alone is equally a WAV or an AVI, which is why the WEBP entry carries a second anchor.
  it("refuses a RIFF container that is not a WebP", async () => {
    firstBytes.mockResolvedValue(WAV_BYTES);
    await expect(photo("image/webp")).rejects.toThrow(/isn't a valid/i);
  });

  it("reads only the probe window, never the whole object", async () => {
    firstBytes.mockResolvedValue(PNG_BYTES);
    await photo("image/png");
    expect(firstBytes).toHaveBeenCalledTimes(1);
    expect(firstBytes).toHaveBeenCalledWith(expect.anything(), CONTENT_PROBE_BYTES);
  });

  // The file is already stored by the time anything can inspect it, so a rejection that only threw
  // would leave proven-invalid bytes sitting in a public bucket until the reaper's next pass.
  it("destroys the invalid object through the provider that holds it", async () => {
    firstBytes.mockResolvedValue(JUNK);
    await expect(photo("image/png")).rejects.toThrow(/isn't a valid/i);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ publicId: "senthra/purchase-orders/uuid.pdf" }));
    expect(remove).toHaveBeenCalledWith("senthra/purchase-orders/uuid.pdf");
  });

  it("keeps a valid image, destroying nothing", async () => {
    firstBytes.mockResolvedValue(PNG_BYTES);
    await photo("image/png");
    expect(destroy).not.toHaveBeenCalled();
  });

  // A read that FAILED is not a verdict on the bytes — the file may be fine and the next attempt may
  // succeed — so the ledger row is left for the reaper rather than destroying something unproven.
  it("does not destroy when the probe itself could not be read", async () => {
    firstBytes.mockRejectedValue(new Error("connection reset"));
    await expect(photo("image/png")).rejects.toThrow(/could not verify/i);
    expect(destroy).not.toHaveBeenCalled();
  });

  // Non-image uploads are unaffected: they were always checked, on every provider.
  it("still checks a document the same way", async () => {
    findByPublicId.mockResolvedValue(pendingRow());
    firstBytes.mockResolvedValue(PDF);
    await expect(verifyFinalize(finInput(), ACTOR)).resolves.toMatchObject({ fileType: "pdf" });
  });

  // THE ASYMMETRY, stated so it cannot be "tidied up" by accident. The document path has always left
  // a rejected upload for the reaper, and that behaviour predates the image check. Adding immediate
  // cleanup to the NEW check is one decision; changing the OLD one is a different decision, and this
  // pins that it was not silently made.
  it("does NOT destroy a rejected document — that path still leaves it for the reaper", async () => {
    findByPublicId.mockResolvedValue(pendingRow());
    firstBytes.mockResolvedValue(JUNK);
    await expect(verifyFinalize(finInput(), ACTOR)).rejects.toThrow(/isn't a valid/i);
    expect(destroy).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
