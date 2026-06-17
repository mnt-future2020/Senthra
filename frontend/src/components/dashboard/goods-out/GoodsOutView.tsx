"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MoreHorizontal, PackageMinus, Pencil, Plus, Search, Trash2 } from "lucide-react";

import * as goodsOutService from "@/services/goods-out.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listManagerOptions } from "@/services/warehouse.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GOODS_OUT_STATUS_LABELS, GoodsOutStatusBadge, formatDate } from "./goodsOutStatus";
import type { GoodsOut, GoodsOutStatus } from "@/types/goods-out";

const PAGE_SIZE = 20;
const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]";

function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ElementType; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${danger ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

function RowActions({ gdn, canEdit, canDelete, onEdit, onDelete }: { gdn: GoodsOut; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
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

  if (gdn.status !== "draft" || (!canEdit && !canDelete)) return null;
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
            <th className="px-4 py-3">Code</th><th className="px-4 py-3">Warehouse</th><th className="px-4 py-3">Engineer</th>
            <th className="px-4 py-3">Status</th><th className="px-4 py-3">Dispatch date</th><th className="px-4 py-3">Items</th>{actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 7 : 6 }).map((__, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GoodsOutView() {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | GoodsOutStatus>("all");
  const [warehouse, setWarehouse] = React.useState("");
  const [engineer, setEngineer] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => goodsOutService.getCachedGoodsOut({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; gdn: GoodsOut | null }>({ open: false, gdn: null });
  const [deleting, setDeleting] = React.useState(false);
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [engineers, setEngineers] = React.useState<{ id: string; name: string }[]>([]);

  const canEdit = can("goods_out.edit");
  const canDelete = can("goods_out.delete");
  const showActions = canEdit || canDelete;

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    let active = true;
    listWarehouses({ status: "active", pageSize: 100 }).then((r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))), () => {});
    listManagerOptions().then((us) => active && setEngineers(us.map((u) => ({ id: u.id, name: u.name }))), () => {});
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { search: debounced || undefined, status: statusFilter === "all" ? undefined : statusFilter, warehouse: warehouse || undefined, engineer: engineer || undefined, page, pageSize: PAGE_SIZE };
      const cached = goodsOutService.getCachedGoodsOut(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await goodsOutService.listGoodsOut(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load dispatches.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [debounced, statusFilter, warehouse, engineer, page, refreshKey]);

  const rows = data?.goodsOut ?? [];
  const showSkeleton = loading && rows.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(debounced) || Boolean(warehouse) || Boolean(engineer);

  const onDelete = async () => {
    if (!confirm.gdn) return;
    setDeleting(true);
    try {
      await goodsOutService.deleteGoodsOut(confirm.gdn.id);
      setConfirm({ open: false, gdn: null });
      pushToast("Draft dispatch removed.", "success");
      if (rows.length === 1 && page > 1) setPage(page - 1);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Goods Out</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">Dispatch IRM stock from a warehouse to an engineer. Dispatching a draft decreases warehouse stock and adds it to the engineer&apos;s holding.</p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search GDN, engineer or warehouse…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as "all" | GoodsOutStatus); setPage(1); }} className={selectCls} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {(Object.keys(GOODS_OUT_STATUS_LABELS) as GoodsOutStatus[]).map((s) => (<option key={s} value={s}>{GOODS_OUT_STATUS_LABELS[s]}</option>))}
        </select>
        <select value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setPage(1); }} className={selectCls} aria-label="Filter by warehouse">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name} ({w.code})</option>))}
        </select>
        <select value={engineer} onChange={(e) => { setEngineer(e.target.value); setPage(1); }} className={selectCls} aria-label="Filter by engineer">
          <option value="">All engineers</option>
          {engineers.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
        </select>
        {can("goods_out.create") && (
          <button onClick={() => router.push("/dashboard/goods-out/new")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 lg:ml-auto">
            <Plus className="h-4 w-4" /> New dispatch
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <TableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <PackageMinus className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No dispatches match" : "No dispatches yet"}</p>
            {!isFiltered && can("goods_out.create") && (
              <button onClick={() => router.push("/dashboard/goods-out/new")} className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">Create your first dispatch</button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Code</th><th className="px-4 py-3">Warehouse</th><th className="px-4 py-3">Engineer</th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3">Dispatch date</th><th className="px-4 py-3">Items</th>{showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((gdn) => (
                  <tr key={gdn.id} onClick={() => router.push(`/dashboard/goods-out/${gdn.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{gdn.code}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{gdn.warehouseName}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{gdn.engineerName}{gdn.engineerEmployeeId ? <span className="ml-1.5 text-[11px] font-normal text-[var(--faint)]">{gdn.engineerEmployeeId}</span> : null}</td>
                    <td className="px-4 py-3"><GoodsOutStatusBadge status={gdn.status} /></td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(gdn.dispatchDate)}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{gdn.items.length} line{gdn.items.length === 1 ? "" : "s"} · {gdn.totalQuantity} unit{gdn.totalQuantity === 1 ? "" : "s"}</td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <RowActions gdn={gdn} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/goods-out/${gdn.code}/edit`)} onDelete={() => setConfirm({ open: true, gdn })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="dispatches" onPage={setPage} />}

      <ConfirmDialog open={confirm.open} title="Remove draft dispatch?" message={<>This deletes draft <strong className="text-[var(--ink)]">{confirm.gdn?.code}</strong>. Only drafts can be deleted.</>} confirmLabel="Remove" danger busy={deleting} onConfirm={onDelete} onClose={() => setConfirm({ open: false, gdn: null })} />
    </div>
  );
}
