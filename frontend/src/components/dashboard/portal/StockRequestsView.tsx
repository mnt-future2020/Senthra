"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Download, Loader2, PackagePlus, Plus, Search } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { toolbarActionsCls, toolbarBtn, toolbarInputCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { StockRequestModal } from "@/components/dashboard/stock/StockRequestModal";
import { preferenceOutcome, type PreferenceOutcome } from "@/lib/preferredWarehouse";
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
  RequestStatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";
import { shortfallBadgeText, shortfallTooltip, summariseShortfall } from "./stockRequestShortfall";

const HEADERS = ["Item", "Qty", "Submitted", "Status"];
const SKELETON_CELLS = ["h-3 w-44", "h-3 w-8", "h-3 w-20", "h-5 w-20 rounded-full"];

// The filters an export was produced under, as one comparable string. `page` is absent on purpose:
// the export deliberately ignores paging ("everything matching what I'm looking at").
const exportFilterKey = (search: string, status: string) => `${search}|${status}`;

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
// Amber, not red: a fact about the delivery, not an error the customer must act on — the commonest
// cause is that the customer shipped fewer than they declared. Red would dress a normal business
// event as a fault.
//
// Deliberately still in the STATUS column rather than folded into Qty. Qty is a column every row
// shares, so putting "received of submitted" there would have to say something about a submission
// still in transit too — and "0 of 25" on stock that is simply still travelling reads as a failure
// that hasn't happened. An exception belongs in a mark that only appears when there IS one.
//
// Wording (and why) lives in stockRequestShortfall so a test can hold it still.
function ShortfallBadge({ assignments }: { assignments: PortalWarehouseAssignment[] }) {
  const short = summariseShortfall(assignments);
  if (!short) return null;
  return (
    <span
      title={shortfallTooltip(short)}
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--warn)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--warn)]"
    >
      {shortfallBadgeText(short)}
    </span>
  );
}

// The submission's per-warehouse breakdown. The list can only show ONE aggregate pair, so a
// submission split across two warehouses told the customer 2 of 25 arrived without saying where —
// and it's the warehouse that decides which of their sites the stock can serve. The data was
// already in the payload; there was simply nowhere to put it.
// What became of the customer's preferred warehouse, in their own words. Keyed by the outcome so
// the copy for each state lives in one place. Deliberately points at "Where it went" rather than
// naming the actual warehouses again — that section already lists them with received counts, and
// repeating them here would be a second version of the truth to keep in sync.
const PREFERENCE_HINT: Record<PreferenceOutcome, string> = {
  // Before approval there is no assignment to report — this is the ONLY place the customer can see
  // the warehouse they asked for, so it must read as recorded-and-pending, not as decided.
  pending: "Your account team confirms the final destination.",
  // A rejected submission also has no assignments, and must NOT borrow the pending wording: nothing
  // is being confirmed, and saying otherwise leaves the customer waiting on a decision already made.
  rejected: "This submission was rejected — no stock was booked.",
  honoured: "Your stock was booked here.",
  split: "Also booked to other warehouses — see below.",
  // The override case. Said plainly: the alternative is a customer reading "Where it went" and
  // silently concluding their choice was lost or ignored.
  changed: "Your account team used a different warehouse — see below.",
};

