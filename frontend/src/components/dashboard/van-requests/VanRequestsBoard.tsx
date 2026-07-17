"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, PackagePlus, Trash2 } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockItemOption, VanStockPriority, VanStockRequest } from "@/services/vanStockRequest.service";
import { listEngineerOptions } from "@/services/warehouse.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { EmptyState, fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { VanStockStatusChip } from "@/components/dashboard/engineer/EngineerVanStock";
import { VanRequestItemsSummary, VanRequestLinesTable, VanRequestListSkeleton, VanStockItemSearch, VanStockTypeBadge, warehouseCaption } from "./vanRequestUi";
import { VanRequestDetail } from "./VanRequestDetail";
import type { Msg } from "@/components/ui/types";

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

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

// Rendered inside a warehouse-detail tab: `warehouse` narrows the queue to that warehouse (final
// warehouse = it, or pending restocks whose collection warehouse is it) and pre-fixes the walk-in.
const PAGE_SIZE = 20;

export function VanRequestsBoard({ warehouse }: { warehouse: { id: string; name: string; code: string | null } }) {
  const { pushToast } = useDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Filters/sort/page and the open request live in the URL (namespaced `v*` so they don't clash with
  // sibling tabs) — so a refresh, browser Back, or a shared link restores the exact view, matching the
  // other WarehouseDetail tabs. The search TEXT is local (for responsive typing) and its debounced
  // value is written to the URL.
  const status = searchParams.get("vStatus") ?? "";
  const type = searchParams.get("vType") ?? "";
  const priority = searchParams.get("vPriority") ?? "";
  const sort = searchParams.get("vSort") ?? "newest";
  const urlSearch = searchParams.get("vSearch") ?? "";
  const page = Math.max(1, Number(searchParams.get("vPage")) || 1);
  const openId = searchParams.get("vReq");

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
  const setOpenId = React.useCallback((id: string | null) => patch({ vReq: id }), [patch]);
  const setPage = React.useCallback((p: number) => patch({ vPage: p > 1 ? String(p) : null }), [patch]);
  // A filter/sort change also resets to page 1, so you're never stranded on a now-empty page.
  const onFilter = (key: string) => (v: string) => patch({ [key]: v || null, vPage: null });

  const [requests, setRequests] = React.useState<VanStockRequest[] | null>(null);
  const [meta, setMeta] = React.useState({ total: 0, totalPages: 1 });
  const [search, setSearch] = React.useState(urlSearch); // local input mirror (initialised from the URL)
  const [error, setError] = React.useState<string | null>(null); // load failure — distinct from an empty queue
  const [walkInOpen, setWalkInOpen] = React.useState(false);
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
      .listVanStockRequests({ status: status || undefined, type: type || undefined, priority: priority || undefined, search: urlSearch || undefined, warehouseId: warehouse.id, page, pageSize: PAGE_SIZE, sort: sort as "newest" | "oldest" })
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
  }, [status, type, priority, sort, urlSearch, page, warehouse.id, setPage]);

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
            <Select size="sm" ariaLabel="Sort order" value={sort} onChange={onFilter("vSort")} options={SORT_OPTIONS} />
          </>
        }
        actions={
          <button type="button" onClick={() => setWalkInOpen(true)} className={primaryBtn}>
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
              return (
                <li key={r.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xs transition-colors hover:border-[var(--accent)]">
                  {/* Compact row: click opens the detail drawer (approve / scan-fulfil live there); the
                      chevron toggles an inline peek at the full item list + warehouse without leaving. */}
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
                    <button type="button" onClick={() => setOpenId(r.id)} className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-xs font-bold text-[var(--accent)]">{r.code}</span>
                        <VanStockTypeBadge type={r.type} />
                        <VanStockStatusChip value={r.status} />
                        {r.stale && <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">Stale</span>}
                        {r.priority !== "normal" && (
                          <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-600">{r.priority}</span>
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--faint)]">{fmtDateTime(r.createdAt)}</span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 font-semibold text-[var(--ink)]">{r.engineerName}</span>
                        <span className="shrink-0 text-[var(--faint)]">·</span>
                        <span className="shrink-0 text-[var(--faint)]">{r.lines.length} {r.lines.length === 1 ? "item" : "items"}</span>
                        {r.lines.length > 0 && <span className="shrink-0 text-[var(--faint)]">·</span>}
                        <VanRequestItemsSummary lines={r.lines} className="min-w-0" />
                      </div>
                    </button>
                  </div>
                  {isOpen && (
                    <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 pl-9">
                      <VanRequestLinesTable lines={r.lines} variant="reviewer" />
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

      {openId && <VanRequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
      {walkInOpen && (
        <WalkInModal
          fixedWarehouse={warehouse}
          onClose={() => setWalkInOpen(false)}
          onCreated={() => { setWalkInOpen(false); pushToast("Walk-in created (pre-approved) — fulfil it by scan.", "success"); load(); }}
        />
      )}
    </div>
  );
}

// ── Walk-in modal (reviewer creates pre-approved for an engineer at the counter) ─────────────────

interface WalkInCartItem {
  irmItemId: string;
  name: string;
  code: string | null;
  qty: number;
}

function WalkInModal({ fixedWarehouse, onClose, onCreated }: { fixedWarehouse: { id: string; name: string; code: string | null }; onClose: () => void; onCreated: () => void }) {
  const [engineers, setEngineers] = React.useState<Array<{ id: string; name: string }>>([]);
  const [engineerId, setEngineerId] = React.useState("");
  const warehouseId = fixedWarehouse.id; // the tab's warehouse — a walk-in is issued HERE by definition
  const [reason, setReason] = React.useState("");
  const [priority, setPriority] = React.useState<VanStockPriority>("normal");
  const [cart, setCart] = React.useState<WalkInCartItem[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    listEngineerOptions().then((us) => setEngineers(us.map((u) => ({ id: u.id, name: u.name })))).catch(() => setEngineers([]));
  }, []);

  const excludeIds = React.useMemo(() => new Set(cart.map((c) => c.irmItemId)), [cart]);
  const addItem = (it: VanStockItemOption) =>
    setCart((c) => (c.some((x) => x.irmItemId === it.irmItemId) ? c : [...c, { irmItemId: it.irmItemId, name: it.name, code: it.code, qty: 1 }]));

  const onSubmit = async () => {
    if (!engineerId) { setMsg({ type: "error", text: "Pick the engineer receiving the stock." }); return; }
    if (!warehouseId) { setMsg({ type: "error", text: "Pick the issuing warehouse." }); return; }
    if (cart.length === 0) { setMsg({ type: "error", text: "Add at least one item." }); return; }
    if (!reason.trim()) { setMsg({ type: "error", text: "A reason is required." }); return; }
    setSubmitting(true);
    setMsg(null);
    try {
      await vanStockSvc.createVanStockWalkIn({
        engineerId,
        warehouseId,
        reason: reason.trim(),
        priority,
        lines: cart.map((c) => ({ irmItemId: c.irmItemId, itemName: c.name, qty: c.qty })),
      });
      onCreated();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not create the walk-in request." });
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <button type="button" onClick={onClose} disabled={submitting} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Cancel</button>
      <button type="button" onClick={onSubmit} disabled={submitting} className={primaryBtn}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} {submitting ? "Creating…" : "Create pre-approved"}
      </button>
    </>
  );

  return (
    <Modal open onClose={submitting ? () => {} : onClose} title="Walk-in issue" subtitle="Creates a pre-approved request for an engineer at the counter — fulfil it by scan next" footer={footer} size="lg" scrollBody>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Engineer <span className="text-[var(--neg)]">*</span></label>
            <Select ariaLabel="Engineer" value={engineerId} onChange={setEngineerId} options={[{ value: "", label: "Pick an engineer…" }, ...engineers.map((e) => ({ value: e.id, label: e.name }))]} />
          </div>
          <div>
            <label className={labelCls}>Warehouse</label>
            <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm font-semibold text-[var(--ink)]">
              {fixedWarehouse.code ? `${fixedWarehouse.name} (${fixedWarehouse.code})` : fixedWarehouse.name}
            </p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-bold text-[var(--faint)]">Items</p>
          <VanStockItemSearch excludeIds={excludeIds} onAddItem={addItem} />
          {cart.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border)]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-3 py-2">Item</th>
                    <th className="w-24 px-3 py-2">Qty</th>
                    <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((c) => (
                    <tr key={c.irmItemId} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">
                        <span className="font-semibold text-[var(--ink)]">{c.name}</span>
                        {c.code && <div className="font-mono text-[10px] text-[var(--muted)]">{c.code}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min={1} step={1} value={c.qty} aria-label={`Quantity for ${c.name}`} onChange={(e) => setCart((rows) => rows.map((x) => (x.irmItemId === c.irmItemId ? { ...x, qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : x)))} className={`${inputCls} py-1.5`} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => setCart((rows) => rows.filter((x) => x.irmItemId !== c.irmItemId))} aria-label="Remove item" className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Priority</label>
            <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority((v || "normal") as VanStockPriority)} options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }]} />
          </div>
          <div>
            <label className={labelCls}>Reason <span className="text-[var(--neg)]">*</span></label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="e.g. Engineer collected consumables at the counter." className={inputCls} />
          </div>
        </div>

        {msg && <Notice msg={msg} />}
      </div>
    </Modal>
  );
}

