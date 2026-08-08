import { beforeEach, describe, expect, it, vi } from "vitest";

// Draft receipts per warehouse — one of the counts on the Warehouses list and on a warehouse's
// Incoming stock tab. The flat count goes through buildWhere; this one writes its predicate directly,
// so the two can drift, and a row disagreeing with the badge above it is the failure the whole
// attention rework exists to remove. Hence the same-predicate assertion.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { goodsReceipt: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { count, countDraftsByWarehouse } from "./goods-in.repository.js";

const groupBy = prisma.goodsReceipt.groupBy as ReturnType<typeof vi.fn>;
const flatCount = prisma.goodsReceipt.count as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("countDraftsByWarehouse", () => {
  it("keys the counts by warehouse and unwraps the grouping", async () => {
    groupBy.mockResolvedValue([
      { warehouseId: "wh1", _count: { _all: 2 } },
      { warehouseId: "wh2", _count: { _all: 1 } },
    ]);
    expect(await countDraftsByWarehouse()).toEqual({ wh1: 2, wh2: 1 });
  });

  it("selects the same receipts as the flat count", async () => {
    await countDraftsByWarehouse(["wh1"]);
    await count({ status: "draft", warehouseIds: ["wh1"] });
    expect(groupBy.mock.calls.at(-1)?.[0].where).toEqual(flatCount.mock.calls.at(-1)?.[0].where);
  });

  it("excludes soft-deleted drafts", async () => {
    await countDraftsByWarehouse();
    expect(groupBy.mock.calls.at(-1)?.[0].where).toMatchObject({ deletedAt: null, status: "draft" });
  });

  it("applies no warehouse filter for an unscoped caller", async () => {
    await countDraftsByWarehouse();
    expect(groupBy.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
  });

  // A warehouse with no drafts produces no group; the column renders a dash there, so the absence has
  // to stay an absence rather than becoming a zero.
  it("returns an empty map when there are no drafts anywhere", async () => {
    groupBy.mockResolvedValue([]);
    expect(await countDraftsByWarehouse()).toEqual({});
  });
});