function SubmissionModal({ request, onClose }: { request: PortalStockRequest; onClose: () => void }) {
  const legs = request.warehouseAssignments;
  const outcome = preferenceOutcome(
    request.preferredWarehouseName,
    legs.map((l) => l.warehouseName),
    request.status,
  );
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
        {/* Shown from the moment of submission — a `pending` row is the whole point: until a
            reviewer assigns warehouses there is no "Where it went" section, so without this the
            customer's own choice is invisible to them everywhere in the portal. Omitted entirely
            when they expressed no preference, rather than rendering an empty dash. */}
        {outcome && (
          <DetailRow
            label="Preferred warehouse"
            value={request.preferredWarehouseName}
            hint={PREFERENCE_HINT[outcome]}
          />
        )}
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
  // LOAD ERRORS ONLY. The submission confirmation used to live here too, and that dual purpose was
  // the bug: an inline Notice has no timer and no dismiss, so "Request submitted for X" sat above
  // the table for the rest of the visit — still there after the customer searched for something
  // else, changed the filter, or paged on. A receipt is a moment, not a state; it is a toast now.
  const [msg, setMsg] = React.useState<Msg>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const { pushToast } = useDashboard();
  // Still separate from `msg`: a load error HIDES the table, an export failure must not — the list
  // on screen is fine and replacing it with an error would be a lie about the data.
  //
  // Stored WITH the filters it was produced under. "Export truncated — narrow the filters and try
  // again" is advice about those filters, so once they change it is not merely stale, it is wrong:
  // it went on telling the customer to narrow the filters after they already had. Kept as data and
  // resolved during render (below) rather than cleared by an effect — this project's lint enforces
  // React-Compiler rules, which forbid setState inside an effect.
  const [exportMsg, setExportMsg] = React.useState<{ msg: Msg; filters: string } | null>(null);
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
          // A successful load clears the previous failure, full stop. This used to have to spare a
          // success message that also lived in `msg` — which is what let the confirmation survive
          // every later refetch too. With the receipt moved to a toast there is nothing to spare.
          setMsg(null);
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
    // A toast, like every other write confirmation in the app (CustomerForm, StockEntryDetail and
    // ~20 more): it auto-dismisses after 4s and de-duplicates repeats, so submitting twice in a row
    // doesn't stack. The row itself appears in the table below a moment later — that is the durable
    // record, and it is why the receipt does not need to persist.
    pushToast(`Request submitted for "${request.name}" — your account team will review it.`);
    // Jump back to page 1 (newest first) so the new submission is visible. If a filter/page was
    // active, resetting the URL already re-runs the fetch effect; only when we're ALREADY at the
    // default view (nothing to reset) do we need to nudge refreshKey — avoids a double fetch.
    if (status || page > 1) patchParams({ page: null, status: null });
    else setRefreshKey((k) => k + 1);
  };

  const requests = paged?.requests ?? [];
  const filtered = !!status || !!search;
  // Shown only while the filters it was produced under still hold — see the state declaration.
  const visibleExportMsg = exportMsg && exportMsg.filters === exportFilterKey(search, status) ? exportMsg.msg : null;

  // Passes the CURRENT filters, not the page. A capped export is reported rather than silently
  // truncated — a short file the customer believes is complete is worse than no file.
  const onExport = async () => {
    setExporting(true);
    // Stamped at CALL time, not on resolve — these are the filters the file was produced under,
    // even if the customer changes them while it downloads.
    const filters = exportFilterKey(search, status);
    try {
      const { capped } = await customerService.exportOwnStockRequestsCsv({
        q: search || undefined,
        status: status || undefined,
      });
      setExportMsg(
        capped
          ? { msg: { type: "error", text: "Export truncated — too many rows. Narrow the filters and try again." }, filters }
          : null,
      );
    } catch (err) {
      setExportMsg({ msg: { type: "error", text: err instanceof Error ? err.message : "Could not export your submissions." }, filters });
    } finally {
      setExporting(false);
    }
  };

  if (loading && paged === null) {
    return (
      <div className="stack flex h-full flex-col">
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      </div>
    );
  }

  return (
    <div className="stack flex h-full flex-col">
      {msg && <div className="shrink-0"><Notice msg={msg} /></div>}
      {visibleExportMsg && <div className="shrink-0"><Notice msg={visibleExportMsg} /></div>}

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
        </div>

        {/* Page actions, at the right-hand end of the row the list is filtered from — NOT in the top
            bar. Up there they sat against the browser's own chrome, a screen's width from the rows
            they act on. Export is outline so Submit stays the obvious primary of the pair. */}
        <div className={`${toolbarActionsCls} sm:ml-auto`}>
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
          <button type="button" onClick={() => setRequestOpen(true)} className={toolbarPrimaryBtn}>
            <Plus className="h-3.5 w-3.5" /> Submit stock
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
          <TableCard
            headers={HEADERS}
            fill
            footer={
              <Pagination
                embedded
                page={paged?.page ?? 1}
                totalPages={paged?.totalPages ?? 1}
                total={paged?.total ?? 0}
                label="submissions"
                onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
              />
            }
          >
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
                <td className="cell-y px-4">
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
                <td className="cell-y px-4 font-bold text-[var(--ink)]">{r.quantity ?? "—"}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{fmtDate(r.createdAt)}</td>
                <td className="cell-y px-4">
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
        </>
      )}

      {requestOpen && (
        <StockRequestModal onClose={() => setRequestOpen(false)} onSubmitted={onSubmitted} />
      )}

      {selected && <SubmissionModal request={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
