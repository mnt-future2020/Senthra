"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Download, Loader2, PackagePlus, Plus, Search } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { primaryBtn, toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import { StockRequestModal } from "@/components/dashboard/stock/StockRequestModal";
import type { PagedStockRequests } from "@/services/customer.service";
import type { PortalStockRequest, PortalWarehouseAssignment } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

import { Modal } from "@/components/ui/Modal";
import {
  clickableRowCls,
  DetailGrid,
  DetailRow,
  EmptyState,
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  RequestStatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";
import { summariseShortfall } from "./stockRequestShortfall";

const HEADERS = ["Item", "Qty", "Submitted", "Status"];
const SKELETON_CELLS = ["h-3 w-44", "h-3 w-8", "h-3 w-20", "h-5 w-20 rounded-full"];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  // Pseudo-status resolved on the SERVER (see OPEN_REQUEST_STATUSES) — pending, approved, assigned
  // and partially received in one option. It exists so the dashboard's "Open submissions" card has
  // somewhere to land: a count you can see but not reach is a count the customer has to hunt for.
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "assigned", label: "Assigned" },
  { value: "partially_received", label: "Partially received" },
  { value: "completed", label: "Completed" },
];

// "Completed" on its own would be the only thing a customer ever saw about a delivery that came up
// short, so the shortfall has to be visible in the LIST — but as a chip beside the status, not as
// lines beneath it. Two extra lines on some rows and none on others took the table from ~44px to
// ~94px per row depending on the data, and a list you scan needs one rhythm, not four.
//
// Amber, not red: a fact about the delivery, not an error the customer must act on. `title` puts the
// exact split and the reason one hover away; the row's detail panel has both in full, unabbreviated.
//
// "not received", NOT "short". "Short" is warehouse trade language (short shipment, picking short)
// and the reader is a customer; on its own "23 short" can even parse as an adjective. "Received" is
// already the verb this whole screen runs on ("2 of 25 received", the RECEIVED column), so its
// negation needs no learning — and unlike "missing" it states the fact without implying a cause,
// which matters when the commonest cause is that the customer simply shipped fewer than they
// declared. Nothing was lost; it just never arrived. Used verbatim in the panel too, so clicking a
// row never renames what it just told you.
function ShortfallBadge({ assignments }: { assignments: PortalWarehouseAssignment[] }) {
  const short = summariseShortfall(assignments);
  if (!short) return null;
  const detail = `${short.received} of ${short.total} received`;
  return (
    <span
      title={short.reasons.length > 0 ? `${detail} — ${short.reasons.join(" · ")}` : detail}
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--warn)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--warn)]"
    >
      {short.units} not received
    </span>
  );
}

