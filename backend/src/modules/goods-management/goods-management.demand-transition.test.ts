import { beforeEach, describe, expect, it, vi } from "vitest";

// ── The goods-status transition that keeps newly-added kit visible as demand ────────────────────
//
// `reopenIssuanceForAddedKitTx` is one conditional `updateMany`, and the WHERE is the whole design, so
// this file inspects it directly rather than through a service. Three things have to hold and none of
// them is obvious from reading the call site:
//
//   1. It moves a job OUT of `issued` / `awaiting_return` — the two states getOpenDemand skips.
//   2. It never touches `reconciled`, which is terminal and locked.
//   3. It is ONE atomic conditional write, not read-then-write, so it cannot lose a race with a
//      return posting landing at the same instant.
//
// Prisma is mocked at the client so the `where` is captured verbatim — the same technique
// rentalHire.guard.test.ts uses for the hire predicates, and for the same reason: what matters here is
// the query, not a return value.
const { updateMany } = vi.hoisted(() => ({
  updateMany: vi.fn(async (_args: { where: unknown; data: unknown }) => ({ count: 1 })),
}));

vi.mock("../../lib/prisma.js", () => ({
  prisma: { jobStockSummary: { updateMany } },
  withTransaction: vi.fn(),
  isWriteConflict: vi.fn(() => false),
}));

import { reopenIssuanceForAddedKitTx } from "./goods-management.repository.js";

const JOB_ID = "a".repeat(24);
const tx = { jobStockSummary: { updateMany } } as never;

beforeEach(() => vi.clearAllMocks());

describe("reopenIssuanceForAddedKitTx", () => {
  const capturedWhere = () => updateMany.mock.calls[0]![0].where as { jobId: string; goodsStatus: { in: string[] } };
  const capturedData = () => updateMany.mock.calls[0]![0].data as { goodsStatus: string };

  it("targets only the job it was given", async () => {
    await reopenIssuanceForAddedKitTx(tx, JOB_ID);
    expect(capturedWhere().jobId).toBe(JOB_ID);
  });

  // The two states getOpenDemand skips, and therefore the two a job must not be left in once it is
  // owed stock again.
  it("moves a job out of the states demand ignores", async () => {
    await reopenIssuanceForAddedKitTx(tx, JOB_ID);
    expect(capturedWhere().goodsStatus.in).toEqual(["issued", "awaiting_return"]);
  });

  // `reconciled` is terminal — the ledger is closed and re-opening it here would be a silent way past
  // the explicit refusals both kit-growth paths already make.
  it("never re-opens a reconciled job", async () => {
    await reopenIssuanceForAddedKitTx(tx, JOB_ID);
    expect(capturedWhere().goodsStatus.in).not.toContain("reconciled");
  });

  // `partially_issued`, not `not_issued`: stock HAS been issued against this job, and `not_issued`
  // would tell the warehouse queue and the edit-job line locks otherwise.
  it("lands on partially_issued", async () => {
    await reopenIssuanceForAddedKitTx(tx, JOB_ID);
    expect(capturedData().goodsStatus).toBe("partially_issued");
  });

  // A job already in a state demand counts needs no move, and `count: 0` is that answer — not a
  // failure the caller should treat as one.
  it("reports zero rows moved without throwing when nothing needed moving", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(reopenIssuanceForAddedKitTx(tx, JOB_ID)).resolves.toBe(0);
  });

  // ONE write, evaluated atomically by Mongo. A read-then-write here could lose to a return posting
  // committing between the two halves.
  it("is a single conditional write, not a read-then-write", async () => {
    await reopenIssuanceForAddedKitTx(tx, JOB_ID);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  // It must run inside the caller's transaction — the same one as the kit merge — so the kit and the
  // status can never diverge. Passing `tx` through rather than reaching for the module-level client is
  // what makes that possible.
  it("writes through the transaction it was handed", async () => {
    const txUpdateMany = vi.fn(async () => ({ count: 1 }));
    await reopenIssuanceForAddedKitTx({ jobStockSummary: { updateMany: txUpdateMany } } as never, JOB_ID);
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
