"use client";

import * as React from "react";
import { ClipboardList, Plus } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { primaryBtn } from "@/components/ui/styles";
import { StockRequestModal } from "@/components/dashboard/stock/StockRequestModal";
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

// Customer portal — Stock Requests. The customer's own order / replenishment asks
// and their review status. Submitting a request is the ONE write a portal user can
// make; an internal user approves or rejects it (approval never creates catalogue or
// inventory records on its own).
export function StockRequestsView() {
  const [requests, setRequests] = React.useState<StockRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await customerService.getOwnStockRequests();
        if (active) setRequests(list);
      } catch (err) {
        if (active) {
          setMsg({
            type: "error",
            text: err instanceof Error ? err.message : "Could not load your requests.",
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const onSubmitted = (request: StockRequest) => {
    setRequests((prev) => [request, ...prev]);
    setRequestOpen(false);
    setMsg({
      type: "success",
      text: `Request submitted for "${request.name}" — your account team will review it.`,
    });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <HeaderCardSkeleton action />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalHeader
        title="Stock Requests"
        subtitle="Request stock from your account team and track each request's status."
        action={
          <button type="button" onClick={() => setRequestOpen(true)} className={primaryBtn}>
            <Plus className="h-4 w-4" /> Request stock
          </button>
        }
      />

      {msg && <Notice msg={msg} />}

      {msg?.type === "error" ? null : requests.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No requests yet"
          hint='Use "Request stock" to ask your account team for an item. They review every request before anything is added.'
        />
      ) : (
        <TableCard headers={HEADERS}>
          {requests.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-4 py-3">
                <div className="font-semibold text-[var(--ink)]">{r.editedName ?? r.name}</div>
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
      )}

      {requestOpen && (
        <StockRequestModal onClose={() => setRequestOpen(false)} onSubmitted={onSubmitted} />
      )}
    </div>
  );
}
