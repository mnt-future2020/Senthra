"use client";

// GoodsManagementTab — warehouse "Goods Management" tab.
// Sections (pills):
//   "Queue"   — ACTIVE jobs for this warehouse (everything except reconciled). Text search, a stage
//               filter (All active / Not issued / Partial / Issued / Awaiting return) and a kit-line
//               density control. Each row → JobScanPanel via "Manage".
//   "Closed"  — reconciled (done) jobs, read-only (no Manage) — kept for audit/history. Bounded by a
//               From/To window on last goods activity, which for a closed job is its reconciliation.
//   "Overdue" — stock still out beyond the window configured in Settings → Operations, with
//               "Write off (lost)". No control of its own: one definition of overdue, set by an admin.
// The STATUS column is PER ITEM (per kit line) — each line shows its own issuance (Not issued /
// Partial / Issued), since one job's lines can sit in different warehouses. Search, stage filter,
// date window and pagination are all server-side (goodsManagement.service); only the kit-line
// density control is client-side, since it just chooses how much of an already-loaded kit to draw.
// Tab/filter state is persisted in the URL using namespaced params (?gmSection, ?gmq, ?gmPage,
// ?gmStatus, ?gmFrom, ?gmTo, ?gmLines, ?gmSort, ?gmDue) so that a browser refresh restores the view
// without clobbering the host page's ?tab param. Switching section clears them ALL — see goToSection;
// anything added here must be cleared there too, or the new section arrives silently narrowed by a
// filter it doesn't even display.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, ClipboardList, Clock, PackageCheck } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import type { GoodsLineStatus, QueuePage, QueueKitLine, QueueStatusFilter, QueueSort } from "@/types/goodsManagement";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { useDashboard } from "@/hooks/useDashboard";
import { Skeleton } from "@/components/ui/Skeleton";
import { CopyableCode } from "@/components/ui/CopyableCode";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { toolbarBtn, toolbarDateCls } from "@/components/ui/styles";
import { JobScanPanel } from "./JobScanPanel";
import { OverdueHoldingsView } from "./OverdueHoldingsView";
import { visibleKitLines } from "./kitLineVisibility";
import { lineStatus } from "./lineStatus";
import { foldedStatus, itemNamesTitle, summariseLines } from "./collapsedRow";
import { ageTone, dueBadge, formatDay, jobAgeDays } from "./jobAge";

type GmSection = "queue" | "closed" | "overdue";

// The per-LINE status vocabulary, from the shared types so this file and collapsedRow's foldedStatus
// can't drift apart. Richer than the job-level GoodsStatus — see the note on GoodsLineStatus.
type GoodsStatusKey = GoodsLineStatus;

const STATUS_LABELS: Record<GoodsStatusKey, string> = {
  not_issued: "Not issued",
  partially_issued: "Partial",
  issued: "Issued",
  awaiting_return: "Awaiting return",
  returned: "Returned",
  used: "Used",
  reconciled: "Reconciled",
};

const STATUS_COLORS: Record<GoodsStatusKey, string> = {
  not_issued: "bg-[var(--surface-2)] text-[var(--faint)]",
  partially_issued: "bg-amber-500/15 text-amber-600",
  issued: "bg-[var(--accent)]/12 text-[var(--accent)]",
  awaiting_return: "bg-indigo-500/12 text-indigo-600",
  returned: "bg-teal-500/12 text-teal-600",
  used: "bg-violet-500/12 text-violet-600",
  reconciled: "bg-[var(--pos)]/12 text-[var(--pos)]",
};

const PAGE_SIZE = 20;
const QUEUE_HEADERS = ["Job", "Engineer", "Item", "Status", "Planned", "Issued", "Used", "Returned", "To return", "Available", ""];

// Due-date filter for the ACTIVE queue, read off the job's completion date. The Closed tab keeps its
// activity window instead — there, "when did we finish it" is the question; here it's "what has to go
// out". They are different fields on purpose: a job due today with nothing issued has no activity at
// all, so an activity window would hide precisely the work this filter exists to surface.
// "Past due", NOT "Overdue": this screen ALREADY has an Overdue section, and it counts something
// entirely different — stock still out with an engineer beyond the Settings window (a chase list).
// This one is about the job's own deadline. Two controls a few pixels apart both reading "Overdue"
// while answering different questions is the kind of thing people quietly mis-read for months.
// The VALUE stays "overdue" — it is the backend's filter contract and shared with saved URLs.
const DUE_OPTIONS = [
  { value: "", label: "Any due date" },
  { value: "overdue", label: "Past due" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
];
const DUE_VALUES = DUE_OPTIONS.map((o) => o.value).filter(Boolean);

// Stage filter for the ACTIVE queue. "active" (everything but reconciled) stays the default; the rest
// target one exact stage. "Awaiting return" is the one that earns its place — it's the chase list, the
// stock a manager has to get back. The backend has always accepted these values (QUEUE_STATUSES in
// goods-management.service.ts) and validates them; the tab simply never offered them.
const STATUS_FILTER_OPTIONS = [
  { value: "active", label: "All active" },
  { value: "not_issued", label: "Not issued" },
  { value: "partially_issued", label: "Partially issued" },
  { value: "issued", label: "Issued" },
  { value: "awaiting_return", label: "Awaiting return" },
];
const ACTIVE_STATUS_VALUES = STATUS_FILTER_OPTIONS.map((o) => o.value);

// Kit-line density. Defaults to the actionable subset: a multi-warehouse job otherwise fills the table
// with greyed rows that can't be touched here. The full kit is one click away and the job row says how
// many were folded away — see kitLineVisibility.ts.
const LINE_OPTIONS = [
  { value: "relevant", label: "Actionable lines" },
  { value: "all", label: "All kit lines" },
];

// Queue order. Newest-first is how this list has always come back, and it's a reasonable default —
// but it's also why a neglected job disappears: it sinks below every newer one. "Longest waiting"
// is the antidote, and the only view that surfaces a job which was never issued at all.
const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "activity_asc", label: "Longest waiting" },
];
const SORT_VALUES = SORT_OPTIONS.map((o) => o.value);

