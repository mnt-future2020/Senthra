"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";

import * as prfService from "@/services/purchase-request.service";
import { listSuppliers } from "@/services/supplier.service";
import { listWarehouses } from "@/services/warehouse.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { usePurchaseRequestSocket } from "@/hooks/usePurchaseRequestSocket";
import { useReferenceData } from "@/hooks/useReferenceData";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { CELL_ONE_LINE, colClass, colClassAt, tableMinWidth, type ColPriority } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AttentionBar } from "@/components/dashboard/shell/AttentionBar";
import { PRF_DERIVED_STATUS_OPTIONS, PRF_STATUS_LABELS, PrfStatusBadge, formatDate, formatMoney } from "./prfStatus";
import type { PrfStatus, PurchaseRequest } from "@/types/purchase-request";
import type { Supplier } from "@/types/supplier";
import type { Warehouse } from "@/types/warehouse";

const PAGE_SIZE = 20;

// Code · Supplier · Warehouse · Status · Quote Ref · Valid Until · Grand Total · actions.
// Same flat-minimum problem as Purchase Orders: supplier and warehouse names are the long values and
// they were the ones being squeezed. Quote Ref and Valid Until step aside on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "wide", "narrow", "normal", "normal", "normal", "narrow"]);

function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ElementType; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${danger ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

function PrfRowActions({ prf, canEdit, canDelete, onEdit, onDelete }: { prf: PurchaseRequest; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPos(spaceBelow < 160 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
    setOpen(true);
  };
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Edit + delete only apply to drafts.
  const draft = prf.status === "draft";
  if (!draft || (!canEdit && !canDelete)) return null;

  return (
    <div className="flex justify-end">
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={close} />
            <div ref={menuRef} role="menu" aria-label="Purchase request actions" className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
              {canEdit && (
                <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                  Edit draft
                </MenuItem>
              )}
              {canDelete && (
                <MenuItem icon={Trash2} danger onClick={() => { close(); onDelete(); }}>
                  Delete draft
                </MenuItem>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

// One array drives BOTH rows below, which is the rule colClass exists to enforce: a placeholder cell
// that stays visible while its header is hidden shifts every cell after it.
const SKELETON_COLS: ColPriority[] = ["always", "always", "always", "always", "xl", "lg", "always"];

function PrfTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Supplier</th>
            <th className="cell-y px-4">Warehouse</th>
            <th className="cell-y px-4">Status</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Quote Ref</th>
            <th className={`cell-y px-4 ${colClass("lg")}`}>Valid Until</th>
            <th className="cell-y px-4">Grand Total</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 8 : 7 }).map((__, j) => (
                <td key={j} className={`cell-y px-4 ${colClassAt(SKELETON_COLS, j)}`}><Skeleton className="h-3 w-20" /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseRequestsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Derive filter state from URL params
  // "rework" is a DERIVED pseudo-status the server resolves from reworkPrfWhere — the same predicate
  // the "Rejected — needs rework" badge counts, so the badge and this list are one set of rows.
  const statusFilter = (searchParams.get("status") as "all" | "rework" | PrfStatus) ?? "all";
  const supplierFilter = searchParams.get("supplier") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
  const search = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local search input state seeded from URL; debounce-writes to ?q
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => prfService.getCachedPurchaseRequests({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; prf: PurchaseRequest | null }>({ open: false, prf: null });
  const [deleting, setDeleting] = React.useState(false);

  // Filter dropdown sources.
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  useReferenceData([
    { label: "suppliers", load: () => listSuppliers({ pageSize: 100 }), onData: (r) => setSuppliers(r.suppliers) },
    { label: "warehouses", load: () => listWarehouses({ pageSize: 100 }), onData: (r) => setWarehouses(r.warehouses) },
  ]);

  const canEdit = can("purchase_requests.edit");
  const canDelete = can("purchase_requests.delete");
  const showActions = canEdit || canDelete;

  // Patch URL params, preserving any other params on the page; resetPage drops ?page
  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Debounce the search input into ?q
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.
  const exportParams = React.useMemo(
    () => ({
      search: search || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      supplier: supplierFilter || undefined,
      warehouse: warehouseFilter || undefined,
    }),
    [search, statusFilter, supplierFilter, warehouseFilter],
  );

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
      const cached = prfService.getCachedPurchaseRequests(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await prfService.listPurchaseRequests(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load purchase requests.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [exportParams, page, refreshKey]);

  // Live-refresh the list whenever anyone moves a request through the flow, so a board left open
  // shows current statuses (and the finance review queue drains as decisions are made) without a
  // manual reload. The cached read above is only an instant placeholder — the refetch this triggers
  // always goes to the network, so the row that changed is real data, not the stale cache.
  usePurchaseRequestSocket(React.useCallback(() => setRefreshKey((k) => k + 1), []));

  const requests = data?.purchaseRequests ?? [];
  const showSkeleton = loading && requests.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search) || Boolean(supplierFilter) || Boolean(warehouseFilter);

  const onDelete = async () => {
    if (!confirm.prf) return;
    setDeleting(true);
    try {
      await prfService.deletePurchaseRequest(confirm.prf.id);
      setConfirm({ open: false, prf: null });
      pushToast("Draft purchase request removed.", "success");
      if (requests.length === 1 && page > 1) patchParams({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      {/* Breakdown of the sidebar's Purchase Requests badge — what is waiting on approval, on a
          Generate-PO, or on rework after a rejection. Inside the toolbar card rather than a block of
          its own above it: these chips narrow this list exactly as the controls below do, and as a
          separate block they paid the layout's 20px flex gap on top of their own height. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        <AttentionBar
          nav="/dashboard/purchase-requests"
          className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] pb-3"
        />
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code, supplier or quote ref…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patchParams({ status: v === "all" ? null : v }, true)} options={[{ value: "all", label: "All statuses" }, ...PRF_DERIVED_STATUS_OPTIONS, ...(Object.keys(PRF_STATUS_LABELS) as PrfStatus[]).map((s) => ({ value: s, label: PRF_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" />
        <Select size="sm" value={supplierFilter || "all"} onChange={(v) => patchParams({ supplier: v === "all" ? null : v }, true)} options={[{ value: "all", label: "All suppliers" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]} ariaLabel="Filter by supplier" />
        <Select size="sm" value={warehouseFilter || "all"} onChange={(v) => patchParams({ warehouse: v === "all" ? null : v }, true)} options={[{ value: "all", label: "All warehouses" }, ...warehouses.map((w) => ({ value: w.id, label: w.name }))]} ariaLabel="Filter by warehouse" />
        {/* Before "New request" and outside its ml-auto, so the primary action stays hard right. */}
        {can("purchase_requests.export") && (
          <>
            <ExportButton
              label="Export"
              onExport={() => prfService.exportPurchaseRequestsCsv(exportParams)}
              disabled={requests.length === 0}
              title="Export the filtered purchase requests — one row per request"
            />
            {/* One row per LINE, carrying the PO code — this file joins the PO line export to
                compare what was requested against what was ordered. */}
            <ExportButton
              label="Export lines"
              onExport={() => prfService.exportPurchaseRequestLinesCsv(exportParams)}
              disabled={requests.length === 0}
              title="Export every request LINE — item, quantity, unit price"
            />
          </>
        )}
        {can("purchase_requests.create") && (
          <button onClick={() => router.push("/dashboard/purchase-requests/new")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 lg:ml-auto">
            <Plus className="h-4 w-4" /> New request
          </button>
        )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <PrfTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <FileText className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No purchase requests match" : "No purchase requests yet"}</p>
            {!isFiltered && can("purchase_requests.create") && (
              <button onClick={() => router.push("/dashboard/purchase-requests/new")} className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">
                Raise your first request
              </button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th>
                  <th className="cell-y px-4">Supplier</th>
                  <th className="cell-y px-4">Warehouse</th>
                  <th className="cell-y px-4">Status</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Quote Ref</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Valid Until</th>
                  <th className="cell-y px-4">Grand Total</th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {requests.map((prf) => (
                  <tr key={prf.id} onClick={() => router.push(`/dashboard/purchase-requests/${prf.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{prf.code}</td>
                    <td className={`cell-y px-4 font-semibold text-[var(--ink)] ${CELL_ONE_LINE}`} title={prf.supplierName ?? prf.supplier?.name ?? undefined}>{prf.supplierName ?? prf.supplier?.name ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={prf.warehouse?.name ?? undefined}>{prf.warehouse?.name ?? "—"}</td>
                    <td className="cell-y px-4"><PrfStatusBadge status={prf.status} /></td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")}`}>{prf.quoteReference ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{formatDate(prf.quoteValidUntil)}</td>
                    <td className="cell-y px-4 font-semibold text-[var(--ink)]">{formatMoney(prf.grandTotal, prf.currency)}</td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <PrfRowActions prf={prf} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/purchase-requests/${prf.code}/edit`)} onDelete={() => setConfirm({ open: true, prf })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
            <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="purchase requests" onPage={(p) => patchParams({ page: p > 1 ? String(p) : null }, false)} />
        )}
      </div>

      <ConfirmDialog
        open={confirm.open}
        title="Remove draft request?"
        message={<>This deletes draft <strong className="text-[var(--ink)]">{confirm.prf?.code}</strong>. Only drafts can be deleted.</>}
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, prf: null })}
      />
    </div>
  );
}
