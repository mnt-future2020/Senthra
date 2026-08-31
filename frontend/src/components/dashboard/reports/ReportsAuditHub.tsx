"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, FileBarChart, ScrollText } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { useAuth } from "@/hooks/useAuth";
import { AuditLogPanel } from "@/components/dashboard/audit/AuditLogPanel";
import { CustomReportsView } from "./CustomReportsView";
import { ScheduledReportsView } from "./ScheduledReportsView";
import { activeReportTab, visibleReportTabs, type ReportTabId } from "./reportsTabs";

// ── Reports & Audit — the general reporting hub ────────────────────────────────────────────────
//
// Deliberately NOT Finance. The client's flow separates the two:
//   Finance                → Finance Reports → Report          (/dashboard/finance)
//   Reports & Audit Trails → Custom Reports  → Audit Trails    (here)
//
// The tabs are existing modules reached through one door, which is what stops the sidebar growing a
// separate reporting entry for each. Audit keeps its own route (/dashboard/audit) and its own
// permission — this hub embeds the SAME panel rather than reimplementing it, so there is exactly one
// audit system. Scheduled Reports is the same idea applied forward: automating a report is not a
// third kind of reporting, so it is a tab here rather than a nav row of its own.

// The tab list and the visibility rule live in `reportsTabs.ts` — a DOM-free module the test suite
// can execute, and the single place the hub's permissions are written down. Only the icons are here,
// because an icon is presentation and has no business in a rule.
const ICONS: Record<ReportTabId, React.ElementType> = {
  custom: FileBarChart,
  scheduled: CalendarClock,
  audit: ScrollText,
};

export function ReportsAuditHub() {
  const { can } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * A tab is visible if and only if the user holds a permission that opens it. PERMISSIONS ONLY.
   *
   * Warehouse-scoped status was previously used here to drop the Audit Trail tab, and that was an
   * authorization decision made from something that is not a permission. It contradicted the nav row
   * one layer up — which admits `audit.view` — and produced the exact combination the seeded
   * `warehouse_manager` has: `audit.view`, no `reports.view`. The row appeared, PermissionGate let
   * them in, the only tab they held was then removed, `visible` was empty, and `active` fell back to
   * Custom Reports — a surface they have no right to, which promptly 403'd under an empty tab strip.
   *
   * Warehouse scoping of audit DATA is real and is enforced where it belongs: audit.service derives
   * `scopeWarehouseIds` from the actor on every read (list, facets and export alike), so a scoped
   * user opening this tab sees their own warehouses' entries and nothing else. Hiding the tab was
   * never what made that true, and removing it takes no restriction away.
   */
  const visible = React.useMemo(() => visibleReportTabs(can), [can]);
  // Clamped to a tab this user actually has: a deep link to ?tab=audit from someone without
  // `audit.view` must land on a tab they hold rather than render a surface that will refuse them.
  const active = activeReportTab(visible, searchParams.get("tab"));
  const pills = React.useMemo(() => visible.map((t) => ({ ...t, icon: ICONS[t.id] })), [visible]);

  const selectTab = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", id);
    // Per-tab filters are cleared on switch — the same "fresh on nav" behaviour the other module
    // panels use, so a date range set on one report does not silently narrow the next.
    for (const k of ["q", "type", "from", "to", "customer", "project", "warehouse", "itemType", "page"]) params.delete(k);
    router.replace(`/dashboard/reports?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex h-full flex-col gap-6">
      {/* No pills when there is nothing to switch between — a strip of one, or of none, is chrome
          pretending to be a control. */}
      {pills.length > 1 && active !== null ? (
        <PageActions>
          <TabPills tabs={pills} active={active} onSelect={selectTab} ariaLabel="Reports and audit sections" />
        </PageActions>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {/* No tab is not a tab. With `visible` empty there is nothing this user may open, so the hub
            says so — it must never fall back to mounting a surface that will answer 403. Reached only
            by a direct URL: PermissionGate already refuses anyone holding none of the three rights. */}
        {active === null ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16 text-center">
            <FileBarChart className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">Nothing here is available to you</p>
            <p className="max-w-sm text-xs text-[var(--muted)]">
              Reports and the audit trail each need their own permission. Ask an administrator if you need one.
            </p>
          </div>
        ) : active === "audit" ? (
          <AuditLogPanel />
        ) : active === "scheduled" ? (
          <ScheduledReportsView />
        ) : (
          <CustomReportsView />
        )}
      </div>
    </div>
  );
}
