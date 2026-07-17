"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, PackagePlus, Undo2 } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockRequest } from "@/services/vanStockRequest.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { EmptyState, fmtDateTime, PortalHeader } from "@/components/dashboard/portal/portalUi";
import { VanRequestItemsSummary, VanRequestLinesTable, VanRequestListSkeleton, warehouseCaption } from "@/components/dashboard/van-requests/vanRequestUi";
import type { Msg } from "@/components/ui/types";

// Engineer portal page: NON-job field stock. Lists the engineer's own restock/return requests with
// live status; the composers are full pages (like transfers/new): ./van-stock/new and
// ./van-stock/return. Cancel pending / cancel-remaining on partially fulfilled from here.

export const VSR_STATUS: Record<VanStockRequest["status"], { cls: string; label: string }> = {
  pending: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", label: "Pending" },
  approved: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", label: "Approved" },
  partially_fulfilled: { cls: "border-sky-500/30 bg-sky-500/10 text-sky-600", label: "Partially fulfilled" },
  fulfilled: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", label: "Fulfilled" },
  declined: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", label: "Declined" },
  cancelled: { cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]", label: "Cancelled" },
};

export function VanStockStatusChip({ value }: { value: VanStockRequest["status"] }) {
  const s = VSR_STATUS[value] ?? VSR_STATUS.pending;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}>{s.label}</span>;
}

function TypeBadge({ type }: { type: VanStockRequest["type"] }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
      {type === "return" ? "Return" : "Restock"}
    </span>
  );
}

function StaleChip() {
  return <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">Stale</span>;
}

const PAGE_SIZE = 20;

