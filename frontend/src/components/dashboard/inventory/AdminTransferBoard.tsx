"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import * as transferSvc from "@/services/engineerTransfer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { TableSkeletonRows } from "./hubUi";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import type { EngineerTransfer, PagedTransfers } from "@/services/engineerTransfer.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TH = "px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]";
const TD = "px-4 py-3";

const STATUS_CLS: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-600",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-[var(--pos)]",
  declined: "border-red-500/30 bg-red-500/10 text-[var(--neg)]",
  cancelled: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
};

// Stock ownership shown in the lines table — "IRM (Company)" reads clearer than a bare "Company".
const ownershipLabel = (o: string) => (o === "company" ? "IRM (Company)" : "Customer");

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${STATUS_CLS[status] ?? STATUS_CLS.cancelled}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function requestAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ── Admin action modal (decline / cancel) ─────────────────────────────────────

function AdminActionModal({
  transfer,
  action,
  onDone,
  onCancel,
}: {
  transfer: EngineerTransfer;
  action: "decline" | "cancel" | "override";
  onDone: () => void;
  onCancel: () => void;
}) {
  const { pushToast } = useDashboard();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (action === "decline") await transferSvc.declineTransfer(transfer.id, reason.trim() || undefined);
      else if (action === "cancel") await transferSvc.cancelTransfer(transfer.id);
      else await transferSvc.overrideTransfer(transfer.id);
      pushToast(action === "decline" ? "Transfer declined." : action === "cancel" ? "Transfer cancelled." : "Transfer override-approved.");
      onDone();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const title =
    action === "decline" ? "Decline transfer" :
    action === "cancel" ? "Cancel transfer" :
    "Override-approve transfer";

  const btnCls =
    action === "override"
      ? `flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-extrabold text-white disabled:opacity-60`
      : `flex items-center gap-2 rounded-xl bg-[var(--neg)] px-4 py-2.5 text-xs font-extrabold text-white disabled:opacity-60`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
        <h3 className="mb-1 text-sm font-extrabold text-[var(--ink)]">{title}</h3>
        <p className="mb-4 text-xs text-[var(--muted)]">{transfer.code}</p>
        <form onSubmit={submit} className="space-y-3">
          {(action === "decline") && (
            <div>
              <label className={labelCls}>Reason (optional)</label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={`${inputCls} resize-none`}
              />
            </div>
          )}
          {action === "override" && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700">
              Admin override: this will complete the transfer without the holder&apos;s approval and record your action in the audit log.
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onCancel} className={secondaryBtn}>Cancel</button>
            <button type="submit" disabled={busy} className={btnCls}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {action === "override" ? "Override-approve" : action === "decline" ? "Decline" : "Cancel transfer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Transfer table row ────────────────────────────────────────────────────────

function AdminTransferRow({
  transfer,
  canManage,
  onAction,
}: {
  transfer: EngineerTransfer;
  canManage: boolean;
  onAction: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [modal, setModal] = React.useState<"decline" | "cancel" | "override" | null>(null);

  return (
    <>
      {modal && (
        <AdminActionModal
          transfer={transfer}
          action={modal}
          onDone={() => { setModal(null); onAction(); }}
          onCancel={() => setModal(null)}
        />
      )}
      <tr className="border-b border-[var(--border)] last:border-0">
        <td className={TD}>
          <div className="font-mono text-xs font-bold text-[var(--ink)]">{transfer.code}</div>
          <div className="flex items-center gap-1 text-[11px] text-[var(--faint)]">
            <Clock className="h-3 w-3" /> {requestAge(transfer.createdAt)}
          </div>
        </td>
        <td className={TD}>
          <div className="text-sm font-semibold text-[var(--ink)]">{transfer.fromEngineerName}</div>
          <div className="text-[11px] text-[var(--faint)]">{transfer.fromEngineerEmail ?? ""}</div>
        </td>
        <td className={TD}>
          <div className="text-sm font-semibold text-[var(--ink)]">{transfer.toEngineerName}</div>
          <div className="text-[11px] text-[var(--faint)]">{transfer.toEngineerEmail ?? ""}</div>
        </td>
        <td className={`${TD} text-xs text-[var(--muted)] max-w-[160px]`}>
          <p className="truncate">{transfer.reason}</p>
        </td>
        <td className={TD}>
          <StatusBadge status={transfer.status} />
          {transfer.overrideByAdmin && (
            <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-10)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">
              <ShieldCheck className="h-3 w-3" /> Override
            </span>
          )}
        </td>
        <td className={TD}>
          <div className="flex items-center gap-2">
            {canManage && transfer.status === "pending" && (
              <>
                <button
                  type="button"
                  onClick={() => setModal("override")}
                  className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white"
                >
                  <Check className="h-3 w-3" /> Override
                </button>
                <button
                  type="button"
                  onClick={() => setModal("decline")}
                  className="flex items-center gap-1 rounded-lg border border-[var(--neg)]/30 px-2.5 py-1.5 text-[11px] font-bold text-[var(--neg)]"
                >
                  <X className="h-3 w-3" /> Decline
                </button>
                <button
                  type="button"
                  onClick={() => setModal("cancel")}
                  className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] hover:text-[var(--neg)]"
                >
                  <X className="h-3 w-3" /> Cancel
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="rounded-lg border border-[var(--border)] p-1.5 hover:bg-[var(--surface-2)]"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5 text-[var(--muted)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--muted)]" />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] last:border-0">
          <td colSpan={6} className="px-4 pb-4 pt-2">
            <div className="space-y-2 text-xs">
              {transfer.notes && <p className="text-[var(--muted)]"><span className="font-semibold text-[var(--ink)]">Notes:</span> {transfer.notes}</p>}
              {transfer.declineReason && <p className="text-[var(--neg)]">Declined: {transfer.declineReason}</p>}
              <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">Ownership</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfer.lines.map((l) => (
                      <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2 font-semibold text-[var(--ink)]">{l.itemName}{l.sku && <span className="ml-1 font-mono text-[10px] text-[var(--faint)]">· {l.sku}</span>}</td>
                        <td className="px-3 py-2 text-[var(--muted)]">{ownershipLabel(l.ownership)}</td>
                        <td className="px-3 py-2 text-right font-bold text-[var(--ink)]">{l.quantity}{l.uom ? ` ${l.uom}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main board ────────────────────────────────────────────────────────────────

export function AdminTransferBoard() {
  const { can } = useAuth();
  const canManage = can("engineer_stock.transfer");
  const router = useRouter();

  const [transfers, setTransfers] = React.useState<PagedTransfers | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Filters live in the URL (?status, ?sort, ?q, ?page) so they survive a refresh and the socket
  // remounts — same URL-as-state approach as the Inventory Hub lens (?tab).
  const searchParams = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const sortOldest = searchParams.get("sort") !== "newest"; // default: oldest first
  const search = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // The text box keeps its own immediate value; the debounced result is written to ?q.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const reload = React.useCallback(() => setRefreshKey((k) => k + 1), []);
  useGoodsSocket(reload);

  // Patch the inventory URL, preserving the lens (?tab) and sub-view (?view). `resetPage` drops ?page.
  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/inventory?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Debounce the search box into ?q.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await transferSvc.listAllTransfers({
          status: statusFilter || undefined,
          sort: sortOldest ? "oldest" : "newest",
          search: search || undefined,
          page,
          pageSize: 25,
        });
        if (active) setTransfers(r);
      } catch {
        if (active) setTransfers({ transfers: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [statusFilter, sortOldest, search, page, refreshKey]);

  return (
    <>
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search code, reason, engineer…"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs font-semibold text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
            />
          </div>
          <Select
            size="sm"
            value={statusFilter}
            onChange={(v) => patchParams({ status: v || null }, true)}
            options={[
              { value: "", label: "All statuses" },
              { value: "pending", label: "Pending" },
              { value: "completed", label: "Completed" },
              { value: "declined", label: "Declined" },
              { value: "cancelled", label: "Cancelled" },
            ]}
            ariaLabel="Status filter"
          />
          <Select
            size="sm"
            value={sortOldest ? "oldest" : "newest"}
            onChange={(v) => patchParams({ sort: v === "oldest" ? null : "newest" }, true)}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
            ariaLabel="Sort order"
          />
        </div>
        {canManage && (
          <button type="button" onClick={() => router.push("/dashboard/inventory/engineer-transfer/new")} className={primaryBtn}>
            <ArrowRightLeft className="h-3.5 w-3.5" /> New transfer
          </button>
        )}
      </div>

      {/* Table */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)]">
                <th className={TH}>Code / Age</th>
                <th className={TH}>From</th>
                <th className={TH}>To</th>
                <th className={TH}>Reason</th>
                <th className={TH}>Status</th>
                <th className={TH} />
              </tr>
            </thead>
            {loading ? (
              <TableSkeletonRows cols={6} />
            ) : (
              <tbody>
                {transfers?.transfers.map((t) => (
                  <AdminTransferRow
                    key={t.id}
                    transfer={t}
                    canManage={canManage}
                    onAction={reload}
                  />
                ))}
                {transfers && transfers.transfers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <ArrowRightLeft className="h-7 w-7 text-[var(--faint)]" />
                        <p className="text-sm font-semibold text-[var(--ink)]">No transfers found</p>
                        <p className="text-xs text-[var(--muted)]">Try changing the status filter.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            )}
          </table>
        </div>
        {transfers && transfers.total > 0 && (
          <div className="shrink-0 border-t border-[var(--border)] p-3">
            <Pagination
              page={transfers.page}
              totalPages={transfers.totalPages}
              total={transfers.total}
              label="transfers"
              onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
            />
          </div>
        )}
      </div>
    </>
  );
}
