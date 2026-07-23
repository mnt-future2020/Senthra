"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { Notice } from "@/components/ui/Notice";
import { PortalHeader } from "@/components/dashboard/portal/portalUi";
import { relativeTime } from "@/components/dashboard/audit/auditDisplay";
import { useEngineerOverview } from "./overview/useEngineerOverview";
import { buildStatCards, buildAttentionRows } from "./overview/engineerDashboardModel";
import { EngineerStatCards } from "./overview/EngineerStatCards";
import { AttentionStrip } from "./overview/AttentionStrip";
import { NextUpJobs } from "./overview/NextUpJobs";
import { EngineerQuickActions } from "./overview/EngineerQuickActions";
import { RecentActivityCard } from "./overview/RecentActivityCard";
import { DashboardSkeleton } from "./overview/DashboardSkeleton";

// Engineer Portal dashboard — the field engineer's day at a glance: workload cards, an actionable
// "Needs your attention" strip, the next jobs by due date, quick actions and the recent stock feed.
// Thin orchestrator: the data + realtime live in useEngineerOverview; the card / attention logic is a
// pure, unit-tested view-model (engineerDashboardModel); each piece is its own component under overview/.
const SUBTITLE = "Your jobs, stock and activity at a glance.";
const CAPTION_TICK_MS = 30_000;

export function EngineerDashboard() {
  const { can } = useAuth();
  const { overview, recent, loading, refreshing, error, updatedAt, reload } = useEngineerOverview();

  // Re-render the "Updated X ago" caption on a tick, without refetching.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), CAPTION_TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (loading && !overview) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Dashboard" subtitle={SUBTITLE} />
        <DashboardSkeleton />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Dashboard" subtitle={SUBTITLE} />
        {error && <Notice msg={{ type: "error", text: error }} />}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="text-sm text-[var(--muted)]">We couldn&apos;t load your dashboard.</p>
          <button
            type="button"
            onClick={reload}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-colors hover:border-[var(--accent)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const cards = buildStatCards(overview, can);
  const attention = buildAttentionRows(overview, can);

  return (
    <div className="space-y-6">
      <PortalHeader
        title="Dashboard"
        subtitle={SUBTITLE}
        action={
          <div className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span>Updated {relativeTime(updatedAt ?? new Date().toISOString())}</span>
            <button
              type="button"
              onClick={reload}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              title="Refresh"
              className="rounded p-0.5 text-[var(--faint)] transition-colors hover:text-[var(--accent)] disabled:cursor-default"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        }
      />
      {error && <Notice msg={{ type: "error", text: error }} />}

      <EngineerStatCards cards={cards} />
      <AttentionStrip rows={attention} />

      <div className="grid gap-6 lg:grid-cols-3">
        <NextUpJobs jobs={overview.jobs.next} canJobs={can("engineer.jobs.view")} />
        <div className="space-y-6">
          <EngineerQuickActions />
          <RecentActivityCard movements={recent} />
        </div>
      </div>
    </div>
  );
}
