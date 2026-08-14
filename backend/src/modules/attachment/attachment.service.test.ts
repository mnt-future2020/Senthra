import { beforeEach, describe, expect, it, vi } from "vitest";

// The safety-bearing half of attachment cleanup. Every branch here exists to answer one question:
// can this destroy a Cloudinary asset that a committed row still references? The required invariant
// is that it cannot, and that when it can't prove safety it leaves an orphan instead.
vi.mock("./attachment.repository.js", () => ({ countRefs: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ destroyFromCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));

import { countRefs } from "./attachment.repository.js";
import { destroyFromCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { releaseAsset } from "./attachment.service.js";

const refs = vi.mocked(countRefs);
const destroy = vi.mocked(destroyFromCloudinary);
const creds = vi.mocked(getCloudinaryCreds);

const CREDS = { cloudName: "c", apiKey: "k", apiSecret: "s" };
const RAW = { publicId: "senthra/purchase-orders/abc.pdf", resourceType: "raw" };

beforeEach(() => {
  refs.mockReset().mockResolvedValue(0);
  destroy.mockReset().mockResolvedValue(undefined);
  creds.mockReset().mockResolvedValue(CREDS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("releaseAsset — the destroy decision", () => {
  it("destroys an asset nothing references, addressed by BOTH halves of its identity", async () => {
    await releaseAsset(RAW, "purchase_order PO-0001");
    expect(destroy).toHaveBeenCalledTimes(1);
    // resourceType is not decoration: `destroy` on the wrong type answers "not found" for a file
    // that is still there, which would look like a successful cleanup and leak silently.
    expect(destroy).toHaveBeenCalledWith(RAW.publicId, RAW.resourceType, CREDS);
  });

  it("counts references using the PAIR, never publicId alone", async () => {
    await releaseAsset(RAW, "ctx");
    expect(refs).toHaveBeenCalledWith(RAW.resourceType, RAW.publicId);
  });

  it("passes an image asset's own resourceType through", async () => {
    await releaseAsset({ publicId: "senthra/goods-in/photo", resourceType: "image" }, "ctx");
    expect(destroy).toHaveBeenCalledWith("senthra/goods-in/photo", "image", CREDS);
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
    await releaseAsset({ publicId: null, resourceType: "raw" }, "purchase_request PRF-0009");
    expect(destroy).not.toHaveBeenCalled();
    expect(refs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PRF-0009"));
  });

  it("skips a row with no resourceType — half an identity addresses nothing", async () => {
    await releaseAsset({ publicId: "senthra/jobs/x.pdf", resourceType: null }, "ctx");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("skips a row with neither", async () => {
    await releaseAsset({ publicId: null, resourceType: null }, "ctx");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("never infers identity from anything — no destroy call is attempted at all", async () => {
    await releaseAsset({ publicId: "", resourceType: "raw" }, "ctx");
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

  it("skips cleanly when Cloudinary isn't configured", async () => {
    creds.mockResolvedValue(null);
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
    for (const call of destroy.mock.calls) expect(call).toEqual([RAW.publicId, RAW.resourceType, CREDS]);
  });

  it("destroys exactly once when only the later side sees zero", async () => {
    refs.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await releaseAsset(RAW, "purchase_order PO-1"); // committed first, still sees the PRF row
    await releaseAsset(RAW, "purchase_request PRF-1"); // last one out
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
