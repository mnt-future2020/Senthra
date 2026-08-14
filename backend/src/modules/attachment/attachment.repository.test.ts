import { beforeEach, describe, expect, it, vi } from "vitest";

const { count } = vi.hoisted(() => ({ count: { prf: vi.fn(), po: vi.fn(), grn: vi.fn() } }));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    purchaseRequestAttachment: { count: count.prf },
    purchaseOrderAttachment: { count: count.po },
    goodsReceiptAttachment: { count: count.grn },
  },
}));

import { countRefs } from "./attachment.repository.js";

beforeEach(() => {
  for (const c of Object.values(count)) c.mockReset().mockResolvedValue(0);
});

describe("countRefs", () => {
  it("sums references across every attachment table", async () => {
    count.prf.mockResolvedValue(1);
    count.po.mockResolvedValue(1);
    count.grn.mockResolvedValue(2);
    expect(await countRefs("raw", "senthra/x.pdf")).toBe(4);
  });

  // The identity is the PAIR. Filtering on publicId alone would let an `image` asset vouch for a
  // `raw` one that happens to share its id — a reference that does not exist, reported as one, and
  // in the other direction the same mistake lets a live file be destroyed.
  it("matches on resourceType AND publicId, in every table", async () => {
    await countRefs("raw", "senthra/purchase-orders/q.pdf");
    for (const [name, c] of Object.entries(count)) {
      expect(c, name).toHaveBeenCalledWith({
        where: { resourceType: "raw", publicId: "senthra/purchase-orders/q.pdf" },
      });
    }
  });

  it("reports zero when nothing anywhere references the asset", async () => {
    expect(await countRefs("raw", "senthra/orphan.pdf")).toBe(0);
  });

  // Every table, every time — not just the ones that can currently share an asset. Narrowing this
  // to PRF+PO would be cheaper and would make the next module to copy an attachment unsafe by
  // default, which is the failure mode this whole design is avoiding.
  it("queries all three tables even when the first already has a hit", async () => {
    count.prf.mockResolvedValue(1);
    await countRefs("raw", "senthra/x.pdf");
    expect(count.po).toHaveBeenCalled();
    expect(count.grn).toHaveBeenCalled();
  });

  // A count that throws must reach the caller, so releaseAsset can refuse to delete on unknown
  // state. Swallowing it here would return 0 — "no references" — and destroy a live asset.
  it("propagates a database failure rather than reporting zero", async () => {
    count.po.mockRejectedValue(new Error("mongo unreachable"));
    await expect(countRefs("raw", "senthra/x.pdf")).rejects.toThrow("mongo unreachable");
  });
});
