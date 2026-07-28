import { principalGrants } from "../../types/principal.js";
import type { Principal } from "../../types/principal.js";
import { warehouseScopeFilter } from "../../lib/warehouse-access.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as kitRepo from "#modules/job-kit-request/job-kit-request.repository.js";
import * as vsrRepo from "#modules/van-stock-request/van-stock-request.repository.js";
import * as invRepo from "#modules/inventory/inventory.repository.js";
// The Reorder-needed card reuses the workbench's OWN read (same netting, same scoping) — the
// dashboard number and the workbench list can never disagree.
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as auditRepo from "#modules/audit/audit.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import { bucketByWeek, bucketByMonth, bucketValueByWeek, bucketValueByDay } from "../../utils/time-buckets.js";
import { compareWorklist, type WorklistItem } from "./worklist.js";
import type { DashboardSummary, DashboardCards, DashboardCharts, SpendPeriod } from "./dashboard.types.js";

// Dashboard tuning knobs — all magic numbers live here, none inline.
const SPARK_WEEKS = 8;
const SPEND_MONTHS = 12;
const SPEND_90D_WEEKS = 13; // 90 days ≈ 13 ISO weeks
const SPEND_30D_DAYS = 30;
const GRN_PULSE_DAYS = 7; // "Goods received" card counts completed GRNs in this window
const OVERDUE_HOLDINGS_DAYS = 14; // must match the Goods Management "Overdue" view's default
// Each source queue is DB-capped at this many rows (see the repos' `take:`). A queue that returns
// EXACTLY this many may have more behind it, so `total` becomes a floor and we flag `truncated`.
const WORKLIST_QUERY_CAP = 50;
// How many merged worklist items we return to the client (the FE shows the top 10; a few extra give
// headroom without shipping the whole backlog to a summary widget).
const WORKLIST_RETURN_CAP = 10;
const ACTIVITY_LIMIT = 10;

