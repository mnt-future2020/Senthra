"use client";

// OverdueHoldingsView — lists jobs whose stock was issued more than N days ago and is STILL out with
// the engineer (issued − used − returned > 0). Provides a "Write off (lost)" button that calls
// closeReconcile(jobId, true).
//
// The window comes from Settings → Operations and from nowhere else — there is deliberately no picker
// here. One briefly existed, and it was wrong: choosing fewer days than the configured threshold filled
// a screen headed "Overdue" with jobs that were not overdue by the company's own rule, indistinguishable
// from the ones that were. The server reports the window it used, and it is stated above the table so
// the rule behind the list is never invisible.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Clock, Loader2 } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { WriteOffLostModal, type WriteOffTarget } from "./WriteOffLostModal";
import type { OverdueRow } from "@/types/goodsManagement";

// Status sits next to the right-aligned Days out so the two right-hand columns read as one group. When
// Days out was the ONLY right-aligned column, wedged between left-aligned text, its number looked
// stranded rather than aligned to anything.
const OVERDUE_HEADERS = ["Job", "Engineer", "Issued", "Status", "Days out", ""];

const PAGE_SIZE = 20;

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

// `warehouseId` scopes the list to issues made FROM that warehouse. The Goods Management tab is a
// per-warehouse surface and its other sections are already scoped — this one wasn't, so standing in
// Warehouse A's tab listed Warehouse B's overdue jobs as if they were A's. Optional so a
// company-wide mount still works.
export function OverdueHoldingsView({ warehouseId }: { warehouseId?: string }) {
  const { pushToast } = useDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Namespaced `gmOv*` params, matching how the host tab persists its own filters — a refresh or a
  // shared link restores the same page and search without clobbering the page's ?tab.
  const urlSearch = searchParams.get("gmOvq") ?? "";
  const page = Math.max(1, Number(searchParams.get("gmOvPage")) || 1);
  const [searchInput, setSearchInput] = React.useState(urlSearch);

  const [rows, setRows] = React.useState<OverdueRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [serverPage, setServerPage] = React.useState(page);
  // The window the server actually used. Known only once the response lands, so the caption reads
  // "…" for that first moment rather than guessing a number that might be wrong.
  const [effectiveDays, setEffectiveDays] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Set while the preview call is in flight for a row; the modal owns the confirmation itself.
  const [writingOff, setWritingOff] = React.useState<string | null>(null);
  const [writeOffTarget, setWriteOffTarget] = React.useState<WriteOffTarget | null>(null);

  const [tick, setTick] = React.useState(0);
  const reload = React.useCallback(() => setTick((n) => n + 1), []);

  // Preserves every other param so the host tab's ?tab / ?gmSection survive.
  const patch = React.useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("gmOvPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Debounce the search box into ?gmOvq.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== urlSearch) patch({ gmOvq: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, urlSearch, patch]);

  React.useEffect(() => {
    let active = true;
    gmService
      .listOverdue({ warehouseId, search: urlSearch || undefined, page, pageSize: PAGE_SIZE })
      .then((data) => {
        if (!active) return;
        setError(null);
        setRows(data.rows);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        // The SERVER's page, not the one in the URL. It clamps to the last real page, so if rows
        // vanished while you were on page 3 of 3 the pager would otherwise render "Page 3 of 2" and
        // keep saying so until you clicked something.
        setServerPage(data.page);
        setEffectiveDays(data.days);
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
  }, [warehouseId, urlSearch, page, tick]);

  // Step ONE of the write-off: preview. Calling close with no payload never acts — it reports what the
  // engineer still holds and leaves the job open — so the modal can show exactly what is about to be
  // lost. The old flow skipped this and reconciled straight from the row, which meant confirming a
  // number nobody had seen. If nothing is outstanding the job simply reconciles here, which is the
  // correct outcome and needs no write-off at all.
  const startWriteOff = async (row: OverdueRow) => {
    setWritingOff(row.jobId);
    try {
      const { unaccounted } = await gmService.closeReconcile(row.jobId);
      if (unaccounted.length === 0) {
        pushToast(`Job ${row.jobNumber} reconciled — nothing was outstanding.`, "success");
        reload();
        return;
      }
      setWriteOffTarget({ jobId: row.jobId, jobNumber: row.jobNumber, unaccounted });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not check what is outstanding.", "alert");
    } finally {
      setWritingOff(null);
    }
  };

  // ONE shell for every state. The caption and the search box render even when the list comes back
  // empty — otherwise a search that matches nothing would take its own Clear button off screen with it,
  // leaving the user stuck on a blank panel with no way back.
  const body = error ? (
    <p className="py-8 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
  ) : rows === null ? (
    <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm" style={{ minWidth: 650 }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {OVERDUE_HEADERS.map((h, i) => (
              <th key={i} className={`px-4 py-3 ${i === 4 ? "text-right" : ""}`}>{h}</th>
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
  ) : rows.length === 0 ? (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-14 text-center">
      <Clock className="h-7 w-7 text-[var(--faint)]" />
      <p className="text-sm font-semibold text-[var(--ink)]">
        {urlSearch ? "No overdue stock matches your search" : "No overdue stock"}
      </p>
      <p className="text-xs text-[var(--muted)]">
        {urlSearch
          ? `Nothing overdue matches “${urlSearch}”.`
          : `Issued stock still held by engineers for more than ${effectiveDays ?? "…"} days will appear here.`}
      </p>
      {urlSearch && (
        <button type="button" onClick={() => { setSearchInput(""); patch({ gmOvq: null }); }} className="text-xs font-bold text-[var(--accent)]">
          Clear search
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* The rule behind the list, always on screen. It used to appear only in the EMPTY state — so the
          threshold was visible exactly when there was nothing to read it against, and invisible the
          moment rows showed up. Reading the server's own figure rather than a local constant, so an
          admin editing the setting is reflected here and cannot be silently contradicted. */}
      <p className="shrink-0 text-xs text-[var(--muted)]">
        Stock still out more than <span className="font-bold text-[var(--ink)]">{effectiveDays ?? "…"}</span> days —
        set in Settings → Operations. Longest overdue first.
      </p>

      <WorkspaceToolbar
        search={{
          value: searchInput,
          onChange: setSearchInput,
          placeholder: "Search job no., name or engineer…",
          ariaLabel: "Search overdue holdings",
        }}
      />

      {body}

      {body === null && rows !== null && (
      <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-left text-sm" style={{ minWidth: 650 }}>
        <thead className="sticky top-0 z-10 bg-[var(--surface)]">
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Job</th>
            <th className="px-4 py-3">Engineer</th>
            <th className="px-4 py-3">Issued</th>
            <th className="px-4 py-3">Status</th>
            {/* Days out sits beside the action so the right edge reads as one aligned group. On its own
                between two left-aligned text columns, the number looked stranded. */}
            <th className="px-4 py-3 text-right">Days out</th>
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
              <td className="px-4 py-3">{statusChip(row.goodsStatus)}</td>
              <td className="px-4 py-3 text-right font-bold tabular-nums text-[var(--neg)]">
                {row.daysOut}
              </td>
              {/* Anchored to the right edge like the action column in Inventory. `text-right` alone
                  wouldn't do it — the button is itself a flex container, so it would stretch across
                  the cell and sit wherever the column happened to start. */}
              <td className="px-4 py-3">
                <div className="flex justify-end">
                {/* Opens the write-off modal rather than confirming inline: the row has nowhere to show
                    WHAT would be lost or to ask why, and both are required now. */}
                {row.goodsStatus !== "reconciled" && (
                  <button
                    type="button"
                    onClick={() => startWriteOff(row)}
                    disabled={writingOff === row.jobId}
                    className="flex items-center gap-1.5 rounded-xl bg-[var(--neg)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                  >
                    {writingOff === row.jobId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Write off (lost)
                  </button>
                )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </div>
      <div className="shrink-0">
        <Pagination
          page={serverPage}
          totalPages={totalPages}
          total={total}
          label="jobs"
          onPage={(p) => patch({ gmOvPage: p > 1 ? String(p) : null }, false)}
        />
      </div>
      </>
      )}

      {/* Mounted outside the row branches so it survives the list refetching underneath it. */}
      <WriteOffLostModal
        target={writeOffTarget}
        onClose={() => setWriteOffTarget(null)}
        onWrittenOff={() => {
          pushToast(`Job ${writeOffTarget?.jobNumber} reconciled — stock written off as lost.`, "success");
          reload();
        }}
      />
    </div>
  );
}
