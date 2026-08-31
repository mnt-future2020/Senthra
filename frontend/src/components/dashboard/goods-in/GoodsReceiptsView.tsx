"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, PackageCheck, Pencil, Rows3, Search, Trash2 } from "lucide-react";

import * as grnService from "@/services/goods-in.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";
import { listSuppliers } from "@/services/supplier.service";
import { listWarehouses } from "@/services/warehouse.service";
import { CELL_ONE_LINE, colClass, colClassAt, tableMinWidth, type ColPriority } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AttentionBar } from "@/components/dashboard/shell/AttentionBar";
import { GRN_STATUS_LABELS, GrnStatusBadge, formatDate } from "./grnStatus";
import { lineSummary } from "./acceptedWording";
import type { GoodsReceipt, GrnStatus } from "@/types/goods-in";

const PAGE_SIZE = 20;

// Code · Purchase Order · Supplier · Warehouse · Status · Received · Items · actions.
// Supplier and warehouse names are the long values here, and `min-w-[900px]` across eight columns
// left them ~112px each. Received and Items step aside on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "normal", "wide", "wide", "narrow", "normal", "normal", "narrow"]);

function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ElementType; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${danger ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

function RowActions({ grn, canEdit, canDelete, onEdit, onDelete }: { grn: GoodsReceipt; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPos(spaceBelow < 140 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
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

  if (grn.status !== "draft" || (!canEdit && !canDelete)) return null;
  return (
    <div className="flex justify-end">
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (open) close(); else openMenu(); }} className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" aria-label="Actions" aria-haspopup="menu" aria-expanded={open}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[55]" onClick={close} />
          <div ref={menuRef} role="menu" className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
            {canEdit && <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>Edit draft</MenuItem>}
            {canDelete && <MenuItem icon={Trash2} danger onClick={() => { close(); onDelete(); }}>Delete draft</MenuItem>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// One array drives BOTH rows below, which is the rule colClass exists to enforce: a placeholder cell
// that stays visible while its header is hidden shifts every cell after it.
const SKELETON_COLS: ColPriority[] = ["always", "always", "always", "always", "always", "lg", "xl"];

function TableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th><th className="cell-y px-4">Purchase Order</th><th className="cell-y px-4">Supplier</th>
            <th className="cell-y px-4">Warehouse</th><th className="cell-y px-4">Status</th><th className={`cell-y px-4 ${colClass("lg")}`}>Received</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Items</th>{actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 8 : 7 }).map((__, j) => (<td key={j} className={`cell-y px-4 ${colClassAt(SKELETON_COLS, j)}`}><Skeleton className="h-3 w-20" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `warehouseId` locks the list to one warehouse and `embedded` tightens the layout and hides the
// Receive delivery button — both used when this renders inside the Warehouse detail "Incoming
// stock" Company (GRN) pane.
// No props = the global GRN page. Either way the view fills its (bounded) parent and only the
// table body scrolls, with a sticky header row. Mirrors InventoryView's embedded contract.
export function GoodsReceiptsView({ warehouseId, warehouseCode, embedded }: { warehouseId?: string; warehouseCode?: string; embedded?: boolean } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from URL — survive a browser refresh.
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | GrnStatus;
  // `receivedDate` is a CALENDAR DAY (the form sends "YYYY-MM-DD"), so no timezone applies to it.
  const receivedFrom = searchParams.get("receivedFrom") ?? "";
  const receivedTo = searchParams.get("receivedTo") ?? "";
  // Only offered on the GLOBAL register — inside a warehouse page the scope is already the warehouse.
  const supplierFilter = searchParams.get("supplier") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local input state for debounced search; seeded from URL.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [debounced, setDebounced] = React.useState(search);
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Writer — preserves ALL existing params (including ?tab for panel-embedded views).
  const patch = React.useCallback(
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
  const [data, setData] = React.useState(() => grnService.getCachedGoodsReceipts({ warehouse: warehouseId, pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; grn: GoodsReceipt | null }>({ open: false, grn: null });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("goods_in.edit");
  const canDelete = can("goods_in.delete");
  const showActions = canEdit || canDelete;
  // When embedded in a warehouse, carry that warehouse into the New receipt form so its PO list is
  // scoped to this warehouse (the global GRN page passes no warehouse → all POs), AND a returnTo so
  // the form's Back returns to this warehouse's Incoming-stock tab rather than the global GRN list.
  const newReceiptHref = warehouseId
    ? `/dashboard/goods-in/new?warehouse=${warehouseId}${warehouseCode ? `&returnTo=${encodeURIComponent(`/dashboard/warehouses/${warehouseCode}?tab=incoming`)}` : ""}`
    : "/dashboard/goods-in/new";

  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.
  // Option lists for the folded filters — both degrade to empty, rendering as "All …".
  const [supplierOptions, setSupplierOptions] = React.useState<{ value: string; label: string }[]>([]);
  const [warehouseOptions, setWarehouseOptions] = React.useState<{ value: string; label: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    void Promise.all([
      listSuppliers({ status: "active", pageSize: 200 })
        .then((r) => r.suppliers.map((s) => ({ value: s.id, label: s.name })))
        .catch(() => []),
      warehouseId
        ? Promise.resolve([])
        : listWarehouses({ status: "active", pageSize: 200 })
            .then((r) => r.warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })))
            .catch(() => []),
    ]).then(([sup, wh]) => {
      if (!alive) return;
      setSupplierOptions(sup);
      setWarehouseOptions(wh);
    });
    return () => { alive = false; };
  }, [warehouseId]);

  const exportParams = React.useMemo(
    () => ({
      search: debounced || undefined,
      status: statusFilter === "all" ? undefined : (statusFilter as GrnStatus),
      // The warehouse PROP wins: inside a warehouse page this list is that warehouse's register and
      // the picker is not offered at all, so a query param must not be able to widen it.
      warehouse: warehouseId ?? (warehouseFilter || undefined),
      supplier: supplierFilter || undefined,
      receivedFrom: receivedFrom || undefined,
      receivedTo: receivedTo || undefined,
    }),
    [debounced, statusFilter, warehouseId, warehouseFilter, supplierFilter, receivedFrom, receivedTo],
  );

  React.useEffect(() => {
    const t = setTimeout(() => {
      // Guard against firing on mount / back-forward nav: only patch when the box actually diverges
      // from the URL, so a deep-linked ?page (patch defaults resetPage=true → deletes it) is preserved.
      if (searchInput.trim() !== search) {
        setDebounced(searchInput.trim());
        patch({ q: searchInput.trim() || null });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
      const cached = grnService.getCachedGoodsReceipts(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await grnService.listGoodsReceipts(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load goods receipts.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [exportParams, page, refreshKey]);

  const rows = data?.goodsReceipts ?? [];
  const showSkeleton = loading && rows.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(debounced);

  const onDelete = async () => {
    if (!confirm.grn) return;
    setDeleting(true);
    try {
      await grnService.deleteGoodsReceipt(confirm.grn.id);
      setConfirm({ open: false, grn: null });
      pushToast("Draft goods receipt removed.", "success");
      if (rows.length === 1 && page > 1) patch({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`flex h-full flex-col ${embedded ? "gap-4" : "gap-5"}`}>
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search GRN, PO or delivery note…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patch({ status: v === "all" ? null : v })} options={[{ value: "all", label: "All statuses" }, ...(Object.keys(GRN_STATUS_LABELS) as GrnStatus[]).map((s) => ({ value: s, label: GRN_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" />
        <FilterPopover
          activeCount={(warehouseId ? 0 : (warehouseFilter ? 1 : 0)) + (supplierFilter ? 1 : 0) + (receivedFrom || receivedTo ? 1 : 0)}
          onClear={() => patch({ warehouse: null, supplier: null, receivedFrom: null, receivedTo: null })}
        >
          {/* No warehouse picker inside a warehouse page: the list IS that warehouse's register, and
              offering a control that could only ever contradict the page is worse than none. */}
          {!warehouseId && (
            <Select
              size="sm"
              value={warehouseFilter}
              onChange={(v) => patch({ warehouse: v || null })}
              options={[{ value: "", label: "All warehouses" }, ...warehouseOptions]}
              ariaLabel="Filter by warehouse"
            />
          )}
          <Select
            size="sm"
            value={supplierFilter}
            onChange={(v) => patch({ supplier: v || null })}
            options={[{ value: "", label: "All suppliers" }, ...supplierOptions]}
            ariaLabel="Filter by supplier"
          />
          {/* WHEN THE GOODS ARRIVED — the register's own axis, and the one it is reconciled along. */}
          <DateRangeFilter
            label="Received"
            showLabel
            from={receivedFrom}
            to={receivedTo}
            onChange={({ from, to }) => patch({ receivedFrom: from || null, receivedTo: to || null })}
          />
        </FilterPopover>
        {/* The two receiving queues, selected by KEY rather than by nav row — they badge different
            rows (drafts roll up to Warehouses, since GRN has no nav row of its own;
            deliveries-to-receive badges Purchase Orders, because that is the list it opens) and the
            other warehouse queues belong to other screens entirely. Draft receipts are stock that has
            physically arrived but hasn't posted; deliveries-to-receive is what should become a GRN
            next. Both deep-link to a filtered list, so both stay clickable.
            In the toolbar row rather than a block above it: two chips beside one Select leave the row
            far from full, so they cost no vertical space at all here. Hidden when embedded in a
            warehouse detail, which supplies its own context. */}
        {!embedded && <AttentionBar keys={["wh.grn_drafts", "wh.goods_in_waiting"]} className="flex flex-wrap items-center gap-1.5" />}
        {/* Embedded in a warehouse, this is the Received (history) view — receiving lives in the
            sibling "Expected deliveries" worklist, so no create action here. The Global GRN page
            (not embedded) keeps its Receive delivery button. */}
        {/* Hidden when embedded (the supplier tab renders its own header), and placed before the
            primary action so "New receipt" stays hard right. */}
        {!embedded && can("goods_in.export") && (
          <>
            <ExportButton
              label="Export"
              onExport={() => grnService.exportGoodsReceiptsCsv(exportParams)}
              disabled={rows.length === 0}
              title="Export the filtered goods receipts — one row per receipt"
            />
            {/* The supplier-quality report: one row per LINE, so "which supplier keeps sending
                damaged CAT6" becomes a pivot rather than a manual trawl. */}
            <ExportButton
              label="Export lines"
              icon={Rows3}
              onExport={() => grnService.exportGoodsReceiptLinesCsv(exportParams)}
              disabled={rows.length === 0}
              title="Export every receipt LINE — ordered, received, accepted and damaged per item"
            />
          </>
        )}
        {!embedded && can("goods_in.create") && (
          <button onClick={() => router.push(newReceiptHref)} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto">
            <PackageCheck className="h-4 w-4" /> Receive delivery
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <TableSkeleton actions={showActions} />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <PackageCheck className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No goods receipts match" : "No goods receipts yet"}</p>
            {!embedded && !isFiltered && can("goods_in.create") && (
              <button onClick={() => router.push(newReceiptHref)} className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">Receive your first delivery</button>
            )}
          </div>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`}>
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th><th className="cell-y px-4">Purchase Order</th><th className="cell-y px-4">Supplier</th>
                  <th className="cell-y px-4">Warehouse</th><th className="cell-y px-4">Status</th><th className={`cell-y px-4 ${colClass("lg")}`}>Received</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Items</th>{showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((grn) => (
                  <tr key={grn.id} onClick={() => router.push(`/dashboard/goods-in/${grn.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{grn.code}</td>
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{grn.poCode ?? "—"}</td>
                    <td className={`cell-y px-4 font-semibold text-[var(--ink)] ${CELL_ONE_LINE}`} title={grn.supplierName ?? undefined}>{grn.supplierName ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={grn.warehouse?.name ?? undefined}>{grn.warehouse?.name ?? "—"}</td>
                    <td className="cell-y px-4"><GrnStatusBadge status={grn.status} /></td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{formatDate(grn.receivedDate)}</td>
                    {/* "N accepted" is only true once the receipt is completed — on a draft nothing
                        has posted, and on a cancelled one nothing ever will. See acceptedWording.ts. */}
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")}`}>{lineSummary(grn.items.length, grn.totalAccepted, grn.status)}</td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <RowActions grn={grn} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/goods-in/${grn.code}/edit`)} onDelete={() => setConfirm({ open: true, grn })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
            <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="goods receipts" onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)} />
        )}
      </div>

      <ConfirmDialog open={confirm.open} title="Remove draft receipt?" message={<>This deletes draft <strong className="text-[var(--ink)]">{confirm.grn?.code}</strong>. Only drafts can be deleted.</>} confirmLabel="Remove" danger busy={deleting} onConfirm={onDelete} onClose={() => setConfirm({ open: false, grn: null })} />
    </div>
  );
}