// The submission's per-warehouse breakdown. The list can only show ONE aggregate pair, so a
// submission split across two warehouses told the customer 2 of 25 arrived without saying where —
// and it's the warehouse that decides which of their sites the stock can serve. The data was
// already in the payload; there was simply nowhere to put it.
function SubmissionModal({ request, onClose }: { request: PortalStockRequest; onClose: () => void }) {
  const legs = request.warehouseAssignments;
  return (
    <Modal
      open
      title={request.editedName ?? request.name}
      subtitle={`Submitted ${fmtDate(request.createdAt)}`}
      onClose={onClose}
      size="md"
    >
      <DetailGrid>
        <DetailRow label="Status" value={<RequestStatusChip value={request.status} />} />
        <DetailRow label="Quantity submitted" value={<span className="font-bold">{request.quantity ?? "—"}</span>} />
      </DetailGrid>

      {/* The account team renamed this. Shown because the customer submitted the OTHER name and
          would otherwise not recognise their own row.
          NOT struck through: the label says this IS the name they submitted, so striking it says the
          opposite of the label and the pair stops making sense — a strike on its own also reads as
          "rejected/deleted" rather than "renamed". The list row strikes it because it has no room
          for a label; here there is room, so the relationship is stated in words. */}
      {request.editedName && request.editedName !== request.name && (
        <div className="mt-1 border-t border-[var(--border)] pt-2">
          <DetailRow
            label="You submitted this as"
            value={request.name}
            hint={`Your account team renamed it to “${request.editedName}”.`}
          />
        </div>
      )}

      {request.reason && (
        <div className="mt-1 border-t border-[var(--border)] pt-2">
          <DetailRow label="Your reason" value={request.reason} />
        </div>
      )}

      {request.adminResponse && (
        <div className="mt-1 border-t border-[var(--border)] pt-2">
          <DetailRow label="Response from your account team" value={request.adminResponse} />
        </div>
      )}

      {legs.length > 0 && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            Where it went
          </p>
          <div className="space-y-2">
            {legs.map((leg, i) => {
              const missing = leg.status === "closed_short" ? Math.max(0, leg.quantity - leg.receivedQuantity) : 0;
              return (
                // Keyed by index: the portal shape carries no assignment id (it isn't the customer's
                // handle on anything), and the order is the server's stable creation order.
                <div key={i} className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[var(--ink)]">{leg.warehouseName}</span>
                    <span className="text-xs text-[var(--muted)]">
                      {leg.receivedQuantity} of {leg.quantity} received
                    </span>
                  </div>
                  {missing > 0 && (
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                      <span className="font-bold text-[var(--warn)]">{missing} not received</span>
                      {leg.closureReason && <> — {leg.closureReason}</>}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Customer portal — Stock Requests. Server-paged with search + a status filter (submissions
// accumulate forever); filters live in the URL (?q, ?status, ?page) so they survive a refresh.
// Submitting a request is the ONE write a portal user can make; an internal user approves or rejects it.
export function StockRequestsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const search = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedStockRequests | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  // Separate from `msg`, which carries the load error (that one HIDES the table) and the
  // submission confirmation. An export failure must do neither: the list is fine, and clobbering
  // "Request submitted" would swallow the receipt for the one write this portal allows.
  const [exportMsg, setExportMsg] = React.useState<Msg>(null);
  const [exporting, setExporting] = React.useState(false);
  // The row whose detail panel is open. Holds the ROW itself — the list is loaded, so opening one
  // fetches nothing and the panel has no loading state of its own.
  const [selected, setSelected] = React.useState<PortalStockRequest | null>(null);

  // Typed freely, pushed to the URL on a debounce so a keystroke isn't a fetch AND a history entry.
  // Re-synced during render (not in an effect) when the URL changes from outside — Clear, back button —
  // so the box never shows a stale term for a frame. Same shape as Sites / Projects / My Stock.
  const [searchInput, setSearchInput] = React.useState(search);
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

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
        // Searched SERVER-SIDE. Submissions are paged and accumulate for the life of the account, so
        // an in-browser filter would only ever search the current page and report "no matches" for a
        // submission sitting on page 4.
        const r = await customerService.getOwnStockRequests({
          q: search || undefined,
          status: status || undefined,
          page,
          pageSize: 20,
        });
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
  }, [search, status, page, refreshKey]);

  const onSubmitted = (request: PortalStockRequest) => {
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
  const filtered = !!status || !!search;

  // Passes the CURRENT filters, not the page. A capped export is reported rather than silently
  // truncated — a short file the customer believes is complete is worse than no file.
  const onExport = async () => {
    setExporting(true);
    try {
      const { capped } = await customerService.exportOwnStockRequestsCsv({
        q: search || undefined,
        status: status || undefined,
      });
      setExportMsg(
        capped
          ? { type: "error", text: "Export truncated — too many rows. Narrow the filters and try again." }
          : null,
      );
    } catch (err) {
      setExportMsg({ type: "error", text: err instanceof Error ? err.message : "Could not export your submissions." });
    } finally {
      setExporting(false);
    }
  };

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
      {exportMsg && <div className="shrink-0"><Notice msg={exportMsg} /></div>}

      {/* Toolbar — search + status. Submissions accumulate for the life of the account and this list
          is already more than one page, so search matters MORE here than on Sites (3 rows, stable)
          which has had it all along. Filters group next to the search, as on every other portal list. */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search submissions…"
            aria-label="Search your submissions"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            value={status}
            onChange={(v) => patchParams({ status: v || null }, true)}
            options={STATUS_OPTIONS}
            ariaLabel="Status filter"
          />
          {filtered && (
            <button
              type="button"
              onClick={() => patchParams({ q: null, status: null }, true)}
              className={toolbarBtn}
            >
              Clear
            </button>
          )}
          {/* Exports the FILTERED set, one row per warehouse leg. Disabled on an empty list — a CSV
              containing only a header reads as a broken download. */}
          <button
            type="button"
            onClick={onExport}
            disabled={exporting || requests.length === 0}
            title="Export the filtered list to CSV"
            className={toolbarBtn}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
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
                ? "Nothing matches your search or filter. Clear them to see every submission."
                : 'Use "Submit stock" to send an item to your account team. They review every submission before anything is added.'
            }
          />
        </div>
      ) : (
        <>
          <TableCard headers={HEADERS} fill>
            {requests.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelected(r);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`View details for ${r.editedName ?? r.name}`}
                // `align-middle` now the cells are single-line — `align-top` was there to keep the
                // stacked sub-lines tidy, and with those gone it just left short cells floating.
                className={`${clickableRowCls} align-middle`}
              >
                {/* ONE line per cell, badges rather than stacked lines. Everything that used to sit
                    under a cell — the renamed-from name, the customer's reason, the account team's
                    response, the shortfall — is prose of unpredictable length, and letting four
                    optional blocks of it into the rows is what made them range from ~44px to ~94px.
                    All of it is in the row's detail panel, in full and unabbreviated; the table's job
                    is to be scannable, and one rhythm is what makes it so. */}
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[var(--ink)]">{r.editedName ?? r.name}</span>
                    {/* Inline, not a line below: the customer submitted this name and needs to
                        recognise their own row, but it costs no height sitting here. */}
                    {r.editedName && r.editedName !== r.name && (
                      <span className="text-[11px] text-[var(--faint)] line-through">{r.name}</span>
                    )}
                    {r.linkedStockEntryId && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                        <PackagePlus className="h-3 w-3" />
                        Top-up
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 font-bold text-[var(--ink)]">{r.quantity ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(r.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RequestStatusChip value={r.status} />
                    <ShortfallBadge assignments={r.warehouseAssignments} />
                    {/* That a response EXISTS is worth a badge — on a rejected submission it's the
                        one thing the customer wants — but the text itself is a paragraph and belongs
                        in the panel, not in a table cell it would stretch to three lines. */}
                    {r.adminResponse && (r.status === "rejected" || r.status === "approved") && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">
                        Note
                      </span>
                    )}
                  </div>
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

      {selected && <SubmissionModal request={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
