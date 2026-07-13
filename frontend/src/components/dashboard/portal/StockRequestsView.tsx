"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, PackagePlus, Plus } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { primaryBtn } from "@/components/ui/styles";
import { StockRequestModal } from "@/components/dashboard/stock/StockRequestModal";
import type { PagedStockRequests } from "@/services/customer.service";
import type { StockRequest } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

import {
  EmptyState,
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  RequestStatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";

const HEADERS = ["Item", "Qty", "Submitted", "Status"];
const SKELETON_CELLS = ["h-3 w-44", "h-3 w-8", "h-3 w-20", "h-5 w-20 rounded-full"];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "assigned", label: "Assigned" },
  { value: "partially_received", label: "Partially received" },
  { value: "completed", label: "Completed" },
];

// Customer portal — Stock Requests. Server-paged with a status filter (submissions accumulate
// forever); filters live in the URL (?status, ?page) so they survive a refresh. Submitting a
// request is the ONE write a portal user can make; an internal user approves or rejects it.
export function StockRequestsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedStockRequests | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/portal/requests?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await customerService.getOwnStockRequests({ status: status || undefined, page, pageSize: 20 });
        if (active) {
          setPaged(r);
          // Clear a stale load error so the table shows again, but keep a success message
          // (onSubmitted sets one, then triggers this refetch — don't wipe the confirmation).
          setMsg((m) => (m?.type === "error" ? null : m));
        }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your requests." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [status, page, refreshKey]);

  const onSubmitted = (request: StockRequest) => {
    setRequestOpen(false);
    setMsg({
      type: "success",
      text: `Request submitted for "${request.name}" — your account team will review it.`,
    });
    // Jump back to page 1 (newest first) so the new submission is visible. If a filter/page was
    // active, resetting the URL already re-runs the fetch effect; only when we're ALREADY at the
    // default view (nothing to reset) do we need to nudge refreshKey — avoids a double fetch.
    if (status || page > 1) patchParams({ page: null, status: null });
    else setRefreshKey((k) => k + 1);
  };

  const requests = paged?.requests ?? [];
  const filtered = !!status;

  if (loading && paged === null) {
    return (
      <div className="flex h-full flex-col gap-4">
        <HeaderCardSkeleton action />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PortalHeader
        title="Stock Submissions"
        subtitle="Submit stock to your account team and track each submission's status."
        action={
          <button type="button" onClick={() => setRequestOpen(true)} className={primaryBtn}>
            <Plus className="h-4 w-4" /> Submit stock
          </button>
        }
      />

      {msg && <div className="shrink-0"><Notice msg={msg} /></div>}

      {/* Toolbar — status filter */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:items-center">
        <Select
          size="sm"
          value={status}
          onChange={(v) => patchParams({ status: v || null }, true)}
          options={STATUS_OPTIONS}
          ariaLabel="Status filter"
        />
      </div>

      {msg?.type === "error" ? null : loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      ) : requests.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            icon={ClipboardList}
            title={filtered ? "No matching submissions" : "No submissions yet"}
            hint={
              filtered
                ? "Try a different status filter."
                : 'Use "Submit stock" to send an item to your account team. They review every submission before anything is added.'
            }
          />
        </div>
      ) : (
        <>
          <TableCard headers={HEADERS} fill>
            {requests.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)] align-top last:border-0">
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[var(--ink)]">{r.editedName ?? r.name}</span>
                    {r.linkedStockEntryId && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                        <PackagePlus className="h-3 w-3" />
                        Top-up
                      </span>
                    )}
                  </div>
                  {r.editedName && r.editedName !== r.name && (
                    <div className="mt-0.5 text-[11px] text-[var(--faint)] line-through">{r.name}</div>
                  )}
                  {r.reason && (
                    <div className="mt-0.5 max-w-md text-[11px] text-[var(--muted)]">{r.reason}</div>
                  )}
                </td>
                <td className="px-4 py-3 font-bold text-[var(--ink)]">{r.quantity ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(r.createdAt)}</td>
                <td className="px-4 py-3">
                  <RequestStatusChip value={r.status} />
                  {r.adminResponse && (r.status === "rejected" || r.status === "approved") && (
                    <div className="mt-1 max-w-xs text-[11px] text-[var(--muted)]">
                      {r.adminResponse}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </TableCard>
          <div className="shrink-0">
            <Pagination
              page={paged?.page ?? 1}
              totalPages={paged?.totalPages ?? 1}
              total={paged?.total ?? 0}
              label="submissions"
              onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
            />
          </div>
        </>
      )}

      {requestOpen && (
        <StockRequestModal onClose={() => setRequestOpen(false)} onSubmitted={onSubmitted} />
      )}
    </div>
  );
}
