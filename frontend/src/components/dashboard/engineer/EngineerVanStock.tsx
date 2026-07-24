"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, MapPin, PackagePlus, Search, Undo2 } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockRequest } from "@/services/vanStockRequest.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { EmptyState, fmtDateTime, PortalHeader } from "@/components/dashboard/portal/portalUi";
import { singlePickup, VanRequestItemsSummary, VanRequestLinesTable, VanRequestListSkeleton, VanStockAttachments, VanStockPostings, VanStockWalkInBadge, warehouseCaption } from "@/components/dashboard/van-requests/vanRequestUi";
import { WarehousePickupModal } from "./WarehousePickupModal";
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

// Mirrors the reviewer board's vocabulary so both sides name the same things the same way.
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  // Composite of approved + partially_fulfilled — the two states with stock still to pick up. Backed by
  // the repository's "collectible" shortcut; the dashboard's "Field stock to collect" card links here.
  { value: "collectible", label: "Ready to collect" },
  { value: "approved", label: "Approved" },
  { value: "partially_fulfilled", label: "Partially fulfilled" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "declined", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
];

const TYPE_OPTIONS = [
  { value: "", label: "All types" },
  { value: "restock", label: "Restock" },
  { value: "return", label: "Return" },
];

// "Requests I raised" vs "stock handed to me at the counter" — an engineer never raised a walk-in, so
// it answers a different question ("what did I ask for?" vs "what did I actually get?").
const ORIGIN_OPTIONS = [
  { value: "", label: "All origins" },
  { value: "engineer_request", label: "My requests" },
  { value: "walk_in", label: "Walk-ins" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const PAGE_SIZE = 20;

export function EngineerVanStock() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { pushToast } = useDashboard();

  // Filters/sort/page live in the URL (same as the engineer Jobs + Transfers pages), so a refresh or a
  // browser Back restores the exact view — including after opening a request and coming back.
  const status = searchParams.get("status") ?? "";
  const type = searchParams.get("type") ?? "";
  const createdVia = searchParams.get("origin") ?? "";
  const sort = searchParams.get("sort") ?? "newest";
  const urlSearch = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/engineer/van-stock?${params.toString()}`, { scroll: false });
    },
    [router],
  );
  const setPage = React.useCallback((p: number) => patchParams({ page: p > 1 ? String(p) : null }), [patchParams]);
  const onFilter = (key: string) => (v: string) => patchParams({ [key]: v || null }, true);

  const [requests, setRequests] = React.useState<VanStockRequest[] | null>(null);
  const [meta, setMeta] = React.useState({ total: 0, totalPages: 1 });
  const [search, setSearch] = React.useState(urlSearch); // local input mirror (initialised from the URL)
  const [error, setError] = React.useState<string | null>(null); // load failure — distinct from an empty list
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set()); // rows whose inline item detail is open
  const toggleExpand = React.useCallback((id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  // Cancel / cancel-remaining go through the app's ConfirmDialog (not window.confirm) for consistency.
  const [confirm, setConfirm] = React.useState<{ open: boolean; id: string | null; kind: "cancel" | "cancel-remaining" }>({ open: false, id: null, kind: "cancel" });
  // Pickup address for a NON-split request — the split case opens the same modal from the lines table.
  const [pickup, setPickup] = React.useState<VanStockRequest["lines"][number]["sourceWarehouse"]>(null);

  // Debounce the search box: 300ms after the user pauses, write the term to the URL (which drives the
  // query) and return to page 1. Skips the initial mount (search already equals the URL value).
  const firstSearchRun = React.useRef(true);
  React.useEffect(() => {
    if (firstSearchRun.current) { firstSearchRun.current = false; return; }
    const t = setTimeout(() => patchParams({ q: search.trim() || null }, true), 300);
    return () => clearTimeout(t);
  }, [search, patchParams]);

  const load = React.useCallback(() => {
    vanStockSvc
      .listMyVanStockRequests({
        status: status || undefined,
        type: type || undefined,
        createdVia: createdVia || undefined,
        search: urlSearch || undefined,
        sort: sort as "newest" | "oldest",
        page,
        pageSize: PAGE_SIZE,
      })
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
  }, [status, type, createdVia, urlSearch, sort, page, setPage]);

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

      {/* Toolbar — search + filters + sort. Same pattern (and same URL-state approach) as the engineer
          Jobs and Transfers pages; the reviewer board offers the mirror-image filters over the same
          list, so both sides can ask the same questions of it. */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:min-w-60 lg:max-w-xs lg:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, item or reason…"
            aria-label="Search your field stock requests"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select size="sm" ariaLabel="Filter by status" value={status} onChange={onFilter("status")} options={STATUS_OPTIONS} />
        <Select size="sm" ariaLabel="Filter by type" value={type} onChange={onFilter("type")} options={TYPE_OPTIONS} />
        <Select size="sm" ariaLabel="Filter by origin" value={createdVia} onChange={onFilter("origin")} options={ORIGIN_OPTIONS} />
        <Select size="sm" ariaLabel="Sort order" value={sort} onChange={onFilter("sort")} options={SORT_OPTIONS} />
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
            const caption = warehouseCaption(r, "engineer");
            const pickupWh = singlePickup(r.lines);
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
                      {/* An engineer never RAISED a walk-in — it was handed to them at the counter. Without
                          this it reads as an approved request they don't remember asking for. */}
                      <VanStockWalkInBadge createdVia={r.createdVia} />
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
                    {/* Where to collect is the engineer's ACTION, not trivia — so it outranks the reason
                        quote below it, and (once approved fixes a single source) it opens the address the
                        same way a split's per-line warehouse does. */}
                    {caption && (
                      <p className="mt-2 text-xs font-semibold text-[var(--ink)]">
                        {pickupWh ? (
                          <button type="button" onClick={() => setPickup(pickupWh)} className="inline-flex items-center gap-1 text-left text-[var(--accent)] hover:underline" title="View pickup address">
                            <MapPin className="h-3.5 w-3.5 shrink-0" />
                            {caption}
                          </button>
                        ) : (
                          caption
                        )}
                      </p>
                    )}
                    {r.reason && <p className="mt-0.5 text-[11px] italic text-[var(--faint)]">“{r.reason}”</p>}
                    {r.status === "declined" && r.decisionNote && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Declined: {r.decisionNote}</p>}
                    {r.completionType === "closed_short" && r.closeShortNote && <p className="mt-0.5 text-[11px] text-[var(--muted)]">Closed short: {r.closeShortNote}</p>}
                    {/* Photos the engineer attached when raising it — they uploaded these, so they should
                        be able to check what the warehouse is looking at. Thumbnails, not bare "#1" links. */}
                    <VanStockAttachments urls={r.attachments} className="mt-2" />
                    {/* What actually moved. On a RETURN this is the only place the engineer can see a
                        damaged split — the warehouse can take 5 back as "3 good + 2 damaged", and without
                        this their van balance simply drops with no record of why. */}
                    {r.fulfilments.length > 0 && (
                      <div className="mt-2.5">
                        <VanStockPostings fulfilments={r.fulfilments} type={r.type} />
                      </div>
                    )}
                    {/* No "Approved — collect from X" line: the APPROVED chip already says approved, and
                        the caption above already names where to collect — "Fulfilled from: London (WH-0005)"
                        on a single source, "Fulfilled from 2 warehouses" on a split (where the table's
                        Collect From column carries the per-line detail). It said the same thing twice on a
                        single source, and on a split it said the WRONG thing — naming the primary while
                        lines shipped from elsewhere. */}
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

      {pickup && <WarehousePickupModal wh={pickup} onClose={() => setPickup(null)} />}

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