export function EngineerVanStock() {
  const router = useRouter();
  const { pushToast } = useDashboard();
  const [requests, setRequests] = React.useState<VanStockRequest[] | null>(null);
  const [meta, setMeta] = React.useState({ total: 0, totalPages: 1 });
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null); // load failure — distinct from an empty list
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set()); // rows whose inline item detail is open
  const toggleExpand = React.useCallback((id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  // Cancel / cancel-remaining go through the app's ConfirmDialog (not window.confirm) for consistency.
  const [confirm, setConfirm] = React.useState<{ open: boolean; id: string | null; kind: "cancel" | "cancel-remaining" }>({ open: false, id: null, kind: "cancel" });

  const load = React.useCallback(() => {
    vanStockSvc
      .listMyVanStockRequests({ page, pageSize: PAGE_SIZE })
      .then((r) => {
        // Cancelling the only request on the last page shrinks totalPages below `page`; the server then
        // returns an empty list, which renders the "no requests yet" empty state AND hides the pager —
        // stranding the engineer with no control to get back. Clamping the pager's `page` prop alone
        // fixes the display but not the query, so step the state back and let the refetch land on a
        // page that exists. Guarded on `total > 0` so a genuinely empty list still shows its empty state.
        if (page > r.totalPages && r.total > 0) { setPage(r.totalPages); return; }
        setRequests(r.requests);
        setMeta({ total: r.total, totalPages: r.totalPages });
        setError(null);
      })
      .catch((err) => { setRequests([]); setMeta({ total: 0, totalPages: 1 }); setError(err instanceof Error ? err.message : "Could not load your requests."); });
  }, [page]);

  React.useEffect(() => load(), [load]);
  // Live-refresh when the warehouse reviews or fulfils one of this engineer's requests.
  React.useEffect(() => subscribe(["van_stock_request:updated"], load), [load]);

  // Runs the confirmed cancel / cancel-remaining once the ConfirmDialog is accepted.
  const runConfirmed = async () => {
    const { id, kind } = confirm;
    if (!id) return;
    setBusyId(id);
    setMsg(null);
    try {
      if (kind === "cancel") {
        await vanStockSvc.cancelVanStockRequest(id);
        pushToast("Request cancelled.", "success");
      } else {
        await vanStockSvc.cancelVanStockRemaining(id);
        pushToast("Remaining quantity cancelled.", "success");
      }
      setConfirm({ open: false, id: null, kind: "cancel" });
      load();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not cancel the request." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <PortalHeader
          title="Field stock"
          subtitle="Request a top-up from a warehouse, or return excess stock — no job needed."
          action={
            <div className="flex gap-2">
              <button type="button" onClick={() => router.push("/dashboard/engineer/van-stock/return")} className={secondaryBtn}>
                <Undo2 className="h-3.5 w-3.5" /> Return stock
              </button>
              <button type="button" onClick={() => router.push("/dashboard/engineer/van-stock/new")} className={primaryBtn}>
                <PackagePlus className="h-3.5 w-3.5" /> Request stock
              </button>
            </div>
          }
        />
      </div>

      {msg && <div className="shrink-0"><Notice msg={msg} /></div>}

      <div className="min-h-0 flex-1 overflow-auto">
      {requests === null ? (
        <VanRequestListSkeleton />
      ) : error ? (
        <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
      ) : requests.length === 0 ? (
        <EmptyState icon={PackagePlus} title="No field stock requests yet" hint="Raise a restock when your consumables run low, or return excess stock to a warehouse." />
      ) : (
        <ul className="space-y-1.5">
          {requests.map((r) => {
            const open = r.status === "pending" || r.status === "approved" || r.status === "partially_fulfilled";
            const isExpanded = expanded.has(r.id);
            const caption = warehouseCaption(r);
            return (
              <li key={r.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xs transition-colors hover:border-[var(--accent)]">
                {/* Compact row: the chevron / body toggles an inline detail panel (full items + progress
                    + warehouse notes) — no navigation. Cancel actions stay on the collapsed row. */}
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(r.id)}
                    className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                    aria-label={isExpanded ? "Hide details" : "Show details"}
                    aria-expanded={isExpanded}
                  >
                    <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>
                  <button type="button" onClick={() => toggleExpand(r.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs font-bold text-[var(--ink)]">{r.code}</span>
                      <TypeBadge type={r.type} />
                      <VanStockStatusChip value={r.status} />
                      {r.stale && <StaleChip />}
                      {r.priority !== "normal" && (
                        <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-600">{r.priority}</span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-[var(--faint)]">{fmtDateTime(r.createdAt)}</span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 text-[var(--faint)]">{r.lines.length} {r.lines.length === 1 ? "item" : "items"}</span>
                      {r.lines.length > 0 && <span className="shrink-0 text-[var(--faint)]">·</span>}
                      <VanRequestItemsSummary lines={r.lines} showProgress={open} className="min-w-0" />
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {r.status === "pending" && (
                      <button type="button" onClick={() => setConfirm({ open: true, id: r.id, kind: "cancel" })} disabled={busyId === r.id} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">
                        {busyId === r.id && <Loader2 className="h-3 w-3 animate-spin" />} Cancel
                      </button>
                    )}
                    {r.status === "partially_fulfilled" && (
                      <button type="button" onClick={() => setConfirm({ open: true, id: r.id, kind: "cancel-remaining" })} disabled={busyId === r.id} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">
                        {busyId === r.id && <Loader2 className="h-3 w-3 animate-spin" />} Cancel remaining
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 pl-9">
                    <VanRequestLinesTable lines={r.lines} variant="engineer" />
                    {caption && <p className="mt-1.5 text-[11px] text-[var(--faint)]">{caption}</p>}
                    {r.reason && <p className="mt-0.5 text-[11px] italic text-[var(--faint)]">“{r.reason}”</p>}
                    {r.status === "declined" && r.decisionNote && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Declined: {r.decisionNote}</p>}
                    {r.completionType === "closed_short" && r.closeShortNote && <p className="mt-0.5 text-[11px] text-[var(--muted)]">Closed short: {r.closeShortNote}</p>}
                    {r.status === "approved" && r.type === "restock" && <p className="mt-0.5 text-[11px] text-[var(--pos)]">Approved — collect from {r.warehouseName ?? "the warehouse"}.</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      </div>

      {requests !== null && requests.length > 0 && (
        <div className="shrink-0">
          <Pagination page={Math.min(page, meta.totalPages)} totalPages={meta.totalPages} total={meta.total} label="requests" onPage={setPage} />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        title={confirm.kind === "cancel" ? "Cancel this request?" : "Cancel the remaining quantity?"}
        message={
          confirm.kind === "cancel"
            ? "This can't be undone — the warehouse won't see it anymore."
            : "What's already been issued stays on your van; only the unfulfilled remainder is cancelled."
        }
        confirmLabel={confirm.kind === "cancel" ? "Cancel request" : "Cancel remaining"}
        danger
        busy={busyId === confirm.id}
        onConfirm={runConfirmed}
        onClose={() => setConfirm({ open: false, id: null, kind: "cancel" })}
      />
    </div>
  );
}
