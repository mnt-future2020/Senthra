import { beforeEach, describe, expect, it, vi } from "vitest";

// The safety-bearing half of attachment cleanup. Every branch here exists to answer one question:
// can this destroy a Cloudinary asset that a committed row still references? The required invariant
// is that it cannot, and that when it can't prove safety it leaves an orphan instead.
vi.mock("./attachment.repository.js", () => ({ countRefs: vi.fn() }));
// The STORAGE LAYER is mocked, not a vendor transport. `releaseAsset` now asks which provider holds
// the asset and calls `destroy` on it — so what these tests pin is that it resolves the provider
// from the ASSET and addresses the object by both halves of its identity, which is the same
// invariant as before expressed through the abstraction.
const { destroy } = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({
  getStorageFor: vi.fn(),
  // The REAL convention, not a stub: these tests are about null meaning Cloudinary.
  normalizeProviderId: (v: string | null | undefined) => (v === "spaces" ? "spaces" : "cloudinary"),
}));

import { countRefs } from "./attachment.repository.js";
import { getStorageFor } from "../../lib/storage/index.js";
import { releaseAsset } from "./attachment.service.js";

const refs = vi.mocked(countRefs);
const storage = vi.mocked(getStorageFor);

const RAW = { provider: null, publicId: "senthra/purchase-orders/abc.pdf", resourceType: "raw" };
/**
 * The ref `releaseAsset` hands to the storage layer for a row with NO provider recorded.
 *
 * The row says `null`; what reaches `destroy` is the NORMALISED id, "cloudinary". That difference is
 * the convention under test — null is not passed through as an absence, it is resolved to the
 * provider every legacy asset actually lives on.
 */
const refOf = (publicId: string, resourceType: string) => ({ provider: "cloudinary", publicId, resourceType });