export const SPEND_PERIODS = ["12m", "90d", "30d"] as const;
export function isSpendPeriod(v: unknown): v is SpendPeriod {
  return typeof v === "string" && (SPEND_PERIODS as readonly string[]).includes(v);
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// A named unit of work: only run when `enabled` (permission holds); on rejection its `key`
// is recorded and the value becomes undefined so the dashboard degrades section-by-section.
interface Section<T> {
  key: string;
  enabled: boolean;
  run: () => Promise<T>;
}
function section<T>(key: string, enabled: boolean, run: () => Promise<T>): Section<T> {
  return { key, enabled, run };
}

/**
 * Run named sections concurrently, isolating failures. Returns a map of key → value for
 * sections that succeeded, plus the keys that were enabled-but-threw. Permission-disabled
 * sections are simply absent from both (never counted as errors).
 */
async function settle(
  sections: Array<Section<unknown>>,
): Promise<{ values: Record<string, unknown>; errors: string[] }> {
  const enabled = sections.filter((s) => s.enabled);
  const settled = await Promise.allSettled(enabled.map((s) => s.run()));
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  settled.forEach((r, i) => {
    const key = enabled[i].key;
    if (r.status === "fulfilled") {
      values[key] = r.value;
    } else {
      errors.push(key);
      // 5xx-worthy detail, logged not thrown — the section degrades instead of failing the request.
      console.error(`[dashboard] section "${key}" failed:`, r.reason);
    }
  });
  return { values, errors };
}

// `actor` is the broad Principal (admin | user | customer) — that's what req.principal is.
// principalGrants short-circuits admin → true; warehouseScopeFilter reads assignedWarehouseIds
// structurally (absent on admin/customer → unrestricted). Do NOT narrow to UserPrincipal: an
// admin principal has no assignedWarehouseIds/firstName and would fail to typecheck.
export async function buildDashboardSummary(
  actor: Principal,
  opts: { now?: Date; spendPeriod?: SpendPeriod } = {},
): Promise<{ summary: DashboardSummary }> {
  const now = opts.now ?? new Date();
  const spendPeriod: SpendPeriod = opts.spendPeriod ?? "12m";
  const scope = warehouseScopeFilter(actor); // string[] | undefined
  const sparkSince = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - SPARK_WEEKS * 7),
  );
  // The spend query window + bucketing granularity follow the selected period.
  const spendSince =
    spendPeriod === "12m"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (SPEND_MONTHS - 1), 1))
      : spendPeriod === "90d"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (SPEND_90D_WEEKS * 7 - 1)))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (SPEND_30D_DAYS - 1)));
  const bucketSpend = (rows: Array<{ at: Date; value: number }>) =>
    spendPeriod === "12m"
      ? bucketByMonth(rows, SPEND_MONTHS, now)
      : spendPeriod === "90d"
        ? bucketValueByWeek(rows, SPEND_90D_WEEKS, now)
        : bucketValueByDay(rows, SPEND_30D_DAYS, now);
  const grnPulseSince = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - GRN_PULSE_DAYS),
  );

  const can = (key: string) => principalGrants(actor, key);
  const canPrf = can("purchase_requests.view");
  const canPo = can("purchase_orders.view");
  const canJobs = can("jobs.view");
  const canInv = can("inventory.view");
  const canAudit = can("audit.view");
  const canGrn = can("goods_in.view");
  const canGm = can("goods_management.view");

  // Worklist queue permissions.
  const qReviewPrf = can("purchase_requests.approve");
  const qApprovePo = can("purchase_orders.approve");
  const qSendPo = can("purchase_orders.send");
  const qAckPo = can("purchase_orders.acknowledge");
  const qReceive = can("goods_in.create");
  const qKit = can("jobs.kit_request.review");
  const qVsr = can("van_stock_request.review");

  // The "send to supplier" action restricts a pm_review PO to its assigned PM UNLESS the actor can
  // override (holds "*" or purchase_orders.assign_pm) — mirror that here so an admin / assign_pm holder
  // sees every pending send, not an empty queue. (The "record acceptance" action has no PM restriction
  // at all, so its queue is warehouse-scoped only — no pmUserId filter.)
  const canOverridePm = can("purchase_orders.assign_pm");

  // Each section is keyed by its response field so a failure maps back to what the FE renders.
  // Worklist queues share the "worklist" key: if any queue fails the worklist degrades as a unit.
  const { values, errors } = await settle([
    section("pendingPrfs", canPrf, async () => ({
      count: await prfRepo.countSubmitted(scope),
      weeklyCreated: bucketByWeek(await prfRepo.createdSince(sparkSince, scope), SPARK_WEEKS, now),
    })),
    section("openPos", canPo, async () => {
      const [open, created] = await Promise.all([
        poRepo.openSummary(scope),
        poRepo.createdSince(sparkSince, scope),
      ]);
      return {
        count: open.count,
        valuePence: open.valuePence,
        weeklyCreated: bucketByWeek(created, SPARK_WEEKS, now),
      };
    }),
    section("activeJobs", canJobs, async () => {
      // NOTE: jobs are deliberately NOT warehouse-scoped — a job's kit lines can span warehouses,
      // so there is no single owning warehouse to scope by (unlike PRFs/POs/stock).
      const [count, created, due] = await Promise.all([
        jobRepo.countActive(),
        jobRepo.createdSince(sparkSince),
        jobRepo.dueBreakdown(now),
      ]);
      return {
        count,
        weeklyCreated: bucketByWeek(created, SPARK_WEEKS, now),
        overdueCount: due.overdue,
        dueThisWeekCount: due.dueThisWeek,
      };
    }),
    section("lowStock", canInv, async () => invRepo.lowStockCounts(scope)),
    // Scope-keyed + short-TTL inside the inventory service: the reorder maths is far heavier than a
    // repo count, and this card is fetched on every dashboard load. See getReorderSummary.
    section("reorderNeeded", canInv, async () => inventoryService.getReorderSummary(actor)),
    section("expectedThisWeek", canPo, async () => poRepo.expectedDeliveries(now, scope)),
    section("goodsReceived", canGrn, async () => {
      // One read covers both figures: the 8-week spark and the 7-day pulse count.
      const rows = await grnRepo.completedReceiptsSince(sparkSince, scope);
      return {
        count: rows.filter((r) => r.at >= grnPulseSince).length,
        weeklyReceived: bucketByWeek(rows, SPARK_WEEKS, now),
      };
    }),
    section("overdueHoldings", canGm, async () => {
      const cutoff = new Date(now.getTime() - OVERDUE_HOLDINGS_DAYS * 86_400_000);
      return {
        count: await gmRepo.countOverdueUnreconciledJobs(cutoff, scope),
        days: OVERDUE_HOLDINGS_DAYS,
      };
    }),
    section("poPipeline", canPo, async () => poRepo.pipelineCounts(scope)),
    section("spendTrend", canPo, async () => bucketSpend(await poRepo.issuedSpendSince(spendSince, scope))),
    section("activity", canAudit, async () => {
      // Dashboard "Recent Activity" is an OPERATIONAL pulse (POs, stock, deliveries…), so it drops
      // auth login/logout/refresh — those are frequent enough to drown out business events and
      // belong to the security audit trail, not the ops feed. The full Audit Log page still shows
      // them (it passes no exclusion). Filtering at the query means we get the last N *business*
      // events, never a short page from post-fetch dropping.
      const rows = await auditRepo.findMany({ excludeActionPrefix: "auth." }, 0, ACTIVITY_LIMIT);
      return rows.map((a) => ({
        id: a.id,
        at: a.createdAt,
        actorName: a.actorEmail ?? "System",
        action: a.action,
        entity: { type: a.targetType ?? "", code: a.targetLabel ?? a.targetId ?? "", id: a.targetId ?? "" },
      }));
    }),
    section(
      "worklist",
      qReviewPrf || qApprovePo || qSendPo || qAckPo || qReceive || qKit || qVsr,
      async () => {
        const [wlPrf, wlFastPath, wlPending, wlPmReview, wlSent, wlReceive, wlKit, wlVsr] = await Promise.all([
          qReviewPrf ? prfRepo.submittedWorklist(scope) : Promise.resolve([]),
          qApprovePo ? poRepo.fastPathDraftWorklist(scope) : Promise.resolve([]),
          qApprovePo ? poRepo.statusWorklist("pending_approval", { warehouseIds: scope }) : Promise.resolve([]),
          qSendPo ? poRepo.statusWorklist("pm_review", { pmUserId: canOverridePm ? undefined : actor.id, warehouseIds: scope }) : Promise.resolve([]),
          qAckPo ? poRepo.statusWorklist("sent", { warehouseIds: scope }) : Promise.resolve([]),
          qReceive ? poRepo.receivableWorklist(scope) : Promise.resolve([]),
          qKit ? kitRepo.pendingWorklist() : Promise.resolve([]),
          qVsr ? vsrRepo.pendingWorklist(scope) : Promise.resolve([]),
        ]);
        const items: WorklistItem[] = [];
        const push = (row: WorklistItem) => items.push(row);
        // Detail routes are /dashboard/<module>/[id] where [id] accepts the DB id OR the code — and the
        // app-wide convention is that LIST ROWS LINK BY CODE (confirmed in the PRF/PO/job detail pages).
        // So hrefs use r.code (PRF-####, PO-####) / jobNumber, matching every other list in the app.
        for (const r of wlPrf)
          push({ kind: "review_prf", id: r.id, code: r.code, title: r.title, priority: r.priority, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-requests/${r.code}` });
        for (const r of wlFastPath)
          push({ kind: "approve_po_fastpath", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
        for (const r of wlPending)
          push({ kind: "review_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
        for (const r of wlPmReview)
          push({ kind: "send_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
        for (const r of wlSent)
          push({ kind: "acknowledge_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
        for (const r of wlReceive)
          push({ kind: "receive_goods", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
        // Kit request: code = the JKR (JKR-####); title/link target = its job (JOB-YYYY-####), where the PM acts.
        for (const r of wlKit)
          push({ kind: "review_kit_request", id: r.id, code: r.code, title: r.jobNumber, priority: null, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/jobs/${r.jobNumber}` });
        // Van stock request: code = VSR-####; title = who's asking; priority feeds the urgency band.
        // Deep-links to the OWNING warehouse's Van Requests tab (final warehouse, or the pending
        // restock's collection warehouse) — the queue lives inside the warehouse, not top-level.
        for (const r of wlVsr)
          push({ kind: "review_van_stock_request", id: r.id, code: r.code, title: `${r.engineerName} — ${r.type === "return" ? "stock return" : "restock"}`, priority: r.priority === "normal" ? null : r.priority, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: r.targetWarehouseCode ? `/dashboard/warehouses/${r.targetWarehouseCode}?tab=van` : "/dashboard/warehouses" });
        items.sort((a, b) => compareWorklist(a, b, now));
        // `total` is the merged backlog size. It is EXACT unless some queue returned its full cap —
        // then more rows exist behind that queue, so `total` is a floor and `truncated` says so
        // (the FE renders "10 of 50+"). No extra count queries: we infer it from the cap-hit.
        const truncated = [wlPrf, wlFastPath, wlPending, wlPmReview, wlSent, wlReceive, wlKit, wlVsr].some(
          (q) => q.length >= WORKLIST_QUERY_CAP,
        );
        return { items: items.slice(0, WORKLIST_RETURN_CAP), total: items.length, truncated };
      },
    ),
  ]);

  const cards: DashboardCards = {};
  if (values.pendingPrfs) cards.pendingPrfs = values.pendingPrfs as DashboardCards["pendingPrfs"];
  if (values.openPos) cards.openPos = values.openPos as DashboardCards["openPos"];
  if (values.activeJobs) cards.activeJobs = values.activeJobs as DashboardCards["activeJobs"];
  if (values.lowStock) cards.lowStock = values.lowStock as DashboardCards["lowStock"];
  if (values.reorderNeeded) cards.reorderNeeded = values.reorderNeeded as DashboardCards["reorderNeeded"];
  if (values.expectedThisWeek) cards.expectedThisWeek = values.expectedThisWeek as DashboardCards["expectedThisWeek"];
  if (values.goodsReceived) cards.goodsReceived = values.goodsReceived as DashboardCards["goodsReceived"];
  if (values.overdueHoldings) cards.overdueHoldings = values.overdueHoldings as DashboardCards["overdueHoldings"];

  const charts: DashboardCharts = {};
  if (values.poPipeline) charts.poPipeline = values.poPipeline as DashboardCharts["poPipeline"];
  if (values.spendTrend) {
    charts.spendTrend = values.spendTrend as DashboardCharts["spendTrend"];
    charts.spendPeriod = spendPeriod;
  }

  const summary: DashboardSummary = { generatedAt: now.toISOString(), cards, charts };
  if (values.worklist) summary.worklist = values.worklist as DashboardSummary["worklist"];
  if (values.activity) summary.activity = values.activity as DashboardSummary["activity"];
  if (errors.length > 0) summary.errors = errors;
  return { summary };
}
