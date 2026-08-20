import { describe, expect, it, vi } from "vitest";

// buildWhere is a pure where-clause builder; stub Prisma so importing the repository does no I/O.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { purchaseRequest: { updateMany: vi.fn() } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { buildWhere, LIVE_PO, reworkPrfWhere, revertConversion, withRelations } from "./purchase-request.repository.js";

// "Rejected — needs rework" counts drafts that were SENT BACK — `status: draft` plus a rejection
// reason. Its badge pointed at `?status=draft`, which is every draft in the module: a badge reading
// 3 opened a list of 9, six of them requests the reader had just started and nobody had rejected.
//
// Same shape as the purchase-order badge that read 14 and opened 7. The cure is the same too: one
// predicate, exported, used by the count AND by the list the count opens.
describe("buildWhere — the `rework` derived pseudo-status", () => {
  it("narrows to drafts that carry a rejection reason, not every draft", () => {
    expect(buildWhere({ status: "rework" }).AND).toEqual([
      { status: "draft", rejectionReason: { not: null } },
    ]);
  });

  it("opens exactly the rows the badge counts", () => {
    expect(buildWhere({ status: "rework" }).AND).toEqual([reworkPrfWhere()]);
  });

  // The distinction the old href lost: a plain draft is somebody's work in progress, not a backlog.
  it("is not the same filter as ?status=draft", () => {
    expect(buildWhere({ status: "draft" }).status).toBe("draft");
    expect(buildWhere({ status: "draft" }).AND).toBeUndefined();
  });

  // `not: null` is $ne, which excludes null AND missing — the safe direction here. A draft whose
  // rejectionReason was never written must NOT count as rework.
  it("requires the reason to be present, so an unset one never matches", () => {
    expect(reworkPrfWhere().rejectionReason).toEqual({ not: null });
  });

  // AND'd rather than assigned to `where.status`, so the search OR further down cannot clobber it —
  // the same composition the PO list uses for its derived statuses.
  it("still composes with warehouse scoping and search", () => {
    const where = buildWhere({ status: "rework", warehouseIds: ["w1"], search: "acme" });
    expect(where.AND).toEqual([reworkPrfWhere(), { warehouseId: { in: ["w1"] } }]);
    expect(where.OR).toBeDefined();
  });

  it("leaves a real status as a plain equality filter", () => {
    expect(buildWhere({ status: "submitted" }).status).toBe("submitted");
  });
});


// A request rendered a "View PO-0051" button for an order that had been deleted; clicking it landed
// on "Purchase order not found." The include was fetching every PO row, deleted ones included, so
// nothing on the request could tell that the order was gone.
describe("the linked purchase order is LIVE only", () => {
  it("filters deleted orders out of the include", () => {
    expect(withRelations.purchaseOrders.where).toEqual(LIVE_PO);
  });

  // Mongo: `{ deletedAt: null }` alone misses a row whose create omitted the field, which would put
  // every pre-existing order back on the request.
  it("accepts both the null and the missing shape", () => {
    expect(LIVE_PO.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
  });
});

describe("revertConversion — giving a request back when its order is deleted", () => {
  const updateMany = prisma.purchaseRequest.updateMany as ReturnType<typeof vi.fn>;
  const ID = "a".repeat(24);

  it("only moves a CONVERTED request, and only a live one", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await revertConversion(ID, "buyer@example.com");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "converted", deletedAt: null },
      data: { status: "approved", updatedBy: "buyer@example.com" },
    });
  });

  // The affected-row count is what decides the winner: two deletes racing must not both report
  // having made the move, or the audit trail shows it twice.
  it("reports whether THIS call was the one that moved it", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await expect(revertConversion(ID, null)).resolves.toBe(true);
    updateMany.mockResolvedValue({ count: 0 });
    await expect(revertConversion(ID, null)).resolves.toBe(false);
  });
});
