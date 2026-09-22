import { beforeEach, describe, expect, it, vi } from "vitest";

const { count } = vi.hoisted(() => ({
  count: { prf: vi.fn(), po: vi.fn(), grn: vi.fn(), job: vi.fn(), hire: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    purchaseRequestAttachment: { count: count.prf },
    purchaseOrderAttachment: { count: count.po },
    goodsReceiptAttachment: { count: count.grn },
    jobAttachment: { count: count.job },
    rentalReceiptAttachment: { count: count.hire },
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
    count.hire.mockResolvedValue(3);
    expect(await countRefs(null, "raw", "senthra/x.pdf")).toBe(7);
  });

  // Condition photographs on a hire delivery are in the count too. A table left out of it is a table
  // whose rows do not protect their asset, and the failure is silent — the file just disappears from a
  // live record. This is the assertion that makes adding the table non-optional.
  it("counts hire-delivery condition photos", async () => {
    count.hire.mockResolvedValue(1);
    expect(await countRefs(null, "image", "senthra/hire/cond.jpg")).toBe(1);
  });

  // The identity is the TRIPLE. Filtering on publicId alone would let an `image` asset vouch for a
  // `raw` one that happens to share its id — a reference that does not exist, reported as one, and
  // in the other direction the same mistake lets a live file be destroyed. The provider is the third
  // coordinate: the same key on two backends is two different files.
  it("matches on provider AND resourceType AND publicId, in every table", async () => {
    await countRefs(null, "raw", "senthra/purchase-orders/q.pdf");
    for (const [name, c] of Object.entries(count)) {
      expect(c, name).toHaveBeenCalledWith({
        where: {
          resourceType: "raw",
          publicId: "senthra/purchase-orders/q.pdf",
          OR: [
            { storageProvider: null },
            { storageProvider: { isSet: false } },
            { storageProvider: "cloudinary" },
          ],
        },
      });
    }
  });

  it("reports zero when nothing anywhere references the asset", async () => {
    expect(await countRefs(null, "raw", "senthra/orphan.pdf")).toBe(0);
  });

  // Every table, every time — not just the ones that can currently share an asset. Narrowing this
  // to PRF+PO would be cheaper and would make the next module to copy an attachment unsafe by
  // default, which is the failure mode this whole design is avoiding.
  it("queries every table even when the first already has a hit", async () => {
    count.prf.mockResolvedValue(1);
    await countRefs(null, "raw", "senthra/x.pdf");
    expect(count.po).toHaveBeenCalled();
    expect(count.grn).toHaveBeenCalled();
    expect(count.job).toHaveBeenCalled();
    expect(count.hire).toHaveBeenCalled();
  });

  // A count that throws must reach the caller, so releaseAsset can refuse to delete on unknown
  // state. Swallowing it here would return 0 — "no references" — and destroy a live asset.
  it("propagates a database failure rather than reporting zero", async () => {
    count.po.mockRejectedValue(new Error("mongo unreachable"));
    await expect(countRefs(null, "raw", "senthra/x.pdf")).rejects.toThrow("mongo unreachable");
  });
});

// ── Provider scoping ──────────────────────────────────────────────────────────────────────────
//
// `null` means Cloudinary, and matching it is the one query in this file that can destroy data if
// it is wrong. A row written before the column existed has the field ABSENT, not null, and in this
// Prisma + MongoDB setup a bare `{ field: null }` does not match an absent field. Miss those rows
// and they count as zero references — so their live files are destroyed. See
// lib/__tests__/null-vs-absent.test.ts, which fails the build on an unpaired occurrence.
describe("countRefs — provider scoping", () => {
  const whereOf = (c: { mock: { calls: unknown[][] } }) =>
    (c.mock.calls[0]![0] as { where: Record<string, unknown> }).where;

  it("matches BOTH an explicit null and a missing field when resolving Cloudinary", async () => {
    await countRefs(null, "raw", "senthra/legacy.pdf");
    expect(whereOf(count.prf).OR).toEqual([
      { storageProvider: null },
      { storageProvider: { isSet: false } },
      { storageProvider: "cloudinary" },
    ]);
  });

  it('treats an explicit "cloudinary" exactly as it treats null', async () => {
    await countRefs("cloudinary", "raw", "senthra/x.pdf");
    expect(whereOf(count.prf).OR).toEqual([
      { storageProvider: null },
      { storageProvider: { isSet: false } },
      { storageProvider: "cloudinary" },
    ]);
  });

  // A non-legacy provider always writes the column, so it needs no null branch — and must NOT get
  // one, or a Cloudinary row would vouch for a Spaces asset that shares its key.
  it("matches a non-legacy provider exactly, with no null fallback", async () => {
    await countRefs("spaces", "object", "senthra/jobs/uuid/Report.pdf");
    const where = whereOf(count.prf);
    expect(where).toEqual({
      resourceType: "object",
      publicId: "senthra/jobs/uuid/Report.pdf",
      storageProvider: "spaces",
    });
    expect(where.OR).toBeUndefined();
  });

  it("scopes by provider in EVERY table, not just the first", async () => {
    await countRefs("spaces", "object", "senthra/x");
    for (const [name, c] of Object.entries(count)) {
      expect(whereOf(c as never), name).toMatchObject({ storageProvider: "spaces" });
    }
  });
});
