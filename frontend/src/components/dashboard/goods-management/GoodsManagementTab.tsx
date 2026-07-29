"use client";

// GoodsManagementTab — warehouse "Goods Management" tab.
// Sections (pills):
//   "Queue"   — ACTIVE jobs for this warehouse (everything except reconciled), text search +
//               pagination. Each row → JobScanPanel via "Manage".
//   "Closed"  — reconciled (done) jobs, read-only (no Manage) — kept for audit/history.
//   "Overdue" — holdings out > 14 days with a "Write off (lost)" action per job.
// The STATUS column is PER ITEM (per kit line) — each line shows its own issuance (Not issued /
// Partial / Issued), since one job's lines can sit in different warehouses. Search + pagination
// are server-side (goodsManagement.service).
// Tab/filter state is persisted in the URL using namespaced params (?gmSection, ?gmq, ?gmPage)
// so that a browser refresh restores the view without clobbering the host page's ?tab param.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Clock, PackageCheck } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import type { QueuePage, QueueKitLine } from "@/types/goodsManagement";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { JobScanPanel } from "./JobScanPanel";
import { OverdueHoldingsView } from "./OverdueHoldingsView";

type GmSection = "queue" | "closed" | "overdue";

type GoodsStatusKey =
  | "not_issued"
  | "partially_issued"
  | "issued"
  | "awaiting_return"
  | "returned"
  | "used"
  | "reconciled";

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