beforeEach(() => {
  refs.mockReset().mockResolvedValue(0);
  destroy.mockReset().mockResolvedValue(undefined);
  storage.mockReset().mockResolvedValue({ destroy } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("releaseAsset — the destroy decision", () => {
  it("destroys an asset nothing references, addressed by BOTH halves of its identity", async () => {
    await releaseAsset(RAW, "purchase_order PO-0001");
    expect(destroy).toHaveBeenCalledTimes(1);
    // resourceType is not decoration: `destroy` on the wrong type answers "not found" for a file
    // that is still there, which would look like a successful cleanup and leak silently.
    expect(destroy).toHaveBeenCalledWith(refOf(RAW.publicId, RAW.resourceType));
  });

  it("counts references using the PAIR, never publicId alone", async () => {
    await releaseAsset(RAW, "ctx");
    expect(refs).toHaveBeenCalledWith(RAW.provider, RAW.resourceType, RAW.publicId);
  });

  it("passes an image asset's own resourceType through", async () => {
    await releaseAsset({ provider: null, publicId: "senthra/goods-in/photo", resourceType: "image" }, "ctx");
    expect(destroy).toHaveBeenCalledWith(refOf("senthra/goods-in/photo", "image"));
  });
});

// THE invariant. PRF → PO conversion copies an attachment's identity rather than re-uploading the
// file, so one asset can be named by two rows; removing either must not delete a file the other
// still displays.
describe("releaseAsset — a surviving reference always wins", () => {
  it("does not destroy while one other row still references the asset", async () => {
    refs.mockResolvedValue(1);
    await releaseAsset(RAW, "purchase_order PO-0001");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not destroy however many references remain", async () => {
    for (const n of [1, 2, 7]) {
      destroy.mockClear();
      refs.mockResolvedValue(n);
      await releaseAsset(RAW, "ctx");
      expect(destroy, `${n} refs`).not.toHaveBeenCalled();
    }
  });

  // A surviving reference is the normal shared-asset case, not a fault — logging it as an error
  // would train whoever reads the logs to ignore the lines that DO matter.
  it("treats a surviving reference as ordinary, not a failure", async () => {
    refs.mockResolvedValue(1);
    await expect(releaseAsset(RAW, "ctx")).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("destroys once the last reference is gone", async () => {
    refs.mockResolvedValue(0);
    await releaseAsset(RAW, "purchase_request PRF-0001");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

// Rows written before identity was persisted store a URL and nothing else. The pair could be
// PARSED back out of that URL, and doing so is the one shortcut that could address — and destroy —
// the wrong file. Leaving the asset is the conservative half of that trade.
describe("releaseAsset — legacy rows without identity", () => {
  it("skips a row with no publicId, and says so", async () => {
    await releaseAsset({ provider: null, publicId: null, resourceType: "raw" }, "purchase_request PRF-0009");
    expect(destroy).not.toHaveBeenCalled();
    expect(refs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PRF-0009"));
  });

  it("skips a row with no resourceType — half an identity addresses nothing", async () => {
    await releaseAsset({ provider: null, publicId: "senthra/jobs/x.pdf", resourceType: null }, "ctx");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("skips a row with neither", async () => {
    await releaseAsset({ provider: null, publicId: null, resourceType: null }, "ctx");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("never infers identity from anything — no destroy call is attempted at all", async () => {
    await releaseAsset({ provider: null, publicId: "", resourceType: "raw" }, "ctx");
    expect(destroy).not.toHaveBeenCalled();
  });
});

// Cleanup runs AFTER the business operation has committed. Nothing it can discover is grounds for
// failing work that is already done.
describe("releaseAsset — failure is never the caller's failure", () => {
  it("swallows a Cloudinary error and logs the asset for later", async () => {
    destroy.mockRejectedValue(new Error("503 from Cloudinary"));
    await expect(releaseAsset(RAW, "goods_receipt GRN-0004")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(RAW.publicId),
      expect.stringContaining("503"),
    );
  });

  it("logs the resourceType too, so the failure is actionable without guessing", async () => {
    destroy.mockRejectedValue(new Error("boom"));
    await releaseAsset(RAW, "ctx");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("raw/"), expect.anything());
  });

  it("swallows a reference-count failure rather than destroying on unknown state", async () => {
    refs.mockRejectedValue(new Error("mongo unreachable"));
    await expect(releaseAsset(RAW, "ctx")).resolves.toBeUndefined();
    // The important half: an unreadable reference count must NOT be read as "no references".
    expect(destroy).not.toHaveBeenCalled();
  });

  it("skips cleanly when the asset's own provider isn't configured", async () => {
    storage.mockResolvedValue(null);
    await expect(releaseAsset(RAW, "ctx")).resolves.toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not configured"));
  });
});

// Ordering is the whole concurrency argument: the count runs after the caller's delete has
// committed, so a racing removal can only ever produce a skip, never a premature destroy.
describe("releaseAsset — concurrent removals of a shared asset", () => {
  it("leaves an orphan when both sides still see each other (the safe outcome)", async () => {
    refs.mockResolvedValue(1); // each side's count still sees the other's row
    await Promise.all([releaseAsset(RAW, "purchase_request PRF-1"), releaseAsset(RAW, "purchase_order PO-1")]);
    expect(destroy).not.toHaveBeenCalled(); // a leaked file, and no lost one
  });

  it("destroys at most harmlessly when both sides see zero", async () => {
    refs.mockResolvedValue(0);
    await Promise.all([releaseAsset(RAW, "purchase_request PRF-1"), releaseAsset(RAW, "purchase_order PO-1")]);
    // Two destroys of one id: the second is a no-op ("not found" is success). Idempotence is what
    // makes this safe without a lock.
    expect(destroy).toHaveBeenCalledTimes(2);
    for (const call of destroy.mock.calls) expect(call).toEqual([refOf(RAW.publicId, RAW.resourceType)]);
  });

  it("destroys exactly once when only the later side sees zero", async () => {
    refs.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await releaseAsset(RAW, "purchase_order PO-1"); // committed first, still sees the PRF row
    await releaseAsset(RAW, "purchase_request PRF-1"); // last one out
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

// ── Provider-from-row ─────────────────────────────────────────────────────────────────────────
//
// THE invariant of this change: which backend holds an EXISTING asset is decided by the row, never
// by whichever provider Settings currently selects. Get it wrong and switching provider silently
// stops every older file from being deletable — nothing errors, the files simply accumulate.
//
// The Spaces adapter does not exist yet, so what these pin is the RESOLUTION: `getStorageFor` is
// asked for the provider the row names. That is the decision under test; which client comes back is
// Task 5's concern.
describe("releaseAsset — the provider comes from the row", () => {
  const refWith = (provider: string | null) => ({
    provider,
    publicId: "senthra/purchase-orders/abc.pdf",
    resourceType: "raw",
  });

  it('resolves a row stored on "cloudinary" to Cloudinary', async () => {
    await releaseAsset(refWith("cloudinary"), "ctx");
    expect(storage).toHaveBeenCalledWith({ provider: "cloudinary" });
    expect(destroy).toHaveBeenCalledWith(refWith("cloudinary"));
  });

  it('resolves a row stored on "spaces" to Spaces — NOT to the active provider', async () => {
    await releaseAsset(refWith("spaces"), "ctx");
    expect(storage).toHaveBeenCalledWith({ provider: "spaces" });
    expect(destroy).toHaveBeenCalledWith(refWith("spaces"));
  });

  // The legacy shape: every row written before the column existed. Null is a COMPLETE value here,
  // not a missing one, so it must resolve rather than skip.
  it("resolves a null provider to Cloudinary rather than skipping the asset", async () => {
    await releaseAsset(refWith(null), "ctx");
    expect(storage).toHaveBeenCalledWith({ provider: "cloudinary" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  // An unrecognised string is read as Cloudinary rather than throwing: a cleanup path must not be
  // the thing that discovers a typo, and Cloudinary is where every legacy asset actually is.
  it("falls back to Cloudinary for an unrecognised stored value", async () => {
    await releaseAsset(refWith("s3-someday"), "ctx");
    expect(storage).toHaveBeenCalledWith({ provider: "cloudinary" });
  });

  it("counts references scoped to the row's own provider", async () => {
    await releaseAsset(refWith("spaces"), "ctx");
    expect(refs).toHaveBeenCalledWith("spaces", "raw", "senthra/purchase-orders/abc.pdf");
  });

  // The whole point, stated once: nothing in this path reads Settings.
  it("never consults the active provider", async () => {
    await releaseAsset(refWith("spaces"), "ctx");
    for (const call of storage.mock.calls) expect(call[0]).toEqual({ provider: "spaces" });
  });
});
