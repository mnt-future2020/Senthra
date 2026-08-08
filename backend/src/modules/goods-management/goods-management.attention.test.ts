import { beforeEach, describe, expect, it, vi } from "vitest";

// The per-warehouse split of "Job kit to issue" and "Returns to receive" — the two counts behind the
// Goods Management tab's number and a large part of the Warehouses list's column.
//
// The warehouse lives on the job's KIT LINES, one relation hop from the summary row being counted, so
// Mongo cannot group it. The attribution is done in memory, and it has to match what the flat count
// measures: ONE summary row per job, in the queue of every warehouse whose lines are on that job.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { jobStockSummary: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { countGoodsAttentionByWarehouse } from "./goods-management.repository.js";

const findMany = prisma.jobStockSummary.findMany as ReturnType<typeof vi.fn>;
/** First call is "to issue", second is "awaiting return" — they run as one Promise.all. */
const summaries = (toIssue: unknown[], awaitingReturn: unknown[] = []) =>
  findMany.mockResolvedValueOnce(toIssue).mockResolvedValueOnce(awaitingReturn);
const job = (...warehouseIds: (string | null)[]) => ({
  job: { kitLines: warehouseIds.map((warehouseId) => ({ warehouseId })) },
});

beforeEach(() => vi.clearAllMocks());

describe("countGoodsAttentionByWarehouse", () => {
  it("puts a job kitted from two warehouses in BOTH queues", async () => {
    // Each warehouse has its own lines to pick — this is two pieces of work, not one counted twice.
    summaries([job("w1", "w2")]);
    expect((await countGoodsAttentionByWarehouse()).toIssue).toEqual({ w1: 1, w2: 1 });
  });

  it("counts a job ONCE at a warehouse holding several of its lines", async () => {
    // The flat count counts SUMMARY ROWS (one per job), so the split has to as well — three lines at
    // w1 are one job in w1's queue, not three.
    summaries([job("w1", "w1", "w1")]);
    expect((await countGoodsAttentionByWarehouse()).toIssue).toEqual({ w1: 1 });
  });

  it("skips misc lines, which carry no warehouse at all", async () => {
    // Free text, handed over by count and never stock-tracked — it cannot belong to a warehouse queue.
    summaries([job("w1", null)]);
    expect((await countGoodsAttentionByWarehouse()).toIssue).toEqual({ w1: 1 });
  });

  it("drops a job entirely when every line is misc", async () => {
    summaries([job(null, null)]);
    expect((await countGoodsAttentionByWarehouse()).toIssue).toEqual({});
  });

  it("keeps the two queues separate", async () => {
    summaries([job("w1")], [job("w2"), job("w2")]);
    const out = await countGoodsAttentionByWarehouse();
    expect(out.toIssue).toEqual({ w1: 1 });
    expect(out.awaitingReturn).toEqual({ w2: 2 });
  });

  it("never reports a warehouse outside the actor's scope", async () => {
    // The job reaches a w1-scoped actor because it has a w1 line; its w2 leg is not their business.
    summaries([job("w1", "w2")]);
    expect((await countGoodsAttentionByWarehouse(["w1"])).toIssue).toEqual({ w1: 1 });
  });

  // The predicates must stay identical to countGoodsAttention's, or a tab and the sidebar badge above
  // it would disagree about the same queue.
  it("selects the same jobs the flat count does", async () => {
    await countGoodsAttentionByWarehouse(["w1"]);
    const [issueArgs, returnArgs] = findMany.mock.calls.map((c) => c[0]);
    expect(issueArgs.where.goodsStatus).toEqual({ in: ["not_issued", "partially_issued"] });
    expect(issueArgs.where.job.is).toMatchObject({
      deletedAt: null,
      status: { in: ["assigned", "accepted", "in_progress"] },
      kitLines: { some: { warehouseId: { in: ["w1"] } } },
    });
    // A job can sit in awaiting_return after completion, so that queue only excludes cancelled/deleted.
    expect(returnArgs.where.goodsStatus).toBe("awaiting_return");
    expect(returnArgs.where.job.is).toMatchObject({ deletedAt: null, status: { not: "cancelled" } });
  });

  it("reads warehouse ids only — no rows are materialised", async () => {
    await countGoodsAttentionByWarehouse();
    expect(findMany.mock.calls[0][0].select).toEqual({
      job: { select: { kitLines: { select: { warehouseId: true } } } },
    });
  });

  it("returns empty maps when nothing is outstanding", async () => {
    summaries([], []);
    expect(await countGoodsAttentionByWarehouse()).toEqual({ toIssue: {}, awaitingReturn: {} });
  });
});