function statusChip(s: GoodsStatusKey) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[s]}`}>
      {STATUS_LABELS[s]}
    </span>
  );
}

// Per-LINE lifecycle status. The job's goodsStatus gates the return phase: stock that's been issued
// is just OUT WITH THE ENGINEER ("Issued") while they do the work — it only becomes "Awaiting return"
// once the engineer completes the job and declares what they used (backend flips goodsStatus to
// "awaiting_return" then, or when a return is posted). Within the return phase the per-line state then
// derives from the engineer's REAL holding (toReturn) + actual returns/used.
//   Not issued → Partial → Issued → [job completed] → Awaiting return (still held) → Returned / Used.
function lineStatus(line: QueueKitLine, goodsStatus: string, returned: number, toReturn: number): GoodsStatusKey {
  const { lineType, plannedQty, issuedQty, usedQty } = line;
  if (issuedQty <= 0) return "not_issued";
  if (issuedQty < plannedQty) return "partially_issued";
  if (lineType === "misc") return "issued"; // misc is free-text — only issuance applies
  // Not in the return phase yet → the engineer is still using the stock; show plain "Issued".
  if (goodsStatus !== "awaiting_return") return "issued";
  if (toReturn > 0) return "awaiting_return"; // job completed but engineer still holds some
  if (returned > 0) return "returned";
  if (usedQty > 0) return "used";
  return "issued";
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
    <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
      <table className="w-full text-left text-sm" style={{ minWidth: 1020 }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {QUEUE_HEADERS.map((h, i) => (
              <th key={i} className={`px-4 py-3 ${i >= 4 && i <= 9 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {QUEUE_HEADERS.map((_h, j) => (
                <td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GoodsManagementTab({
  warehouseId,
  warehouseCode,
}: {
  warehouseId: string;
  warehouseCode: string;
  router?: unknown; // kept for forward-compat signature
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-derived state (namespaced so they never clobber the host page's ?tab).
  const section = (searchParams.get("gmSection") as GmSection | null) ?? "queue";
  const urlSearch = searchParams.get("gmq") ?? "";
  const page = Math.max(1, Number(searchParams.get("gmPage")) || 1);

  // Local search input — seeded from URL, debounce-writes back to ?gmq.
  const [searchInput, setSearchInput] = React.useState(urlSearch);

  const [data, setData] = React.useState<QueuePage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [loadTick, setLoadTick] = React.useState(0);

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
      .getQueue({ warehouseId, status: isClosed ? "reconciled" : "active", search: urlSearch || undefined, page, pageSize: PAGE_SIZE })
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
  }, [warehouseId, section, isClosed, showsTable, urlSearch, page, loadTick]);

  const goToSection = (key: GmSection) => {
    setSearchInput("");
    setData(null); // clear immediately so the skeleton shows while the new section loads
    patch({ gmSection: key !== "queue" ? key : null, gmq: null, gmPage: null }, false);
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
          jobName={selectedRow.jobName}
          warehouseId={warehouseId}
          warehouseCode={warehouseCode}
          miscLines={selectedRow.kitLines.filter((k) => k.lineType === "misc")}
          onBack={() => {
            setSelectedJobId(null);
            load(); // refresh after any movements
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
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

      {/* Overdue section */}
      {section === "overdue" && <OverdueHoldingsView days={14} warehouseId={warehouseId} />}

      {/* Queue / Closed sections */}
      {showsTable && (
        <>
          {/* Operational workspace tab: no title (the Warehouse header owns the identity) — the
              controls start directly. Full-width search (this tab has no filters/actions beside it). */}
          <WorkspaceToolbar
            search={{
              value: searchInput,
              onChange: setSearchInput,
              placeholder: "Search job no., name, customer or engineer…",
              ariaLabel: "Search goods management jobs",
              constrained: false,
            }}
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
                      <th className="px-4 py-3">Job</th>
                      <th className="px-4 py-3">Engineer</th>
                      <th className="px-4 py-3">Item</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Planned</th>
                      <th className="px-4 py-3 text-right">Issued</th>
                      <th className="px-4 py-3 text-right">Used</th>
                      <th className="px-4 py-3 text-right">Returned</th>
                      <th className="px-4 py-3 text-right">To return</th>
                      <th className="px-4 py-3 text-right">Available</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, jobIdx) => {
                      // Show the FULL kit list. A line is actionable HERE when it's a real item stocked
                      // at this warehouse, or a misc line not yet fully issued. Everything else is greyed:
                      // other-warehouse real items (issue them from their warehouse) + already-done misc.
                      const visibleLines = row.kitLines;
                      const rowCount = visibleLines.length || 1;
                      // Returned = actual returns; To return = engineer's real holding (so it always
                      // matches what the return scan will accept), both spread across the item's lines.
                      const effReturns = effectiveReturns(visibleLines);
                      const toReturns = distributeToReturn(visibleLines);
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
                            {lineIdx === 0 && (
                              <>
                                <td className="px-4 py-3" rowSpan={rowCount}>
                                  <div className="font-bold text-[var(--ink)]">{row.jobNumber}</div>
                                  <div className="text-xs text-[var(--muted)]">{row.jobName}</div>
                                </td>
                                <td className="px-4 py-3 text-xs text-[var(--muted)]" rowSpan={rowCount}>
                                  {row.engineerName ?? "—"}
                                </td>
                              </>
                            )}
                            <td className={`px-4 py-3 ${active ? "font-medium text-[var(--ink)]" : "text-[var(--faint)]"} ${dim}`}>
                              {line.itemName}
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
                            <td className={`px-4 py-3 ${dim}`}>
                              {statusChip(isClosed ? "reconciled" : lineStatus(line, row.goodsStatus, effReturned, toReturn))}
                            </td>
                            {/* Counts stay full-strength even on greyed (other-warehouse) lines so the WM can
                                still see how much is planned/issued/available there. */}
                            {/* Number treatment (matches the Inventory table): the key figures — Issued
                                and To return — carry weight/colour; Planned/Used/Available and any 0
                                recede, so the meaningful numbers read at a glance instead of a wall of bold. */}
                            <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">{line.plannedQty}</td>
                            <td className={`px-4 py-3 text-right font-semibold tabular-nums ${issuedColor}`}>{line.issuedQty}</td>
                            {/* Used + To return don't apply to misc (free-text, not stock-tracked) → show — */}
                            <td className={`px-4 py-3 text-right tabular-nums ${isMisc || line.usedQty === 0 ? "text-[var(--faint)]" : "text-[var(--ink)]"}`}>{isMisc ? "—" : line.usedQty}</td>
                            {/* Returned (normalized across the item's warehouses) — teal when any came back. */}
                            <td className={`px-4 py-3 text-right tabular-nums ${!isMisc && effReturned > 0 ? "text-teal-600" : "text-[var(--faint)]"}`}>{isMisc ? "—" : effReturned}</td>
                            <td className={`px-4 py-3 text-right tabular-nums ${!isMisc && inReturnPhase && toReturn > 0 ? "font-semibold text-indigo-600" : "text-[var(--faint)]"}`}>
                              {isMisc || !inReturnPhase ? "—" : toReturn}
                            </td>
                            <td className={`px-4 py-3 text-right tabular-nums ${line.available < line.plannedQty - line.issuedQty ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                              {line.available}
                            </td>
                            {lineIdx === 0 && (
                              <td className="px-4 py-3" rowSpan={rowCount}>
                                {/* Closed (reconciled) jobs are read-only — no dead-end Manage button. */}
                                {!isClosed && (
                                  <button
                                    type="button"
                                    onClick={() => setSelectedJobId(row.jobId)}
                                    className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90"
                                  >
                                    Manage
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
                </div>
              </div>

              <div className="shrink-0">
                <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="jobs" onPage={(p) => patch({ gmPage: p > 1 ? String(p) : null }, false)} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