// Age badge colours, keyed off ageTone(). Kept next to the option lists so the whole toolbar's
// vocabulary is in one place.
const AGE_TONE_CLS = {
  normal: "text-[var(--faint)]",
  warn: "text-amber-600",
  bad: "text-[var(--neg)]",
} as const;


function statusChip(s: GoodsStatusKey) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[s]}`}>
      {STATUS_LABELS[s]}
    </span>
  );
}

// Groups a job's kit lines by item identity (misc is its own group, keyed by line id).
function groupByItem(lines: QueueKitLine[]): QueueKitLine[][] {
  const groups = new Map<string, QueueKitLine[]>();
  for (const l of lines) {
    const key = l.irmItemId ? `irm:${l.irmItemId}` : l.customerStockEntryId ? `cse:${l.customerStockEntryId}` : `misc:${l.id}`;
    const g = groups.get(key);
    if (g) g.push(l);
    else groups.set(key, [l]);
  }
  return [...groups.values()];
}

// Actual returns, normalised across an item's warehouse lines — a fungible item is returned wherever
// it's handed back, so raw per-line returned can exceed one line's issued. Drives the Returned column.
function effectiveReturns(lines: QueueKitLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of groupByItem(lines)) {
    let remaining = group.reduce((s, l) => s + l.returnedQty, 0); // the item's total returned
    for (const l of group) {
      const assigned = Math.min(remaining, Math.max(0, l.issuedQty - l.usedQty));
      out.set(l.id, assigned);
      remaining -= assigned;
    }
  }
  return out;
}

// "To return" per line, from the engineer's REAL holding (engineerHeld is the global per-item balance
// the return scan checks). Distributed across the item's lines, each line capped at its OWN still-out
// quantity — issued − used − returned, matching the backend's `lineOutstanding`
// (goods-management.service.ts). Capping at issued − used alone would leave an already-returned line
// still advertising capacity, so the engineer's global holding from ANOTHER job/warehouse would bleed
// into it and show a phantom "To return" (and wrongly keep the line "Awaiting return"). Keyed by
// kit-line id.
function distributeToReturn(lines: QueueKitLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of groupByItem(lines)) {
    let remaining = group[0]?.engineerHeld ?? 0; // global held for this item (same on every line)
    for (const l of group) {
      const assigned = Math.min(remaining, Math.max(0, l.issuedQty - l.usedQty - l.returnedQty));
      out.set(l.id, assigned);
      remaining -= assigned;
    }
  }
  return out;
}

function shortfallColor(planned: number, issued: number) {
  if (issued < planned) return "text-[var(--neg)]";
  if (issued === planned) return "text-[var(--pos)]";
  return "text-[var(--ink)]";
}

const SECTION_PILLS: { key: GmSection; label: string; icon: React.ElementType }[] = [
  { key: "queue", label: "Queue", icon: ClipboardList },
  { key: "closed", label: "Closed", icon: PackageCheck },
  { key: "overdue", label: "Overdue", icon: Clock },
];

// Loading skeleton — mirrors the queue table shape (matches the warehouse detail's other tabs).
function QueueSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
      <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth: 1020 }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {QUEUE_HEADERS.map((h, i) => (
              <th key={i} className={`cell-y px-4 ${i >= 4 && i <= 9 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {QUEUE_HEADERS.map((_h, j) => (
                <td key={j} className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function GoodsManagementTab({
  warehouseId,
}: {
  warehouseId: string;
  router?: unknown; // kept for forward-compat signature
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-derived state (namespaced so they never clobber the host page's ?tab).
  const section = (searchParams.get("gmSection") as GmSection | null) ?? "queue";
  const urlSearch = searchParams.get("gmq") ?? "";
  const page = Math.max(1, Number(searchParams.get("gmPage")) || 1);
  // Every filter is validated against its option list rather than trusted: these come from a URL a user
  // can hand-edit or a stale bookmark, and an unrecognised value has to fall back to the default instead
  // of reaching the API (a bogus status would 400 the whole tab).
  const rawStatus = searchParams.get("gmStatus");
  const statusFilter = (rawStatus && ACTIVE_STATUS_VALUES.includes(rawStatus) ? rawStatus : "active") as QueueStatusFilter;
  // Validated against the option list like every other filter — these arrive from an editable URL.
  const rawDue = searchParams.get("gmDue") ?? "";
  const dueFilter = DUE_VALUES.includes(rawDue) ? rawDue : "";
  const activityFrom = searchParams.get("gmFrom") ?? "";
  const activityTo = searchParams.get("gmTo") ?? "";
  const showAllLines = searchParams.get("gmLines") === "all";
  const rawSort = searchParams.get("gmSort");
  const queueSort = (rawSort && SORT_VALUES.includes(rawSort) ? rawSort : "newest") as QueueSort;

  // Local search input — seeded from URL, debounce-writes back to ?gmq.
  const [searchInput, setSearchInput] = React.useState(urlSearch);

  const [data, setData] = React.useState<QueuePage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { pushToast } = useDashboard();
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [loadTick, setLoadTick] = React.useState(0);

  // Which job groups are folded to a single line.
  //
  // Held as a DEFAULT plus an exception set, not as a list of folded ids, so "Collapse all" keeps
  // holding for jobs that arrive on the next page or after a socket refresh. A plain id list would
  // let those in expanded and quietly undo the fold the user just asked for.
  //
  // Deliberately local state rather than a URL param: per-job ids would bloat the query string this
  // tab shares with its host page, and a fold is a reading aid for right now, not a view worth
  // restoring on refresh.
  const [collapseAll, setCollapseAll] = React.useState(false);
  const [foldExceptions, setFoldExceptions] = React.useState<ReadonlySet<string>>(new Set());
  const isCollapsed = React.useCallback(
    (jobId: string) => (foldExceptions.has(jobId) ? !collapseAll : collapseAll),
    [collapseAll, foldExceptions],
  );
  const toggleFold = React.useCallback((jobId: string) => {
    setFoldExceptions((prev) => {
      const next = new Set(prev);
      if (!next.delete(jobId)) next.add(jobId);
      return next;
    });
  }, []);
  // Flipping the global control re-bases the default, so the per-job exceptions have to go with it —
  // keeping them would leave a job the user folded by hand now standing alone expanded (and vice
  // versa), which reads as the button having half-worked.
  const toggleAll = React.useCallback(() => {
    setCollapseAll((v) => !v);
    setFoldExceptions(new Set());
  }, []);

  const isClosed = section === "closed";
  const showsTable = section === "queue" || section === "closed";

  // Writer: preserves ALL existing params (so the host's ?tab is never lost).
  const patch = React.useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("gmPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const load = React.useCallback(() => setLoadTick((t) => t + 1), []);
  // Live-refresh whenever any goods event fires on the socket (issue / return / reconcile).
  useGoodsSocket(load);

  // Debounce the search box into ?gmq.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== urlSearch) {
        patch({ gmq: searchInput.trim() || null }, true);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, urlSearch, patch]);

  // Fetch the current page whenever the view, search or page changes.
  React.useEffect(() => {
    if (!showsTable) return;
    let active = true;
    gmService
      .getQueue({
        warehouseId,
        // Closed is reconciled BY DEFINITION, so the stage filter belongs to the active queue only.
        status: isClosed ? "reconciled" : statusFilter,
        search: urlSearch || undefined,
        // Date window is offered in Closed only. On the active queue it would hide OPEN work — the one
        // thing this screen exists to keep in front of the manager.
        activityFrom: isClosed ? activityFrom || undefined : undefined,
        activityTo: isClosed ? activityTo || undefined : undefined,
        // Mirror image of the window above: due belongs to the ACTIVE queue only. On Closed every job
        // is finished, so "what's due" has nothing left to answer.
        due: isClosed ? undefined : (dueFilter || undefined) as "overdue" | "today" | "week" | undefined,
        // Closed always reads most-recently-closed first — "what did we finish last?" is the question
        // there, and ordering it by when the JOB was raised (the default) put an old job that closed
        // yesterday below a new one that closed last month, right beside the date now on screen.
        sort: isClosed ? "activity_desc" : queueSort,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        if (!active) return;
        setError(null);
        setData(res);
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load the goods queue.");
      });
    return () => {
      active = false;
    };
  }, [warehouseId, section, isClosed, showsTable, urlSearch, statusFilter, activityFrom, activityTo, dueFilter, queueSort, page, loadTick]);

  const goToSection = (key: GmSection) => {
    setSearchInput("");
    setData(null); // clear immediately so the skeleton shows while the new section loads
    // Clears every filter too: they don't all exist in every section (a stage filter means nothing in
    // Closed, a date window nothing in Queue), so carrying them across would leave the new view
    // silently narrowed by a control it doesn't even show.
    patch(
      { gmSection: key !== "queue" ? key : null, gmq: null, gmPage: null, gmStatus: null, gmFrom: null, gmTo: null, gmLines: null, gmSort: null, gmDue: null },
      false,
    );
    // Folding is a per-view reading aid, not a filter — carrying it into a section the user just
    // switched to would hand them a queue already folded up for reasons they can't see.
    setCollapseAll(false);
    setFoldExceptions(new Set());
  };

  const selectedRow = React.useMemo(
    () => data?.rows.find((r) => r.jobId === selectedJobId) ?? null,
    [data, selectedJobId],
  );

  // When a job row is selected (active queue only), show the full-screen scan panel. It's a
  // naturally-sized detail panel, so it gets its own scrolling box inside the bounded tab area.
  if (selectedJobId && selectedRow) {
    return (
      <div className="h-full min-h-0 overflow-auto">
        <JobScanPanel
          jobId={selectedJobId}
          jobNumber={selectedRow.jobNumber}
          jobStatus={selectedRow.status}
          jobName={selectedRow.jobName}
          warehouseId={warehouseId}
          miscLines={selectedRow.kitLines.filter((k) => k.lineType === "misc")}
          onBack={() => {
            setSelectedJobId(null);
            load(); // refresh after any movements
          }}
        />
      </div>
    );
  }

  // The Job + Engineer cells, shared by the expanded and the folded rendering so the two can't drift
  // apart. Folding must cost HEIGHT, never information: the folded row carries the same job identity,
  // due badge, age and hidden-line count as the expanded one.
  // `overdueAfterDays` is passed in rather than read off `data` here: at this point in the component
  // `data` is still `QueuePage | null`, so reading it would need a fallback — and a local default
  // would be exactly the hardcoded threshold QueuePage.overdueAfterDays exists to prevent (it is the
  // Settings value the Overdue tab and Inventory Hub also count with, so a stray 14 here would tint
  // rows against a number nothing else in the app uses). Both call sites are inside the branch where
  // `data` is known non-null, so they can hand over the real value.
  const jobCell = (row: QueuePage["rows"][number], hiddenCount: number, rowSpan: number, overdueAfterDays: number) => {
    const folded = isCollapsed(row.jobId);
    const age = jobAgeDays(row);
    const cancelled = row.status === "cancelled";
    // No DUE badge on a cancelled job — the deadline is void, and "Due 8 Aug · Today" next to a job
    // nobody is working reads as work to schedule. The AGE signal stays: how long its stock has been
    // out is exactly what still matters. The Cancelled chip below takes the badge's place.
    const badge = isClosed || cancelled ? null : dueBadge(row.dueState, row.completionDate);
    // Same rose as the Jobs list chip and the scan panel's, so the one state reads identically in all
    // three places. It was only visible INSIDE the panel before — the queue row that leads there gave
    // no hint, so a manager picked the job with no idea the work was off.
    const cancelledChip = cancelled ? (
      <span className="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[10px] font-bold text-rose-600" title="This job was cancelled — its stock can only be returned or written off.">
        Cancelled
      </span>
    ) : null;
    const chevron = (
      <button
        type="button"
        onClick={() => toggleFold(row.jobId)}
        aria-expanded={!folded}
        aria-label={`${folded ? "Expand" : "Collapse"} ${row.jobNumber}`}
        title={folded ? "Show this job's kit lines" : "Fold this job to a single line"}
        className="shrink-0 rounded-md p-0.5 text-[var(--faint)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
      >
        <ChevronRight className={`h-4 w-4 transition-transform ${folded ? "" : "rotate-90"}`} />
      </button>
    );

    // FOLDED — one text line, laid out horizontally.
    //
    // Stacking job number / name / badges the way the expanded cell does would keep the row four
    // lines tall no matter how many kit rows were removed, so "collapse" would shrink nothing that
    // the eye can see. The row only gets shorter if THIS cell does, so everything runs inline and the
    // vertical padding drops with it. The job name truncates rather than wraps for the same reason:
    // one long name must not silently put the height back.
    if (folded) {
      return (
        <>
          <td className="px-4 py-2" rowSpan={rowSpan}>
            <div className="flex items-center gap-2 whitespace-nowrap text-[11px] font-semibold">
              {chevron}
              <span className="text-sm font-bold text-[var(--ink)]">{row.jobNumber}</span>
              <span className="max-w-[9rem] truncate text-xs font-normal text-[var(--muted)]" title={row.jobName}>
                {row.jobName}
              </span>
              {cancelledChip}
              {isClosed ? (
                <span className="text-[10px] text-[var(--muted)]">Closed {formatDay(row.lastActivityAt)}</span>
              ) : (
                <>
                  {badge && (
                    <span className={`text-[10px] ${badge.cls}`} title={badge.title}>
                      {badge.label}
                    </span>
                  )}
                  {age !== null && (
                    <span className={`text-[10px] ${AGE_TONE_CLS[ageTone(age, overdueAfterDays)]}`}>
                      {age === 0 ? "Today" : `Waiting ${age}d`}
                    </span>
                  )}
                </>
              )}
            </div>
          </td>
          <td className="px-4 py-2 text-xs text-[var(--muted)]" rowSpan={rowSpan}>
            {row.engineerName ?? "—"}
          </td>
        </>
      );
    }

    return (
      <>
        <td className="cell-y px-4" rowSpan={rowSpan}>
          <div className="flex items-start gap-2">
            <div className="mt-0.5">{chevron}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-[var(--ink)]">{row.jobNumber}</span>
                {cancelledChip}
              </div>
              <div className="text-xs text-[var(--muted)]">{row.jobName}</div>
              {/* The time signals, stacked here rather than as extra columns — this table is already
                  wide, and they belong beside the job they describe. Closed shows WHEN it closed,
                  which is the value that view's date filter matches. Queue shows the DUE date (what
                  its own filter matches) plus how long the job has gone untouched: different
                  questions, so neither substitutes for the other. */}
              {isClosed ? (
                <div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">Closed {formatDay(row.lastActivityAt)}</div>
              ) : (
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] font-semibold">
                  {badge && (
                    <span className={badge.cls} title={badge.title}>
                      {badge.label}
                    </span>
                  )}
                  {badge && age !== null && <span className="text-[var(--border)]">·</span>}
                  {age !== null && (
                    <span
                      className={AGE_TONE_CLS[ageTone(age, overdueAfterDays)]}
                      title={
                        row.lastActivityAt
                          ? `Last goods movement ${formatDay(row.lastActivityAt)}`
                          : `No goods movement yet — raised ${formatDay(row.createdAt)}`
                      }
                    >
                      {age === 0 ? "Today" : `Waiting ${age}d`}
                    </span>
                  )}
                </div>
              )}
              {/* Folded, never dropped: the manager still learns the job carries more kit than the
                  rows show, without paying eight untouchable rows for it. */}
              {hiddenCount > 0 && (
                <div
                  className="mt-1 text-[10px] font-semibold text-[var(--faint)]"
                  title="Kit lines that can't be actioned at this warehouse — switch to “All kit lines” to see them."
                >
                  +{hiddenCount} more line{hiddenCount === 1 ? "" : "s"} hidden
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="cell-y px-4 text-xs text-[var(--muted)]" rowSpan={rowSpan}>
          {row.engineerName ?? "—"}
        </td>
      </>
    );
  };

  // `compact` trims the vertical padding for a folded row — with py-3 the button's own height would
  // hold the row open after the job cell had already shrunk to one line.
  const manageCell = (row: QueuePage["rows"][number], rowSpan: number, compact = false) => (
    <td className={`px-4 ${compact ? "py-1.5" : "py-3"}`} rowSpan={rowSpan}>
      {/* Closed (reconciled) jobs are read-only — no dead-end Manage button. */}
      {!isClosed && (
        <button
          type="button"
          onClick={() => setSelectedJobId(row.jobId)}
          className={`rounded-xl bg-[var(--accent)] px-3 text-[11px] font-extrabold text-white transition-all hover:opacity-90 ${compact ? "py-1" : "py-1.5"}`}
        >
          Manage
        </button>
      )}
    </td>
  );

  // Folds every job to one line — the "how many jobs am I actually looking at" read, which a
  // kit-line-per-row table can't give on a busy warehouse. Offered on Closed as well as Queue: the
  // per-job chevron already works in both, so a bulk control in only one of them would read as the
  // button being broken on the other. Purely visual, so like the line-density control it never refetches.
  const collapseAllBtn = (
    <button
      type="button"
      onClick={toggleAll}
      className={toolbarBtn}
      title={collapseAll ? "Show every job's kit lines" : "Fold every job to a single line"}
    >
      {collapseAll ? <ChevronsUpDown className="h-3.5 w-3.5" /> : <ChevronsDownUp className="h-3.5 w-3.5" />}
      {collapseAll ? "Expand all" : "Collapse all"}
    </button>
  );

  return (
    <div className="stack flex h-full flex-col">
      {/* Section switcher — Queue / Closed / Overdue (segmented control, matches the scan panel) */}
      <div className="inline-flex shrink-0 self-start rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {SECTION_PILLS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => goToSection(key)}
            aria-pressed={section === key}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-bold transition-all ${
              section === key
                ? "bg-[var(--accent)] text-white shadow-xs"
                : "text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Overdue section — no controls at all. "Overdue" means the window configured in
          Settings → Operations, full stop; the view states that window above its table and owns its
          own empty state. A per-view day picker used to sit here, and it was a mistake: picking a
          number BELOW the configured one filled a tab labelled "Overdue" with jobs that were not
          overdue by the company's own rule, with nothing distinguishing them. One definition, one
          place to change it. */}
      {section === "overdue" && <OverdueHoldingsView warehouseId={warehouseId} />}

      {/* Queue / Closed sections */}
      {showsTable && (
        <>
          {/* Operational workspace tab: no title (the Warehouse header owns the identity) — the
              controls start directly. The search box is constrained now that filters sit beside it. */}
          <WorkspaceToolbar
            search={{
              value: searchInput,
              onChange: setSearchInput,
              placeholder: "Search job no., name, customer or engineer…",
              ariaLabel: "Search goods management jobs",
            }}
            filters={
              isClosed ? (
                <>
                  {/* Bounds the history. Filters the job's LAST GOODS ACTIVITY, which for a reconciled
                      job is its close-out — there is no separate reconciledAt column, so the title says
                      plainly what the dates match rather than implying a field that doesn't exist. */}
                  <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]" title="Filters on the job's last goods activity — for a closed job, when it was reconciled.">
                    From
                    <input
                      type="date"
                      value={activityFrom}
                      max={activityTo || undefined}
                      onChange={(e) => patch({ gmFrom: e.target.value || null })}
                      className={toolbarDateCls}
                      aria-label="Closed from date"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]" title="Filters on the job's last goods activity — for a closed job, when it was reconciled.">
                    To
                    <input
                      type="date"
                      value={activityTo}
                      min={activityFrom || undefined}
                      onChange={(e) => patch({ gmTo: e.target.value || null })}
                      className={toolbarDateCls}
                      aria-label="Closed to date"
                    />
                  </label>
                  {(activityFrom || activityTo) && (
                    <button type="button" onClick={() => patch({ gmFrom: null, gmTo: null })} className={toolbarBtn}>
                      Clear dates
                    </button>
                  )}
                  {collapseAllBtn}
                </>
              ) : (
                <>
                  {/* Stage stays in the open — "show me what's awaiting return" is the question this
                      tab is opened to answer. Due / kit-line density / sort fold behind one trigger.
                      Only DUE counts towards the badge: density and sort change how the same rows are
                      drawn, they never remove one, and counting them would make "Filters 2" claim
                      something is hidden when nothing is. */}
                  <Select
                    size="sm"
                    ariaLabel="Filter by goods stage"
                    value={statusFilter}
                    onChange={(v) => patch({ gmStatus: v === "active" ? null : v })}
                    options={STATUS_FILTER_OPTIONS}
                  />
                  <FilterPopover
                    activeCount={dueFilter ? 1 : 0}
                    onClear={() => patch({ gmDue: null, gmLines: null, gmSort: null })}
                  >
                    <Select
                      size="sm"
                      ariaLabel="Filter by due date"
                      value={dueFilter}
                      onChange={(v) => patch({ gmDue: v || null })}
                      options={DUE_OPTIONS}
                    />
                    {/* Purely how much of each kit is drawn — no refetch, so it isn't in the fetch deps. */}
                    <Select
                      size="sm"
                      ariaLabel="Kit line visibility"
                      value={showAllLines ? "all" : "relevant"}
                      onChange={(v) => patch({ gmLines: v === "all" ? "all" : null }, false)}
                      options={LINE_OPTIONS}
                    />
                    <Select
                      size="sm"
                      ariaLabel="Sort order"
                      value={queueSort}
                      onChange={(v) => patch({ gmSort: v === "newest" ? null : v })}
                      options={SORT_OPTIONS}
                    />
                  </FilterPopover>
                  {collapseAllBtn}
                </>
              )
            }
          />

          {error ? (
            <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
          ) : data === null ? (
            <QueueSkeleton />
          ) : data.rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
              {isClosed ? <PackageCheck className="h-7 w-7 text-[var(--faint)]" /> : <ClipboardList className="h-7 w-7 text-[var(--faint)]" />}
              <p className="text-sm font-semibold text-[var(--ink)]">
                {urlSearch ? "No jobs match your search" : isClosed ? "No closed jobs yet" : "No active jobs"}
              </p>
              <p className="text-xs text-[var(--muted)]">
                {isClosed
                  ? "Reconciled jobs for this warehouse will appear here for reference."
                  : "Accepted or in-progress jobs with kit lines at this warehouse will appear here."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
                <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-left text-sm" style={{ minWidth: 1020 }}>
                  <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                    <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                      <th className="cell-y px-4">Job</th>
                      <th className="cell-y px-4">Engineer</th>
                      <th className="cell-y px-4">Item</th>
                      <th className="cell-y px-4">Status</th>
                      <th className="cell-y px-4 text-right">Planned</th>
                      <th className="cell-y px-4 text-right">Issued</th>
                      <th className="cell-y px-4 text-right">Used</th>
                      <th className="cell-y px-4 text-right">Returned</th>
                      <th className="cell-y px-4 text-right">To return</th>
                      <th className="cell-y px-4 text-right">Available</th>
                      <th className="cell-y px-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, jobIdx) => {
                      // A line is actionable HERE when it's a real item stocked at this warehouse (or
                      // holding van-sourced stock, returnable anywhere), or a misc line not yet fully
                      // issued. Everything else renders greyed and can't be touched here, so the default
                      // view folds those away and reports the count — "All kit lines" brings them back.
                      // Closed is history: nothing is actionable in it, so it always shows the full kit.
                      const { lines: visibleLines, hiddenCount } = visibleKitLines(row.kitLines, warehouseId, showAllLines || isClosed, row.status === "cancelled");
                      const rowCount = visibleLines.length || 1;
                      // Returned = actual returns; To return = engineer's real holding (so it always
                      // matches what the return scan will accept), both spread across the item's lines.
                      // Distributed over the FULL kit, NOT the visible subset: both helpers apportion an
                      // item's total across all of its warehouse lines, so feeding them a filtered list
                      // would re-spread the same totals over fewer lines and change what a visible row
                      // reads. Keyed by line id, so the lookups below still resolve.
                      const effReturns = effectiveReturns(row.kitLines);
                      const toReturns = distributeToReturn(row.kitLines);
                      // A job with nothing drawable renders nothing, folded or not — a folded row that
                      // expanded into zero rows would be a dead chevron.
                      if (visibleLines.length === 0) return null;
                      if (isCollapsed(row.jobId)) {
                        const t = summariseLines(visibleLines, effReturns, toReturns);
                        const inReturnPhase = row.goodsStatus === "awaiting_return";
                        return (
                          <tr
                            key={row.jobId}
                            className={`align-middle transition-colors hover:bg-[var(--surface-2)] ${jobIdx > 0 ? "border-t-2 border-[var(--border)]" : ""}`}
                          >
                            {jobCell(row, hiddenCount, 1, data.overdueAfterDays)}
                            {/* The item names are what the chevron traded away, so the count stands in
                                for them — with the names themselves on hover, since "what's on this
                                job" is the one thing you'd otherwise have to expand to check. The
                                not-actionable-here count rides along instead of taking its own line in
                                the job cell, which would put the row's height straight back. */}
                            <td className="whitespace-nowrap px-4 py-2 text-[var(--muted)]" title={itemNamesTitle(visibleLines)}>
                              {t.items} item{t.items === 1 ? "" : "s"}
                              {hiddenCount > 0 && (
                                <span className="ml-1.5 text-[10px] font-semibold text-[var(--faint)]" title="Kit lines that can't be actioned at this warehouse.">
                                  +{hiddenCount} hidden
                                </span>
                              )}
                            </td>
                            {/* Derived from the lines this row folded, NOT from row.goodsStatus —
                                that covers the whole job including other warehouses' lines, so it
                                would print "Partial" beside an Issued column of 0. See foldedStatus. */}
                            <td className="px-4 py-2">
                              {statusChip(
                                isClosed
                                  ? "reconciled"
                                  : foldedStatus(
                                      visibleLines.map((l) =>
                                        lineStatus(l, row.goodsStatus, effReturns.get(l.id) ?? l.returnedQty, toReturns.get(l.id) ?? 0, row.status === "cancelled"),
                                      ),
                                    ),
                              )}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-[var(--muted)]">{t.planned}</td>
                            <td className={`px-4 py-2 text-right font-semibold tabular-nums ${isClosed ? "text-[var(--ink)]" : shortfallColor(t.planned, t.issued)}`}>{t.issued}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${t.used === 0 ? "text-[var(--faint)]" : "text-[var(--ink)]"}`}>{t.used}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${t.returned > 0 ? "text-teal-600" : "text-[var(--faint)]"}`}>{t.returned}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${inReturnPhase && t.toReturn > 0 ? "font-semibold text-indigo-600" : "text-[var(--faint)]"}`}>
                              {inReturnPhase ? t.toReturn : "—"}
                            </td>
                            {/* Availability is per ITEM warehouse stock — adding it across different
                                items would give a number that means nothing, so it stays folded. */}
                            <td className="px-4 py-2 text-right tabular-nums text-[var(--faint)]" title="Availability is per item — expand the job to see it.">
                              —
                            </td>
                            {manageCell(row, 1, true)}
                          </tr>
                        );
                      }
                      return visibleLines.map((line, lineIdx) => {
                        const isMisc = line.lineType === "misc";
                        const atWh = !!line.warehouseId && line.warehouseId === warehouseId;
                        // Away from its home warehouse, a line is still actionable if it holds
                        // van-sourced stock — that owes no warehouse, so ANY may receive it (the return
                        // path enforces the same, capped at vanReturnableQty). Greying it here would
                        // have the WM turn the engineer away for a return the server would accept. At
                        // its own home warehouse `atWh` already covers it (full line returnable there).
                        const anyWh = !atWh && line.vanReturnableQty > 0;
                        const miscDone = isMisc && line.issuedQty >= line.plannedQty;
                        const active = isMisc ? !miscDone : atWh || anyWh;
                        const dim = active ? "" : "opacity-45";
                        const effReturned = effReturns.get(line.id) ?? line.returnedQty;
                        const toReturn = toReturns.get(line.id) ?? 0;
                        // "To return" is only meaningful once the engineer has completed the job and
                        // declared usage (job in the return phase); before that the stock is just issued.
                        const inReturnPhase = row.goodsStatus === "awaiting_return";
                        const issuedColor = isClosed ? "text-[var(--ink)]" : shortfallColor(line.plannedQty, line.issuedQty);
                        // Thicker rule between job groups (rows within a job have no divider) for readability.
                        const jobSep = lineIdx === 0 && jobIdx > 0 ? "border-t-2 border-[var(--border)]" : "";
                        return (
                          <tr key={`${row.jobId}-${line.id}`} className={`align-middle transition-colors hover:bg-[var(--surface-2)] ${jobSep}`}>
                            {lineIdx === 0 && jobCell(row, hiddenCount, rowCount, data.overdueAfterDays)}
                            <td className={`cell-y px-4 ${active ? "font-medium text-[var(--ink)]" : "text-[var(--faint)]"} ${dim}`}>
                              {/* Click the NAME to copy the code that scans this line, so issuing or
                                  returning is paste-and-go instead of looking the item up again. The
                                  code is resolved server-side to mirror scanLookup — see scanCodeFor.
                                  A line with nothing scannable (misc, or a customer entry with no
                                  barcode) stays plain text: a copy button that hands over a value the
                                  scan then rejects is worse than no button. */}
                              {line.scanCode ? (
                                <CopyableCode code={line.scanCode} label={line.itemName} className="text-left" onCopied={(c) => pushToast(`Copied ${c}`)} />
                              ) : (
                                line.itemName
                              )}
                              {/* At its home warehouse a line reads "This warehouse" (full line
                                  returnable there); away from home, only its van portion can land, so
                                  it reads "Any warehouse" with that quantity. */}
                              {isMisc ? (
                                <span className="ml-1 text-[10px] text-[var(--faint)]">(misc)</span>
                              ) : atWh && line.vanIssuedQty > 0 ? (
                                // Mixed line at its home warehouse: split into two badges so a merged
                                // "issued 5" is self-explanatory — the stock part owes here, the van
                                // part can go anywhere (including here).
                                <>
                                  {line.issuedQty > line.vanIssuedQty && (
                                    <span className="ml-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]" title="Collected from this warehouse's stock — must be returned here.">
                                      This warehouse · ×{line.issuedQty - line.vanIssuedQty}
                                    </span>
                                  )}
                                  <span className="ml-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600" title="Handed over from another engineer's van, so it can be returned at any warehouse.">
                                    Any warehouse · ×{line.vanIssuedQty}
                                  </span>
                                </>
                              ) : anyWh ? (
                                <span className="ml-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600" title="Handed over from another engineer's van — no warehouse released it, so it can be returned at any warehouse.">
                                  Any warehouse{line.vanReturnableQty < line.issuedQty ? ` · ×${line.vanReturnableQty}` : ""}
                                </span>
                              ) : atWh ? (
                                <span className="ml-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">This warehouse</span>
                              ) : line.warehouseName ? (
                                <span className="ml-1 text-[10px] font-semibold text-[var(--faint)]">Other: {line.warehouseName}</span>
                              ) : null}
                            </td>
                            {/* Per-item status — this line's own issuance (Closed view → reconciled). */}
                            <td className={`cell-y px-4 ${dim}`}>
                              {statusChip(isClosed ? "reconciled" : lineStatus(line, row.goodsStatus, effReturned, toReturn, row.status === "cancelled"))}
                            </td>
                            {/* Counts stay full-strength even on greyed (other-warehouse) lines so the WM can
                                still see how much is planned/issued/available there. */}
                            {/* Number treatment (matches the Inventory table): the key figures — Issued
                                and To return — carry weight/colour; Planned/Used/Available and any 0
                                recede, so the meaningful numbers read at a glance instead of a wall of bold. */}
                            <td className="cell-y px-4 text-right tabular-nums text-[var(--muted)]">{line.plannedQty}</td>
                            <td className={`cell-y px-4 text-right font-semibold tabular-nums ${issuedColor}`}>{line.issuedQty}</td>
                            {/* Used + To return don't apply to misc (free-text, not stock-tracked) → show — */}
                            <td className={`cell-y px-4 text-right tabular-nums ${isMisc || line.usedQty === 0 ? "text-[var(--faint)]" : "text-[var(--ink)]"}`}>{isMisc ? "—" : line.usedQty}</td>
                            {/* Returned (normalized across the item's warehouses) — teal when any came back. */}
                            <td className={`cell-y px-4 text-right tabular-nums ${!isMisc && effReturned > 0 ? "text-teal-600" : "text-[var(--faint)]"}`}>{isMisc ? "—" : effReturned}</td>
                            <td className={`cell-y px-4 text-right tabular-nums ${!isMisc && inReturnPhase && toReturn > 0 ? "font-semibold text-indigo-600" : "text-[var(--faint)]"}`}>
                              {isMisc || !inReturnPhase ? "—" : toReturn}
                            </td>
                            <td className={`cell-y px-4 text-right tabular-nums ${line.available < line.plannedQty - line.issuedQty ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                              {line.available}
                            </td>
                            {lineIdx === 0 && manageCell(row, rowCount)}
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
                </div>
                <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="jobs" onPage={(p) => patch({ gmPage: p > 1 ? String(p) : null }, false)} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
