"use client";

import * as React from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";

import { relativeTime } from "@/components/dashboard/audit/auditDisplay";
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import { NoAccessHome } from "@/components/dashboard/shell/NoAccessHome";
import { subscribe } from "@/lib/socket";
import { getDashboardSummary, type DashboardSummary, type SpendPeriod } from "@/services/dashboard.service";
import { StatCard } from "./StatCard";
import { SpendTrendChart } from "./SpendTrendChart";
import { PipelineBars } from "./PipelineBars";
import { WorklistPanel } from "./WorklistPanel";
import { ActivityFeed } from "./ActivityFeed";
import { QuickActions } from "./QuickActions";
import { OverdueHoldingsDrillDown } from "./OverdueHoldingsDrillDown";
// Every card destination lives in one file — see the drift table at the top of it.
import { CARD_DESTINATIONS, expectedThisWeekActions, goodsReceivedHref } from "./cardDestinations";
import Link from "next/link";

// How often the summary silently refreshes while the tab is visible, and how often the
// "Updated X ago" caption re-renders. An ops dashboard left open must not go stale.
const REFRESH_MS = 60_000;
const CAPTION_TICK_MS = 30_000;

// The global "some pending-work count moved" signal — the same one the sidebar badges listen to, so
// the two surfaces can never disagree about whether something happened. Debounced because one
// workflow transition (approve → PO created) fires more than one emit.
const ATTENTION_EVENTS = ["attention:changed"] as const;
const SOCKET_DEBOUNCE_MS = 400;

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
  // Overdue Holdings is the one card whose count has no single list behind it — see
  // OverdueHoldingsDrillDown. It opens this panel instead of navigating somewhere that does not
  // contain the jobs it counted.
  const [overdueOpen, setOverdueOpen] = React.useState(false);

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

  // Live: the same signal that moves the sidebar badges also moves this screen's cards and worklist,
  // so a PRF approved on another desk lands here in under a second instead of waiting out the
  // interval above. That interval stays as the backstop for time-derived numbers (overdue rolling
  // over at midnight), which no event can announce. Debounced — one transition fires several emits.
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(ATTENTION_EVENTS, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void load(spendPeriod);
      }, SOCKET_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
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
            <StatCard
              title="Pending PRFs"
              count={cards.pendingPrfs.count}
              spark={cards.pendingPrfs.weeklyCreated}
              href={CARD_DESTINATIONS.pendingPrfs}
              opens="Opens purchase requests awaiting Finance approval."
            />
          ) : null}
          {cards.openPos ? (
            <StatCard
              title="Open POs"
              count={cards.openPos.count}
              secondary={`${formatMoney(cards.openPos.valuePence / 100)} committed`}
              spark={cards.openPos.weeklyCreated}
              // `?status=open` is the derived pseudo-status resolving to the very statuses
              // openSummary counts. It was the bare module list, which also held every closed and
              // cancelled order — so the count named one set and the screen showed another.
              href={CARD_DESTINATIONS.openPos}
              opens="Opens purchase orders still in flight."
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
              // `?status=active` — the same three in-flight statuses countActive measures. It was
              // the unfiltered list, which included every completed and cancelled job.
              href={CARD_DESTINATIONS.activeJobs}
              opens="Opens jobs in flight — assigned, accepted or in progress."
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
              // Company stock in a warehouse, at or below its reorder level — the three dimensions
              // the count is taken over. `?status=low_stock` alone dropped the out-of-stock rows,
              // which are the most severe ones the number is made of.
              href={CARD_DESTINATIONS.lowStock}
              opens="Opens company warehouse stock at or below its reorder level."
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
              href={CARD_DESTINATIONS.reorderNeeded}
              opens="Opens the reorder workbench, which lists these rows."
            />
          ) : null}
          {cards.expectedThisWeek ? (
            <StatCard
              title="Expected This Week"
              count={cards.expectedThisWeek.dueThisWeek}
              // The overdue half is DISJOINT from the half this card opens, so it cannot be reached by
              // following the card — it needs a destination of its own or it is a dead end that reads
              // "9 overdue" above an empty list. Rendered as `secondaryAction` (outside the card's
              // primary control, with its own accessible name) rather than as text.
              //
              // Only when there ARE overdue orders: an action that opens an empty list is the same
              // broken promise pointing the other way.
              secondaryAction={
                expectedThisWeekActions(cards.expectedThisWeek).overdueHref ? (
                  <Link
                    href={expectedThisWeekActions(cards.expectedThisWeek).overdueHref!}
                    aria-label={`${cards.expectedThisWeek.overdue} deliveries overdue. Opens purchase orders whose delivery date has passed.`}
                    className="inline-flex items-center gap-1 rounded font-semibold text-[var(--neg)] underline decoration-transparent underline-offset-2 transition-colors hover:decoration-[var(--neg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--neg)]/40"
                  >
                    {cards.expectedThisWeek.overdue} overdue — chase the supplier
                    <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0" />
                  </Link>
                ) : undefined
              }
              secondary={cards.expectedThisWeek.overdue > 0 ? undefined : "Open POs due in the next 7 days"}
              // `?status=due_this_week` — receivable orders whose ETA is inside the window and has
              // not passed, the exact half expectedDeliveries counts. `?status=sent` was one of the
              // three receivable statuses and took no notice of a date at all.
              href={expectedThisWeekActions(cards.expectedThisWeek).href}
              opens="Opens purchase orders due for delivery in the next 7 days."
            />
          ) : null}
          {cards.goodsReceived ? (
            <StatCard
              title="Goods Received"
              count={cards.goodsReceived.count}
              secondary="Completed GRNs · last 7 days"
              spark={cards.goodsReceived.weeklyReceived}
              // The window travels WITH the number (`receivedSince`, resolved in the company
              // timezone) rather than being re-derived here off the browser's clock — the card and
              // the list would otherwise disagree for any viewer in another zone.
              href={goodsReceivedHref(cards.goodsReceived.receivedSince)}
              opens={`Opens completed goods receipts booked in since ${cards.goodsReceived.receivedSince}.`}
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
              // NOT a link. This count spans every warehouse the viewer can reach and the work is
              // done inside one warehouse's Goods tab, so no single list holds it — see
              // OverdueHoldingsDrillDown. It pointed at the bare warehouse list, which contains none
              // of the jobs it counted.
              onOpen={() => setOverdueOpen(true)}
              opens="Opens a breakdown of the overdue stock by warehouse and engineer."
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

      {/* Mounted UNCONDITIONALLY, not under `cards.overdueHoldings`. The dashboard refetches every 60
          seconds and a section that throws is dropped from the payload by design (see `settle`), so
          gating the panel on that key closed an OPEN drill-down mid-read and threw away the focus it
          restores to the card. It costs nothing while shut: it renders no markup and fetches only
          once opened, which can only happen from a card that section rendered. */}
      <OverdueHoldingsDrillDown open={overdueOpen} onClose={() => setOverdueOpen(false)} />
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
