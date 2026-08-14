import { describe, expect, it, vi } from "vitest";

// buildWhere is a pure where-clause builder; stub Prisma so importing the repository does no I/O.
vi.mock("../../lib/prisma.js", () => ({ prisma: {}, withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import { buildWhere, reworkPrfWhere } from "./purchase-request.repository.js";

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
