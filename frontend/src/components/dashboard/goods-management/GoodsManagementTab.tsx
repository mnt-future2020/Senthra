"use client";

// GoodsManagementTab — warehouse "Goods Management" tab.
// Two sections toggled by pills:
//   "Queue"   — active jobs filtered to this warehouse, per-kit-line planned / issued / available
//               tallies; clicking a row opens JobScanPanel.
//   "Overdue" — holdings out > 14 days with a "Write off (lost)" action per job.

import * as React from "react";
import { ClipboardList, Clock, Loader2 } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import type { QueueRow } from "@/types/goodsManagement";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { JobScanPanel } from "./JobScanPanel";
import { OverdueHoldingsView } from "./OverdueHoldingsView";

type GmSection = "queue" | "overdue";

type GoodsStatusKey =
  | "not_issued"
  | "partially_issued"
  | "issued"
  | "awaiting_return"
  | "reconciled";

const STATUS_LABELS: Record<GoodsStatusKey, string> = {
  not_issued: "Not issued",
  partially_issued: "Partial",
  issued: "Issued",
  awaiting_return: "Awaiting return",
  reconciled: "Reconciled",
};

const STATUS_COLORS: Record<GoodsStatusKey, string> = {
  not_issued: "bg-[var(--surface-2)] text-[var(--faint)]",
  partially_issued: "bg-amber-500/15 text-amber-600",
  issued: "bg-[var(--accent)]/12 text-[var(--accent)]",
  awaiting_return: "bg-indigo-500/12 text-indigo-600",
  reconciled: "bg-[var(--pos)]/12 text-[var(--pos)]",
};

function statusChip(s: string) {
  const key = s as GoodsStatusKey;
  const label = STATUS_LABELS[key] ?? s.replace(/_/g, " ");
  const color = STATUS_COLORS[key] ?? "bg-[var(--surface-2)] text-[var(--faint)]";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${color}`}>
      {label}
    </span>
  );
}

function shortfallColor(planned: number, issued: number) {
  if (issued < planned) return "text-[var(--neg)]";
  if (issued === planned) return "text-[var(--pos)]";
  return "text-[var(--ink)]";
}

const SECTION_PILLS: { key: GmSection; label: string; icon: React.ElementType }[] = [
  { key: "queue", label: "Queue", icon: ClipboardList },
  { key: "overdue", label: "Overdue", icon: Clock },
];

export function GoodsManagementTab({
  warehouseId,
  warehouseCode,
}: {
  warehouseId: string;
  warehouseCode: string;
  router?: unknown; // kept for forward-compat signature
}) {
  const [section, setSection] = React.useState<GmSection>("queue");
  const [queue, setQueue] = React.useState<QueueRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [loadTick, setLoadTick] = React.useState(0);

  // Trigger a reload from external callers (e.g. after a scan-panel movement posts).
  const load = React.useCallback(() => {
    setLoadTick((t) => t + 1);
  }, []);

  // Live-refresh whenever any goods event fires on the socket (issue / return / reconcile).
  useGoodsSocket(load);

  React.useEffect(() => {
    if (section !== "queue") return;
    let active = true;
    gmService
      .getQueue()
      .then((rows) => {
        if (!active) return;
        setError(null);
        const filtered = rows.filter((r) =>
          r.kitLines.some(
            (k) => !k.warehouseId || k.warehouseId === warehouseId,
          ),
        );
        setQueue(filtered);
      })
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Could not load the goods queue.",
        );
      });
    return () => {
      active = false;
    };
  }, [warehouseId, loadTick, section]);

  const selectedRow = queue?.find((r) => r.jobId === selectedJobId) ?? null;

  // When a job row is selected, show the full-screen scan panel (no section nav).
  if (selectedJobId && selectedRow) {
    return (
      <JobScanPanel
        jobId={selectedJobId}
        jobNumber={selectedRow.jobNumber}
        jobName={selectedRow.jobName}
        warehouseId={warehouseId}
        warehouseCode={warehouseCode}
        onBack={() => {
          setSelectedJobId(null);
          load(); // refresh queue after any movements
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Section pills — Queue / Overdue */}
      <div className="flex items-center gap-2">
        {SECTION_PILLS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
              section === key
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Overdue section */}
      {section === "overdue" && <OverdueHoldingsView days={14} />}

      {/* Queue section */}
      {section === "queue" && (
        <>
          {error && (
            <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">
              {error}
            </p>
          )}

          {!error && queue === null && (
            <div className="flex items-center justify-center gap-2 py-16 text-[var(--muted)]">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading queue…</span>
            </div>
          )}

          {!error && queue !== null && queue.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
              <ClipboardList className="h-7 w-7 text-[var(--faint)]" />
              <p className="text-sm font-semibold text-[var(--ink)]">No active jobs</p>
              <p className="text-xs text-[var(--muted)]">
                Accepted or in-progress jobs with kit lines at this warehouse will
                appear here.
              </p>
            </div>
          )}

          {!error && queue !== null && queue.length > 0 && (
            <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <table className="w-full text-left text-sm" style={{ minWidth: 750 }}>
                <thead>
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-4 py-3">Job</th>
                    <th className="px-4 py-3">Engineer</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3 text-right">Planned</th>
                    <th className="px-4 py-3 text-right">Issued</th>
                    <th className="px-4 py-3 text-right">Available</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {queue.map((row) => {
                    const visibleLines = row.kitLines.filter(
                      (k) => !k.warehouseId || k.warehouseId === warehouseId,
                    );
                    const rowCount = visibleLines.length || 1;
                    return visibleLines.map((line, lineIdx) => (
                      <tr
                        key={`${row.jobId}-${line.id}`}
                        className="border-b border-[var(--border)] align-middle transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                      >
                        {lineIdx === 0 && (
                          <>
                            <td className="px-4 py-3" rowSpan={rowCount}>
                              <div className="font-bold text-[var(--ink)]">
                                {row.jobNumber}
                              </div>
                              <div className="text-xs text-[var(--muted)]">
                                {row.jobName}
                              </div>
                            </td>
                            <td
                              className="px-4 py-3 text-xs text-[var(--muted)]"
                              rowSpan={rowCount}
                            >
                              {row.engineerName ?? "—"}
                            </td>
                            <td className="px-4 py-3" rowSpan={rowCount}>
                              {statusChip(row.goodsStatus)}
                            </td>
                          </>
                        )}
                        <td className="px-4 py-3 text-[var(--ink)]">
                          {line.itemName}
                          {line.lineType !== "irm" && line.lineType !== "customer_stock" ? (
                            <span className="ml-1 text-[10px] text-[var(--faint)]">
                              (misc)
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">
                          {line.plannedQty}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-bold ${shortfallColor(line.plannedQty, line.issuedQty)}`}
                        >
                          {line.issuedQty}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold ${line.available < line.plannedQty - line.issuedQty ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}
                        >
                          {line.available}
                        </td>
                        {lineIdx === 0 && (
                          <td className="px-4 py-3" rowSpan={rowCount}>
                            <button
                              type="button"
                              onClick={() => setSelectedJobId(row.jobId)}
                              className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90"
                            >
                              Manage
                            </button>
                          </td>
                        )}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
