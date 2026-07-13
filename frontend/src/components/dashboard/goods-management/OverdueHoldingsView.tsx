"use client";

// OverdueHoldingsView — lists issue movements older than N days whose job's stock has not
// been reconciled. Provides a "Write off (lost)" button that calls closeReconcile(jobId, true).

import * as React from "react";
import { Clock, Loader2 } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Skeleton } from "@/components/ui/Skeleton";
import type { OverdueRow } from "@/types/goodsManagement";

const OVERDUE_HEADERS = ["Job", "Engineer", "Issued", "Days out", "Status", ""];

const STATUS_LABELS: Record<string, string> = {
  not_issued: "Not issued",
  partially_issued: "Partial",
  issued: "Issued",
  awaiting_return: "Awaiting return",
  reconciled: "Reconciled",
};
const STATUS_COLORS: Record<string, string> = {
  not_issued: "bg-[var(--surface-2)] text-[var(--faint)]",
  partially_issued: "bg-amber-500/15 text-amber-600",
  issued: "bg-[var(--accent)]/12 text-[var(--accent)]",
  awaiting_return: "bg-indigo-500/12 text-indigo-600",
  reconciled: "bg-[var(--pos)]/12 text-[var(--pos)]",
};

function statusChip(s: string) {
  const label = STATUS_LABELS[s] ?? s.replace(/_/g, " ");
  const color =
    STATUS_COLORS[s] ?? "bg-[var(--surface-2)] text-[var(--faint)]";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${color}`}>
      {label}
    </span>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function OverdueHoldingsView({ days = 14 }: { days?: number }) {
  const { pushToast } = useDashboard();
  const [rows, setRows] = React.useState<OverdueRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [writingOff, setWritingOff] = React.useState<string | null>(null);
  // confirmWriteOff holds the jobId pending user confirmation; null = no pending confirm.
  const [confirmWriteOff, setConfirmWriteOff] = React.useState<OverdueRow | null>(null);

  const [tick, setTick] = React.useState(0);
  const reload = React.useCallback(() => setTick((n) => n + 1), []);

  React.useEffect(() => {
    let active = true;
    gmService
      .listOverdue(days)
      .then((data) => {
        if (!active) return;
        setError(null);
        setRows(data);
      })
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Could not load overdue holdings.",
        );
      });
    return () => {
      active = false;
    };
  }, [days, tick]);

  const handleWriteOff = async (row: OverdueRow) => {
    setConfirmWriteOff(null);
    setWritingOff(row.jobId);
    try {
      await gmService.closeReconcile(row.jobId, true);
      pushToast(
        `Job ${row.jobNumber} reconciled — unaccounted stock written off as lost.`,
        "success",
      );
      reload();
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not reconcile job.",
        "alert",
      );
    } finally {
      setWritingOff(null);
    }
  };

  if (error) {
    return (
      <p className="py-8 text-center text-sm font-semibold text-[var(--neg)]">
        {error}
      </p>
    );
  }

  if (rows === null) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full text-left text-sm" style={{ minWidth: 650 }}>
          <thead>
            <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              {OVERDUE_HEADERS.map((h, i) => (
                <th key={i} className={`px-4 py-3 ${i === 3 ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-[var(--border)] last:border-0">
                {OVERDUE_HEADERS.map((_h, j) => (
                  <td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-14 text-center">
        <Clock className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">
          No overdue stock
        </p>
        <p className="text-xs text-[var(--muted)]">
          Issued stock held by engineers for more than {days} days will appear
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-left text-sm" style={{ minWidth: 650 }}>
        <thead className="sticky top-0 z-10 bg-[var(--surface)]">
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Job</th>
            <th className="px-4 py-3">Engineer</th>
            <th className="px-4 py-3">Issued</th>
            <th className="px-4 py-3 text-right">Days out</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.movementId}
              className="border-b border-[var(--border)] align-middle last:border-0"
            >
              <td className="px-4 py-3">
                <div className="font-bold text-[var(--ink)]">
                  {row.jobNumber}
                </div>
                <div className="font-mono text-[11px] text-[var(--faint)]">
                  {row.movementCode}
                </div>
              </td>
              <td className="px-4 py-3 text-xs text-[var(--muted)]">
                {row.engineerName ?? "—"}
              </td>
              <td className="px-4 py-3 text-xs text-[var(--muted)]">
                {fmtDate(row.issuedAt)}
              </td>
              <td className="px-4 py-3 text-right font-bold text-[var(--neg)]">
                {row.daysOut}
              </td>
              <td className="px-4 py-3">{statusChip(row.goodsStatus)}</td>
              <td className="px-4 py-3">
                {row.goodsStatus !== "reconciled" && (
                  confirmWriteOff?.jobId === row.jobId ? (
                    // Inline confirmation — prevents accidental irreversible write-offs.
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-[var(--neg)]">
                        Write off as lost?
                      </span>
                      <button
                        type="button"
                        onClick={() => handleWriteOff(row)}
                        disabled={writingOff === row.jobId}
                        className="flex items-center gap-1 rounded-xl bg-[var(--neg)] px-2.5 py-1 text-[11px] font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                      >
                        {writingOff === row.jobId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : null}
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmWriteOff(null)}
                        className="rounded-xl border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold text-[var(--muted)] transition-all hover:text-[var(--ink)]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmWriteOff(row)}
                      disabled={writingOff === row.jobId}
                      className="flex items-center gap-1.5 rounded-xl bg-[var(--neg)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                    >
                      {writingOff === row.jobId ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Write off (lost)
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
