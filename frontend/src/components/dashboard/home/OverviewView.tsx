"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";

import { relativeTime } from "@/components/dashboard/audit/auditDisplay";
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import { NoAccessHome } from "@/components/dashboard/shell/NoAccessHome";
import { getDashboardSummary, type DashboardSummary, type SpendPeriod } from "@/services/dashboard.service";
import { StatCard } from "./StatCard";
import { SpendTrendChart } from "./SpendTrendChart";
import { PipelineBars } from "./PipelineBars";
import { WorklistPanel } from "./WorklistPanel";
import { ActivityFeed } from "./ActivityFeed";
import { QuickActions } from "./QuickActions";

// How often the summary silently refreshes while the tab is visible, and how often the
// "Updated X ago" caption re-renders. An ops dashboard left open must not go stale.
const REFRESH_MS = 60_000;
const CAPTION_TICK_MS = 30_000;

// The Overview screen. Fetches the aggregated summary and composes the widgets in spec order.
// Sections the actor can't see are absent from the payload and simply not rendered; a permitted
// section that failed server-side is listed in `errors` and surfaced as a soft notice.
// The first load shows a skeleton; every later load (interval / focus / manual / period change)
// is silent — existing data stays on screen and is swapped when the fresh payload lands.
export function OverviewView() {
  const [summary, setSummary] = React.useState<DashboardSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The signature (sorted keys) of the errored-section set the user last dismissed. The banner
  // stays hidden while the live errors match it, so a silent auto-refresh returning the SAME
  // failures won't re-surface it — but a genuinely new failure (different set) shows again.
  const [dismissedErrorSig, setDismissedErrorSig] = React.useState<string | null>(null);
  const [spendPeriod, setSpendPeriod] = React.useState<SpendPeriod>("12m");

  // Re-render the "Updated X ago" caption without refetching.
  const [, setCaptionTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setCaptionTick((n) => n + 1), CAPTION_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Monotonic guard: a slow older response must never overwrite a newer one.
  const fetchSeq = React.useRef(0);
  const load = React.useCallback(async (period: SpendPeriod) => {
    const seq = ++fetchSeq.current;
    // Yield one microtask so an effect-triggered load never sets state synchronously
    // inside the effect body (react-hooks/set-state-in-effect).
    await Promise.resolve();
    if (seq !== fetchSeq.current) return;
    setRefreshing(true);
    try {
      const s = await getDashboardSummary(period);
      if (seq !== fetchSeq.current) return;
      setSummary(s);
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to load the dashboard.");
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial load + reload when the spend window changes (async IIFE — the fetch settles state
  // in continuations, never synchronously in the effect body).
  React.useEffect(() => {
    void (async () => {
      await load(spendPeriod);
    })();
  }, [load, spendPeriod]);

  // Keep it fresh: silent refetch on an interval (only while the tab is visible) and on refocus.
  React.useEffect(() => {
    const refetch = () => {
      if (document.visibilityState === "visible") void load(spendPeriod);
    };
    const t = setInterval(refetch, REFRESH_MS);
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [load, spendPeriod]);

  if (loading && !summary) return <OverviewSkeleton />;

  if (error && !summary) {
    return (
      <div className="border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--neg)]" style={{ borderRadius: "var(--radius)" }}>
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void load(spendPeriod)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-colors hover:border-[var(--accent)]"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  if (!summary) return null;

  const { cards, charts, worklist, activity, errors } = summary;
  // Stable signature of the errored-section set — order-independent so re-ordered but identical
  // failures still count as "the same" and stay dismissed.
  const errorSig = errors && errors.length > 0 ? [...errors].sort().join(",") : null;
  const showErrors = errorSig !== null && errorSig !== dismissedErrorSig;
  const hasCards = Boolean(
    cards.pendingPrfs || cards.openPos || cards.activeJobs || cards.lowStock || cards.reorderNeeded || cards.expectedThisWeek || cards.goodsReceived || cards.overdueHoldings,
  );
  const hasCharts = Boolean(charts.spendTrend || charts.poPipeline);
  const nothingVisible = !hasCards && !hasCharts && !worklist && !activity;

  // Everything permitted-but-empty vs genuinely no permission: only fall back to NoAccessHome when the
  // server returned nothing AND nothing errored (an all-errored load keeps the notice instead).
  if (nothingVisible && !(errors && errors.length > 0)) return <NoAccessHome />;

  const jobs = cards.activeJobs;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Overview</h1>
          <div className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span>Updated {relativeTime(summary.generatedAt)}</span>
            <button
              type="button"
              onClick={() => void load(spendPeriod)}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              title="Refresh"
              className="rounded p-0.5 text-[var(--faint)] transition-colors hover:text-[var(--accent)] disabled:cursor-default"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        <QuickActions />
      </header>

      {showErrors ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-[var(--warn)]">
          <span>Some sections couldn&apos;t load: {errors!.join(", ")}. Try refreshing.</span>
          <button
            type="button"
            onClick={() => setDismissedErrorSig(errorSig)}
            className="shrink-0 text-xs font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {hasCards ? (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.pendingPrfs ? (
            <StatCard title="Pending PRFs" count={cards.pendingPrfs.count} spark={cards.pendingPrfs.weeklyCreated} href="/dashboard/purchase-requests?status=submitted" />
          ) : null}
          {cards.openPos ? (
            <StatCard
              title="Open POs"
              count={cards.openPos.count}
              secondary={`${formatMoney(cards.openPos.valuePence / 100)} committed`}
              spark={cards.openPos.weeklyCreated}
              href="/dashboard/purchase-orders"
            />
          ) : null}
          {jobs ? (
            <StatCard
              title="Active Jobs"
              count={jobs.count}
              spark={jobs.weeklyCreated}
              secondary={
                jobs.overdueCount > 0 || jobs.dueThisWeekCount > 0 ? (
                  <>
                    {jobs.overdueCount > 0 ? (
                      <span className="font-semibold text-[var(--neg)]">{jobs.overdueCount} overdue</span>
                    ) : null}
                    {jobs.overdueCount > 0 && jobs.dueThisWeekCount > 0 ? " · " : null}
                    {jobs.dueThisWeekCount > 0 ? `${jobs.dueThisWeekCount} due this week` : null}
                  </>
                ) : (
                  "Nothing due this week"
                )
              }
              href="/dashboard/jobs"
            />
          ) : null}
          {cards.lowStock ? (
            <StatCard
              title="Low Stock"
              count={cards.lowStock.count}
              secondary={
                cards.lowStock.criticalCount > 0 ? (
                  <span className="font-semibold text-[var(--neg)]">{cards.lowStock.criticalCount} critical</span>
                ) : (
                  "All above reorder level"
                )
              }
              href="/dashboard/inventory?status=low_stock"
            />
          ) : null}
          {cards.reorderNeeded ? (
            <StatCard
              title="Reorder Needed"
              count={cards.reorderNeeded.count}
              secondary={
                cards.reorderNeeded.count === 0 ? (
                  "Nothing to buy — pipeline covers demand"
                ) : (
                  <>
                    {cards.reorderNeeded.criticalCount > 0 ? (
                      <span className="font-semibold text-[var(--neg)]">{cards.reorderNeeded.criticalCount} critical</span>
                    ) : null}
                    {cards.reorderNeeded.criticalCount > 0 && cards.reorderNeeded.supplierGaps > 0 ? " · " : null}
                    {cards.reorderNeeded.supplierGaps > 0 ? `${cards.reorderNeeded.supplierGaps} missing supplier` : null}
                    {cards.reorderNeeded.criticalCount === 0 && cards.reorderNeeded.supplierGaps === 0 ? "Open the workbench to review" : null}
                  </>
                )
              }
              href="/dashboard/inventory?tab=reorder"
            />
          ) : null}
          {cards.expectedThisWeek ? (
            <StatCard
              title="Expected This Week"
              count={cards.expectedThisWeek.dueThisWeek}
              secondary={
                cards.expectedThisWeek.overdue > 0 ? (
                  <span className="font-semibold text-[var(--neg)]">{cards.expectedThisWeek.overdue} overdue — chase the supplier</span>
                ) : (
                  "Open POs due in the next 7 days"
                )
              }
              href="/dashboard/purchase-orders?status=sent"
            />
          ) : null}
          {cards.goodsReceived ? (
            <StatCard
              title="Goods Received"
              count={cards.goodsReceived.count}
              secondary="Completed GRNs · last 7 days"
              spark={cards.goodsReceived.weeklyReceived}
              href="/dashboard/goods-in"
            />
          ) : null}
          {cards.overdueHoldings ? (
            <StatCard
              title="Overdue Holdings"
              count={cards.overdueHoldings.count}
              secondary={
                cards.overdueHoldings.count > 0 ? (
                  <span className="font-semibold text-[var(--neg)]">
                    Stock out &gt; {cards.overdueHoldings.days} days — write off or chase returns
                  </span>
                ) : (
                  `No stock out > ${cards.overdueHoldings.days} days`
                )
              }
              href="/dashboard/warehouses"
            />
          ) : null}
        </section>
      ) : null}

      {worklist ? <WorklistPanel items={worklist.items} total={worklist.total} truncated={worklist.truncated} /> : null}

      {hasCharts ? (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {charts.spendTrend ? (
            <div className="lg:col-span-2">
              <SpendTrendChart data={charts.spendTrend} period={spendPeriod} onPeriodChange={setSpendPeriod} loading={refreshing} />
            </div>
          ) : null}
          {charts.poPipeline ? (
            <div className="lg:col-span-1">
              <PipelineBars data={charts.poPipeline} />
            </div>
          ) : null}
        </section>
      ) : null}

      {activity ? <ActivityFeed items={activity} /> : null}
    </div>
  );
}

function OverviewSkeleton() {
  // Placeholders use the same appearance-driven radius as the real cards they stand in for.
  const rad = { borderRadius: "var(--radius)" };
  const block = "border border-[var(--border)] bg-[var(--surface-2)]";
  return (
    <div className="flex animate-pulse flex-col gap-5">
      <div className="h-8 w-40 rounded bg-[var(--surface-2)]" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={`h-28 ${block}`} style={rad} />
        ))}
      </div>
      <div className={`h-40 ${block}`} style={rad} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={`h-64 ${block} lg:col-span-2`} style={rad} />
        <div className={`h-64 ${block}`} style={rad} />
      </div>
    </div>
  );
}
