"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, PackageCheck, Pencil, Search, Trash2 } from "lucide-react";

import * as grnService from "@/services/goods-in.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GRN_STATUS_LABELS, GrnStatusBadge, formatDate } from "./grnStatus";
import type { GoodsReceipt, GrnStatus } from "@/types/goods-in";

const PAGE_SIZE = 20;

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

function TableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Code</th><th className="px-4 py-3">Purchase Order</th><th className="px-4 py-3">Supplier</th>
            <th className="px-4 py-3">Warehouse</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Received</th>
            <th className="px-4 py-3">Items</th>{actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 8 : 7 }).map((__, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>))}
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
      const params = { search: debounced || undefined, status: statusFilter === "all" ? undefined : (statusFilter as GrnStatus), warehouse: warehouseId, page, pageSize: PAGE_SIZE };
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
  }, [debounced, statusFilter, page, refreshKey, warehouseId]);

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
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search GRN, PO or delivery note…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patch({ status: v === "all" ? null : v })} options={[{ value: "all", label: "All statuses" }, ...(Object.keys(GRN_STATUS_LABELS) as GrnStatus[]).map((s) => ({ value: s, label: GRN_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" />
        {/* Embedded in a warehouse, this is the Received (history) view — receiving lives in the
            sibling "Expected deliveries" worklist, so no create action here. The Global GRN page
            (not embedded) keeps its Receive delivery button. */}
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
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Code</th><th className="px-4 py-3">Purchase Order</th><th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Warehouse</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Received</th>
                  <th className="px-4 py-3">Items</th>{showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((grn) => (
                  <tr key={grn.id} onClick={() => router.push(`/dashboard/goods-in/${grn.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{grn.code}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{grn.poCode ?? "—"}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{grn.supplierName ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{grn.warehouse?.name ?? "—"}</td>
                    <td className="px-4 py-3"><GrnStatusBadge status={grn.status} /></td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(grn.receivedDate)}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{grn.items.length} line{grn.items.length === 1 ? "" : "s"} · {grn.totalAccepted} accepted</td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <RowActions grn={grn} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/goods-in/${grn.code}/edit`)} onDelete={() => setConfirm({ open: true, grn })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="shrink-0">
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="goods receipts" onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)} />
        </div>
      )}

      <ConfirmDialog open={confirm.open} title="Remove draft receipt?" message={<>This deletes draft <strong className="text-[var(--ink)]">{confirm.grn?.code}</strong>. Only drafts can be deleted.</>} confirmLabel="Remove" danger busy={deleting} onConfirm={onDelete} onClose={() => setConfirm({ open: false, grn: null })} />
    </div>
  );
}
