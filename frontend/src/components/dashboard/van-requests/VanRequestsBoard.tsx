"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, PackagePlus } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockRequest } from "@/services/vanStockRequest.service";
import { subscribe } from "@/lib/socket";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { primaryBtn } from "@/components/ui/styles";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { EmptyState, fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { VanRequestItemsSummary, VanRequestLinesTable, VanRequestListSkeleton, VanStockCompletionBadge, VanStockTypeBadge, VanStockWalkInBadge, linesForWarehouse, warehouseCaption, warehouseStatus } from "./vanRequestUi";

// Warehouse-side board for NON-job van stock requests: review pending restocks (approve with trims /
// decline), receive returns and fulfil approved restocks by scan, close short, and raise walk-ins.

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
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

const PRIORITY_FILTER_OPTIONS = [
  { value: "", label: "All priorities" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

// A walk-in is pre-approved at the counter, never reviewed — so "what did we actually review?" and
// "what went out over the counter?" are different questions the reviewer needs to ask separately.
const ORIGIN_OPTIONS = [
  { value: "", label: "All origins" },
  { value: "engineer_request", label: "Engineer requests" },
  { value: "walk_in", label: "Walk-ins" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

// Rendered inside a warehouse-detail tab: `warehouse` narrows the queue to that warehouse (final
// warehouse = it, or pending restocks whose collection warehouse is it). Opening a request or the
// walk-in composer is the workspace's job (both swap this board out) — hence onOpen / onWalkIn.
const PAGE_SIZE = 20;

export function VanRequestsBoard({
  warehouse,
  onOpen,
  onWalkIn,
}: {
  warehouse: { id: string; name: string; code: string | null };
  onOpen: (code: string) => void;
  onWalkIn: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Filters/sort/page live in the URL (namespaced `v*` so they don't clash with sibling tabs) — so a
  // refresh, browser Back, or a shared link restores the exact view, matching the other WarehouseDetail
  // tabs. The search TEXT is local (for responsive typing) and its debounced value is written to the
  // URL. Which request is OPEN is also URL state, but it belongs to VanRequestsWorkspace (`vRequest`),
  // which swaps this whole board out for the detail — the queue never renders both.
  const status = searchParams.get("vStatus") ?? "";
  const type = searchParams.get("vType") ?? "";
  const priority = searchParams.get("vPriority") ?? "";
  const createdVia = searchParams.get("vOrigin") ?? "";
  const sort = searchParams.get("vSort") ?? "newest";
  const urlSearch = searchParams.get("vSearch") ?? "";
  const page = Math.max(1, Number(searchParams.get("vPage")) || 1);

  const patch = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );
  const setPage = React.useCallback((p: number) => patch({ vPage: p > 1 ? String(p) : null }), [patch]);
  // A filter/sort change also resets to page 1, so you're never stranded on a now-empty page.
  const onFilter = (key: string) => (v: string) => patch({ [key]: v || null, vPage: null });

  const [requests, setRequests] = React.useState<VanStockRequest[] | null>(null);
  const [meta, setMeta] = React.useState({ total: 0, totalPages: 1 });
  const [search, setSearch] = React.useState(urlSearch); // local input mirror (initialised from the URL)
  const [error, setError] = React.useState<string | null>(null); // load failure — distinct from an empty queue
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set()); // rows whose inline item detail is open
  const toggleExpand = React.useCallback((id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  // Debounce the search box: 300ms after the user pauses, write the term to the URL (which drives the
  // query) and return to page 1. Skips the initial mount (search already equals the URL value).
  const firstSearchRun = React.useRef(true);
  React.useEffect(() => {
    if (firstSearchRun.current) { firstSearchRun.current = false; return; }
    const t = setTimeout(() => patch({ vSearch: search.trim() || null, vPage: null }), 300);
    return () => clearTimeout(t);
  }, [search, patch]);

  const load = React.useCallback(() => {
    vanStockSvc
      .listVanStockRequests({ status: status || undefined, type: type || undefined, priority: priority || undefined, createdVia: createdVia || undefined, search: urlSearch || undefined, warehouseId: warehouse.id, page, pageSize: PAGE_SIZE, sort: sort as "newest" | "oldest" })
      .then((r) => {
        // A filter change resets to page 1, but a DATA change (another reviewer fulfils the last
        // pending request on this page) doesn't — totalPages drops below `page`, the server returns
        // nothing, and the empty state renders with the pager hidden, stranding the reviewer. Step the
        // URL's page back to the last real one so the refetch lands on a page that exists. Guarded on
        // `total > 0` so a genuinely empty queue still shows its empty state.
        if (page > r.totalPages && r.total > 0) { setPage(r.totalPages); return; }
        setRequests(r.requests);
        setMeta({ total: r.total, totalPages: r.totalPages });
        setError(null);
      })
      .catch((err) => { setRequests([]); setMeta({ total: 0, totalPages: 1 }); setError(err instanceof Error ? err.message : "Could not load the queue."); });
  }, [status, type, priority, createdVia, sort, urlSearch, page, warehouse.id, setPage]);

  React.useEffect(() => load(), [load]);
  React.useEffect(() => subscribe(["van_stock_request:updated"], load), [load]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Operational workspace tab: no title (the Warehouse header owns the identity) — starts directly
          with search + filters + the Walk-in action. Only the list below scrolls. */}
      <WorkspaceToolbar
        search={{ value: search, onChange: setSearch, placeholder: "Search code / engineer / reason…", ariaLabel: "Search van requests" }}
        filters={
          <>
            <Select size="sm" ariaLabel="Filter by status" value={status} onChange={onFilter("vStatus")} options={STATUS_OPTIONS} />
            <Select size="sm" ariaLabel="Filter by type" value={type} onChange={onFilter("vType")} options={TYPE_OPTIONS} />
            <Select size="sm" ariaLabel="Filter by priority" value={priority} onChange={onFilter("vPriority")} options={PRIORITY_FILTER_OPTIONS} />
            <Select size="sm" ariaLabel="Filter by origin" value={createdVia} onChange={onFilter("vOrigin")} options={ORIGIN_OPTIONS} />
            <Select size="sm" ariaLabel="Sort order" value={sort} onChange={onFilter("vSort")} options={SORT_OPTIONS} />
          </>
        }
        actions={
          <button type="button" onClick={onWalkIn} className={primaryBtn}>
            <PackagePlus className="h-3.5 w-3.5" /> Walk-in issue
          </button>
        }
      />

      {/* Scrolling list body — only this region scrolls; the control row stays pinned above. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {requests === null ? (
          <VanRequestListSkeleton />
        ) : error ? (
          <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : requests.length === 0 ? (
          <EmptyState icon={PackagePlus} title="No field stock requests" hint="Engineer restock and return requests owned by this warehouse will appear here." />
        ) : (
          <ul className="space-y-1.5">
            {requests.map((r) => {
              const isOpen = expanded.has(r.id);
              const caption = warehouseCaption(r);
              // Everything in this row is scoped to THIS warehouse: its own lines, and a status that
              // describes ITS work. The global status said "Approved" the moment any other warehouse
              // approved, so a manager scrolled past requests still waiting on them — and "Partially
              // fulfilled" appeared because someone else had issued their part.
              const myLines = linesForWarehouse(r.lines, warehouse.id);
              const otherCount = r.lines.length - myLines.length;
              const myStatus = warehouseStatus(r, warehouse.id);
              return (
                <li key={r.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xs transition-colors hover:border-[var(--accent)]">
                  {/* Compact row: click opens the request's review workspace (approve / scan-fulfil live
                      there, in place of this queue); the chevron toggles an inline peek at the full item
                      list + warehouse without leaving. */}
                  <div className="flex items-start gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}
                      className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                      aria-label={isOpen ? "Hide details" : "Show details"}
                      aria-expanded={isOpen}
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    <button type="button" onClick={() => onOpen(r.code)} className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-xs font-bold text-[var(--accent)]">{r.code}</span>
                        <VanStockTypeBadge type={r.type} />
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${myStatus.cls}`}>{myStatus.label}</span>
                        {/* Qualifies the status beside it: a walk-in's "Approved" was never reviewed —
                            without this the queue reads as though someone here approved it. */}
                        <VanStockWalkInBadge createdVia={r.createdVia} />
                        <VanStockCompletionBadge completionType={r.completionType} lines={r.lines} />
                        {r.stale && <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">Stale</span>}
                        {r.priority !== "normal" && (
                          <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-600">{r.priority}</span>
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--faint)]">{fmtDateTime(r.createdAt)}</span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 font-semibold text-[var(--ink)]">{r.engineerName}</span>
                        <span className="shrink-0 text-[var(--faint)]">·</span>
                        <span className="shrink-0 text-[var(--faint)]">{myLines.length} {myLines.length === 1 ? "item" : "items"}</span>
                        {myLines.length > 0 && <span className="shrink-0 text-[var(--faint)]">·</span>}
                        <VanRequestItemsSummary lines={myLines} className="min-w-0" />
                      </div>
                    </button>
                  </div>
                  {isOpen && (
                    <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 pl-9">
                      <VanRequestLinesTable lines={myLines} variant="reviewer" />
                      {/* The rest of the request still exists — say so without listing stock this
                          warehouse can neither issue nor decide on. */}
                      {otherCount > 0 && (
                        <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                          {otherCount} more {otherCount === 1 ? "item is" : "items are"} handled by another warehouse.
                        </p>
                      )}
                      {caption && <p className="mt-1.5 text-[11px] text-[var(--faint)]">{caption}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Pinned footer pagination — stays visible while the list scrolls above it. */}
      {requests !== null && requests.length > 0 && (
        <div className="shrink-0">
          <Pagination page={Math.min(page, meta.totalPages)} totalPages={meta.totalPages} total={meta.total} label="requests" onPage={setPage} />
        </div>
      )}

    </div>
  );
}
