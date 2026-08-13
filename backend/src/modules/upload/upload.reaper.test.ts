import { beforeEach, describe, expect, it, vi } from "vitest";

// The reaper destroys assets the browser uploaded and never came back for. Everything here is about
// the one thing it must never do: delete a file something is using.
vi.mock("./upload.repository.js", () => ({
  create: vi.fn(),
  findByPublicId: vi.fn(),
  claim: vi.fn(),
  remove: vi.fn(),
  findReapable: vi.fn(),
}));
vi.mock("../../lib/cloudinary.js", () => ({ destroyFromCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));

import * as pendingRepo from "./upload.repository.js";
import { destroyFromCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { reapAbandonedUploads } from "./upload.reaper.js";

const findReapable = vi.mocked(pendingRepo.findReapable);
const claim = vi.mocked(pendingRepo.claim);
const remove = vi.mocked(pendingRepo.remove);
const destroy = vi.mocked(destroyFromCloudinary);
const creds = vi.mocked(getCloudinaryCreds);

const row = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  publicId: "senthra/jobs/abandoned.pdf",
  resourceType: "raw",
  purpose: "job_attachment",
  actorId: "u1",
  createdAt: new Date("2026-08-01T00:00:00Z"),
  claimExpiresAt: null,
  ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  creds.mockResolvedValue({ cloudName: "c", apiKey: "k", apiSecret: "s" });
  claim.mockResolvedValue(new Date(Date.now() + 60_000));
  destroy.mockResolvedValue(undefined);
  remove.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("reapAbandonedUploads — what it destroys", () => {
  it("destroys an abandoned upload and clears its ledger row", async () => {
    findReapable.mockResolvedValue([row()]);
    const r = await reapAbandonedUploads();
    expect(destroy).toHaveBeenCalledWith("senthra/jobs/abandoned.pdf", "raw", expect.anything());
    expect(remove).toHaveBeenCalledWith("senthra/jobs/abandoned.pdf");
    expect(r.destroyed).toBe(1);
  });

  it("does nothing when there is nothing to reap", async () => {
    findReapable.mockResolvedValue([]);
    const r = await reapAbandonedUploads();
    expect(destroy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 0, destroyed: 0 });
  });

  // Only rows old enough that the browser is certainly not coming back. A fresh upload mid-flight is
  // never in the candidate set at all.
  it("only asks for rows older than the abandonment window", async () => {
    findReapable.mockResolvedValue([]);
    const now = new Date("2026-08-13T12:00:00Z");
    await reapAbandonedUploads(now);
    const cutoff = findReapable.mock.calls[0]![0];
    expect(cutoff.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
  });
});

describe("reapAbandonedUploads — it cannot interrupt a finalize", () => {
  // The whole concurrency mechanism. Both sides take the row through the same conditional update, so
  // exactly one wins — a finalize that is running holds a live lease and this skips the row.
  it("skips a row whose lease it could not take", async () => {
    findReapable.mockResolvedValue([row()]);
    claim.mockResolvedValue(null);
    const r = await reapAbandonedUploads();
    expect(destroy).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: 1, destroyed: 0 });
  });

  // Re-taken PER ROW, not once for the batch: a finalize may have started between the query and this
  // row's turn, and that is what makes the two mutually exclusive rather than merely unlikely.
  it("claims every row individually", async () => {
    findReapable.mockResolvedValue([row({ publicId: "a" }), row({ publicId: "b" }), row({ publicId: "c" })]);
    await reapAbandonedUploads();
    expect(claim).toHaveBeenCalledTimes(3);
    expect(claim.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("keeps going after a row it lost", async () => {
    findReapable.mockResolvedValue([row({ publicId: "a" }), row({ publicId: "b" })]);
    claim.mockResolvedValueOnce(null).mockResolvedValueOnce(new Date(Date.now() + 60_000));
    const r = await reapAbandonedUploads();
    expect(r).toMatchObject({ skipped: 1, destroyed: 1 });
    expect(destroy).toHaveBeenCalledWith("b", "raw", expect.anything());
  });
});

describe("reapAbandonedUploads — failure handling", () => {
  // Keep the row: its lease expires in a minute and the next pass tries again. Dropping it would leave
  // the asset with nothing left to find it by.
  it("leaves the row in place when the destroy fails", async () => {
    findReapable.mockResolvedValue([row()]);
    destroy.mockRejectedValue(new Error("503"));
    const r = await reapAbandonedUploads();
    expect(remove).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1, destroyed: 0 });
  });

  it("carries on to the next row after one fails", async () => {
    findReapable.mockResolvedValue([row({ publicId: "a" }), row({ publicId: "b" })]);
    destroy.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(undefined);
    const r = await reapAbandonedUploads();
    expect(r).toMatchObject({ failed: 1, destroyed: 1 });
  });

  // Without credentials there is nothing to destroy WITH. Deleting the ledger anyway would throw away
  // the only record that the asset exists.
  it("leaves every row alone when Cloudinary is not configured", async () => {
    findReapable.mockResolvedValue([row(), row({ publicId: "b" })]);
    creds.mockResolvedValue(null);
    const r = await reapAbandonedUploads();
    expect(destroy).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: 2 });
  });
});

// `countRefs` counts the three attachment tables only. A job or van-stock attachment lives in a
// `String[]`, so it would read as zero references and the reaper would destroy a file that is on
// screen. The ledger row is the safety mechanism instead: it exists only between "we authorised an
// upload" and "someone claimed it", and finalize removes it in the same transaction as the attachment
// write — so an attached asset has no row for the reaper to find.
describe("reapAbandonedUploads — safety mechanism", () => {
  it("never consults the attachment reference count", async () => {
    findReapable.mockResolvedValue([row()]);
    const attachmentModule = await import("#modules/attachment/attachment.repository.js");
    const spy = vi.spyOn(attachmentModule, "countRefs");
    await reapAbandonedUploads();
    expect(spy).not.toHaveBeenCalled();
  });

  it("decides purely from its own ledger", async () => {
    findReapable.mockResolvedValue([row()]);
    await reapAbandonedUploads();
    // Only the ledger and Cloudinary were touched — no domain table was read to reach the decision.
    expect(findReapable).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
