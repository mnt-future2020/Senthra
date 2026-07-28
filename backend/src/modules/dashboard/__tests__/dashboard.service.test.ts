import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({
  countSubmitted: vi.fn(async () => 4),
  createdSince: vi.fn(async () => []),
  submittedWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  openSummary: vi.fn(async () => ({ count: 2, valuePence: 1000 })),
  expectedDeliveries: vi.fn(async () => ({ dueThisWeek: 3, overdue: 1 })),
  pipelineCounts: vi.fn(async () => []),
  issuedSpendSince: vi.fn(async () => []),
  createdSince: vi.fn(async () => []),
  fastPathDraftWorklist: vi.fn(async () => []),
  statusWorklist: vi.fn(async () => []),
  receivableWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/job/job.repository.js", () => ({
  countActive: vi.fn(async () => 7),
  createdSince: vi.fn(async () => []),
  dueBreakdown: vi.fn(async () => ({ overdue: 3, dueThisWeek: 2 })),
}));
vi.mock("#modules/job-kit-request/job-kit-request.repository.js", () => ({
  pendingWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/van-stock-request/van-stock-request.repository.js", () => ({
  pendingWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({
  lowStockCounts: vi.fn(async () => ({ count: 5, criticalCount: 2 })),
}));
// The Reorder-needed card takes the inventory service's scope-keyed summary (the reorder maths is
// far too heavy to run per dashboard load — see getReorderSummary); mocking it also keeps the heavy
// inventory-service import graph out of this unit test. The derivation of these three numbers from
// the raw suggestions is covered in inventory/reorder-summary.test.ts.
vi.mock("#modules/inventory/inventory.service.js", () => ({
  getReorderSummary: vi.fn(async () => ({ count: 2, criticalCount: 1, supplierGaps: 1 })),
}));
vi.mock("#modules/audit/audit.repository.js", () => ({ findMany: vi.fn(async () => []) }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({
  completedReceiptsSince: vi.fn(async () => [{ at: new Date() }, { at: new Date(Date.now() - 20 * 86_400_000) }]),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  countOverdueUnreconciledJobs: vi.fn(async () => 6),
}));

// warehouseScopeFilter → undefined (unscoped) for a plain admin.
vi.mock("../../../lib/warehouse-access.js", () => ({ warehouseScopeFilter: vi.fn(() => undefined) }));

import * as invRepo from "#modules/inventory/inventory.repository.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as auditRepo from "#modules/audit/audit.repository.js";
import { buildDashboardSummary } from "../dashboard.service.js";
import type { Principal } from "../../../types/principal.js";

// A minimal PRF worklist row (the service only reads id/code/title/priority/createdAt).
const prfRow = (i: number) => ({ id: `p${i}`, code: `PRF-${i}`, title: "Acme", priority: null, createdAt: new Date() });

const admin = { type: "admin", id: "a1", email: "a@x.com", name: "A" } as unknown as Principal;
const finance = {
  type: "user",
  id: "f1",
  permissions: ["purchase_requests.view", "purchase_requests.approve"],
  assignedWarehouseIds: null,
} as unknown as Principal;

describe("buildDashboardSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes every card section for an admin", async () => {
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.cards.pendingPrfs?.count).toBe(4);
    expect(summary.cards.openPos?.count).toBe(2);
    expect(summary.cards.activeJobs?.count).toBe(7);
    expect(summary.cards.activeJobs?.overdueCount).toBe(3);
    expect(summary.cards.activeJobs?.dueThisWeekCount).toBe(2);
    expect(summary.cards.lowStock?.count).toBe(5);
    // Passed straight through from the inventory service's summary.
    expect(summary.cards.reorderNeeded).toEqual({ count: 2, criticalCount: 1, supplierGaps: 1 });
    expect(summary.cards.expectedThisWeek).toEqual({ dueThisWeek: 3, overdue: 1 });
    // 2 completed GRNs mocked: one today (inside the 7-day pulse), one 20 days ago (outside).
    expect(summary.cards.goodsReceived?.count).toBe(1);
    expect(summary.cards.goodsReceived?.weeklyReceived).toHaveLength(8);
    expect(summary.cards.overdueHoldings).toEqual({ count: 6, days: 14 });
    expect(typeof summary.generatedAt).toBe("string");
    expect(summary.errors ?? []).toEqual([]); // nothing failed
  });

  it("defaults the spend window to 12 monthly buckets and echoes the period", async () => {
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.charts.spendPeriod).toBe("12m");
    expect(summary.charts.spendTrend).toHaveLength(12);
    expect(summary.charts.spendTrend?.[0]?.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("buckets 90d weekly and 30d daily when spendPeriod is passed", async () => {
    const q = await buildDashboardSummary(admin, { spendPeriod: "90d" });
    expect(q.summary.charts.spendPeriod).toBe("90d");
    expect(q.summary.charts.spendTrend).toHaveLength(13); // 13 ISO weeks
    expect(q.summary.charts.spendTrend?.[0]?.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const m = await buildDashboardSummary(admin, { spendPeriod: "30d" });
    expect(m.summary.charts.spendPeriod).toBe("30d");
    expect(m.summary.charts.spendTrend).toHaveLength(30);
  });

  it("omits sections the actor lacks permission for (and does not flag them as errors)", async () => {
    const { summary } = await buildDashboardSummary(finance);
    expect(summary.cards.pendingPrfs).toBeDefined(); // has purchase_requests.view
    expect(summary.cards.openPos).toBeUndefined(); // no purchase_orders.view
    expect(summary.cards.activeJobs).toBeUndefined();
    expect(summary.charts.spendTrend).toBeUndefined();
    expect(summary.activity).toBeUndefined(); // no audit.view
    expect(summary.errors ?? []).toEqual([]); // absent ≠ errored
  });

  it("degrades gracefully when one permitted section throws", async () => {
    vi.mocked(invRepo.lowStockCounts).mockRejectedValueOnce(new Error("mongo down"));
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.cards.lowStock).toBeUndefined(); // failed section dropped
    expect(summary.errors).toContain("lowStock"); // …but surfaced
    expect(summary.cards.pendingPrfs?.count).toBe(4); // the rest still returns
    expect(summary.charts.poPipeline).toBeDefined();
  });

  it("worklist total is exact and not truncated when no queue hits its fetch cap", async () => {
    vi.mocked(prfRepo.submittedWorklist).mockResolvedValueOnce([prfRow(1), prfRow(2), prfRow(3)]);
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.worklist?.total).toBe(3);
    expect(summary.worklist?.truncated).toBe(false);
    expect(summary.worklist?.items).toHaveLength(3);
  });

  it("caps the returned items at 10 and flags truncated when a queue returns its full cap (50)", async () => {
    // 50 PRFs = the per-queue fetch cap → the true backlog may exceed the merged count.
    vi.mocked(prfRepo.submittedWorklist).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => prfRow(i)),
    );
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.worklist?.items).toHaveLength(10); // only the top slice ships to the widget
    expect(summary.worklist?.total).toBe(50); // floor
    expect(summary.worklist?.truncated).toBe(true); // …flagged as a floor → FE renders "50+"
  });

  it("recent activity excludes auth events (they belong to the audit trail, not the ops pulse)", async () => {
    vi.mocked(auditRepo.findMany).mockResolvedValueOnce([
      { id: "e1", createdAt: new Date(), actorEmail: "a@x.com", action: "purchase_order.approved", targetType: "purchase_order", targetLabel: "PO-1", targetId: "po1" },
    ] as unknown as Awaited<ReturnType<typeof auditRepo.findMany>>);

    const { summary } = await buildDashboardSummary(admin);

    // The activity query is scoped to non-auth events at the DB layer (so the page never comes back
    // short from post-fetch filtering).
    expect(auditRepo.findMany).toHaveBeenCalledWith({ excludeActionPrefix: "auth." }, 0, 10);
    expect(summary.activity).toHaveLength(1);
    expect(summary.activity?.[0].action).toBe("purchase_order.approved");
  });
});
