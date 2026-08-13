import { beforeEach, describe, expect, it, vi } from "vitest";

// The bridge between "this upload is valid" and "this record now has it". Thin by design, but it is
// where the transaction boundary lives — and a DTO read on the wrong side of that boundary describes a
// record that does not exist yet, which is invisible to every check except a real upload.
vi.mock("./upload.service.js", () => ({
  commitAttachment: vi.fn(),
  releasePending: vi.fn(),
}));
vi.mock("#modules/purchase-request/purchase-request.service.js", () => ({
  assertCanAttach: vi.fn(),
  attachUploadedAsset: vi.fn(),
  getPurchaseRequest: vi.fn(),
  recordAttachmentAudit: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({
  assertCanAttach: vi.fn(),
  attachUploadedAsset: vi.fn(),
  getPurchaseOrder: vi.fn(),
  recordAttachmentAudit: vi.fn(),
}));
vi.mock("#modules/goods-in/goods-in.service.js", () => ({
  assertCanAttach: vi.fn(),
  attachUploadedAsset: vi.fn(),
  getGoodsReceipt: vi.fn(),
  recordAttachmentAudit: vi.fn(),
}));

import * as prfService from "#modules/purchase-request/purchase-request.service.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as grnService from "#modules/goods-in/goods-in.service.js";

import { commitAttachment, releasePending } from "./upload.service.js";
import { attachTo, preCheckFor } from "./upload.targets.js";

const commit = vi.mocked(commitAttachment);
const release = vi.mocked(releasePending);

const ASSET = {
  url: "https://res.cloudinary.com/c/raw/upload/s--x--/senthra/purchase-orders/quote.pdf",
  publicId: "senthra/purchase-orders/quote.pdf",
  resourceType: "raw",
  fileName: "quote.pdf",
  fileType: "pdf",
  fileSizeBytes: 2048,
  lease: new Date("2026-08-13T06:00:00.000Z"),
};

const ACTOR = { type: "user" as const, id: "u1", email: "buyer@x.co", permissions: [] };

/** The three attach purposes, and the read each one must answer with. */
const ATTACHERS = [
  { purpose: "prf_attachment" as const, service: prfService, read: vi.mocked(prfService.getPurchaseRequest) },
  { purpose: "po_attachment" as const, service: poService, read: vi.mocked(poService.getPurchaseOrder) },
  { purpose: "grn_attachment" as const, service: grnService, read: vi.mocked(grnService.getGoodsReceipt) },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Stand in for the real transaction: run the write, and record that the commit happened.
  commit.mockImplementation(async (_asset, write) => write({} as never));
});

describe("attachTo — attach purposes", () => {
  // THE regression. Each module's attachUploadedAsset finishes by re-reading its record, and inside a
  // transaction that read cannot see the row just written — so it returned the record WITHOUT the new
  // file. The frontend sets its state from this DTO, so a successful upload emptied the list on screen.
  it.each(ATTACHERS)("reads $purpose's DTO after the commit, not inside it", async ({ purpose, read }) => {
    const order: string[] = [];
    commit.mockImplementation(async (_asset, write) => {
      await write({} as never);
      order.push("commit");
    });
    read.mockImplementation(async () => {
      order.push("read");
      return { attachments: [{ fileName: "quote.pdf" }] } as never;
    });

    const result = await attachTo(purpose, "rec1", ASSET, "Quote", ACTOR);

    expect(order).toEqual(["commit", "read"]);
    expect(result).toEqual({ attachment: { attachments: [{ fileName: "quote.pdf" }] } });
  });

  /**
   * The audit event belongs on the same side of the boundary as the DTO.
   *
   * `audit.record` writes on the default client and is fire-and-forget, so it does NOT roll back with
   * the transaction. Fired inside it — where each module used to fire it — an abort after the
   * attachment write (a Mongo write conflict, a failed pending-row delete) left the trail asserting
   * an attachment that was never committed.
   */
  it.each(ATTACHERS)("records $purpose's audit event only after the commit", async ({ purpose, service, read }) => {
    const order: string[] = [];
    commit.mockImplementation(async (_asset, write) => {
      await write({} as never);
      order.push("commit");
    });
    read.mockImplementation(async () => {
      order.push("read");
      return { id: "rec1", code: "PO-1" } as never;
    });
    vi.mocked(service.recordAttachmentAudit).mockImplementation(() => { order.push("audit"); });

    await attachTo(purpose, "rec1", ASSET, "Quote", ACTOR);

    expect(order).toEqual(["commit", "read", "audit"]);
    // Fired against the record the read just proved, so the label can never describe a stale one.
    expect(service.recordAttachmentAudit).toHaveBeenCalledWith({ id: "rec1", code: "PO-1" }, ACTOR);
  });

  it.each(ATTACHERS)("writes $purpose inside the transaction, carrying the lease", async ({ purpose, service }) => {
    vi.mocked(service.attachUploadedAsset).mockResolvedValue({} as never);
    await attachTo(purpose, "rec1", ASSET, "Quote", ACTOR);

    expect(commit).toHaveBeenCalledWith(ASSET, expect.any(Function));
    expect(service.attachUploadedAsset).toHaveBeenCalledWith(
      "rec1",
      expect.objectContaining({ publicId: ASSET.publicId, label: "Quote" }),
      ACTOR,
      expect.anything(),
    );
  });

  it("refuses an attach purpose with no record to attach to", async () => {
    await expect(attachTo("po_attachment", undefined, ASSET, undefined, ACTOR)).rejects.toThrow(/select the record/i);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("attachTo — return-url purposes", () => {
  // A job being created has no record yet, so the URL goes back to the form. The ledger row is released
  // rather than committed, because there is no attachment write to pair it with.
  it("hands back the URL and releases the ledger row", async () => {
    const result = await attachTo("job_attachment", undefined, ASSET, undefined, ACTOR);

    expect(result).toEqual({ url: ASSET.url });
    expect(release).toHaveBeenCalledWith(ASSET.publicId);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("preCheckFor", () => {
  it.each(ATTACHERS)("gives $purpose its module's own guard", ({ purpose, service }) => {
    void preCheckFor(purpose)?.("rec1", 2048, "Quote", ACTOR);
    expect(service.assertCanAttach).toHaveBeenCalled();
  });

  // Nothing to guard before the upload — there is no record yet.
  it("has no guard for a return-url purpose", () => {
    expect(preCheckFor("job_attachment")).toBeNull();
  });
});
