"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PO_STATUS_LABELS, PoPriorityLabel, PoStatusBadge, formatDate, formatMoney } from "./poStatus";
import type { PoStatus, PurchaseOrder } from "@/types/purchase-order";

const PAGE_SIZE = 20;

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

function PoRowActions({ po, canEdit, canDelete, onEdit, onDelete }: { po: PurchaseOrder; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
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
  const draft = po.status === "draft";
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
            <div ref={menuRef} role="menu" aria-label="Purchase order actions" className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
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

function PoTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Supplier</th>
            <th className="px-4 py-3">Warehouse</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Order Date</th>
            <th className="px-4 py-3">Expected</th>
            <th className="px-4 py-3">Grand Total</th>
            {actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 9 : 8 }).map((__, j) => (
                <td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseOrdersView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Derive filter state from URL params
  const statusFilter = (searchParams.get("status") as "all" | PoStatus) ?? "all";
  // "Awaiting my action" — the PM worklist (orders in pm_review assigned to me). Overrides the
  // status filter while active; only offered to users who can actually send (i.e. act as a PM).
  const awaitingMine = searchParams.get("awaiting") === "1";
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
  const [data, setData] = React.useState(() => poService.getCachedPurchaseOrders({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; po: PurchaseOrder | null }>({ open: false, po: null });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("purchase_orders.edit");
  const canDelete = can("purchase_orders.delete");
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

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = awaitingMine
        ? { search: search || undefined, status: "pm_review", pm: "me", page, pageSize: PAGE_SIZE }
        : { search: search || undefined, status: statusFilter === "all" ? undefined : statusFilter, page, pageSize: PAGE_SIZE };
      const cached = poService.getCachedPurchaseOrders(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await poService.listPurchaseOrders(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load purchase orders.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [search, statusFilter, awaitingMine, page, refreshKey]);

  const orders = data?.purchaseOrders ?? [];
  const showSkeleton = loading && orders.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search) || awaitingMine;

  const onDelete = async () => {
    if (!confirm.po) return;
    setDeleting(true);
    try {
      await poService.deletePurchaseOrder(confirm.po.id);
      setConfirm({ open: false, po: null });
      pushToast("Draft purchase order removed.", "success");
      if (orders.length === 1 && page > 1) patchParams({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Purchase Orders</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">Raise, approve and issue orders to suppliers. Goods are received later by Goods In.</p>
      </div>

      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code, supplier or reference…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patchParams({ status: v === "all" ? null : v, awaiting: null }, true)} options={[{ value: "all", label: "All statuses" }, ...(Object.keys(PO_STATUS_LABELS) as PoStatus[]).map((s) => ({ value: s, label: PO_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" disabled={awaitingMine} />
        {/* PM worklist quick filter — orders routed to ME for review + send. */}
        {can("purchase_orders.send") && (
          <button
            type="button"
            onClick={() => patchParams({ awaiting: awaitingMine ? null : "1", status: null }, true)}
            aria-pressed={awaitingMine}
            className={`shrink-0 rounded-lg border px-3 py-2.5 text-xs font-bold transition-all ${awaitingMine ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] hover:border-[var(--accent)]"}`}
          >
            Awaiting my action
          </button>
        )}
        {can("purchase_orders.create") && (
          <button onClick={() => router.push("/dashboard/purchase-orders/new")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto">
            <Plus className="h-4 w-4" /> New order
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <PoTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ClipboardList className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No purchase orders match" : "No purchase orders yet"}</p>
            {!isFiltered && can("purchase_orders.create") && (
              <button onClick={() => router.push("/dashboard/purchase-orders/new")} className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">
                Raise your first order
              </button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Warehouse</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Order Date</th>
                  <th className="px-4 py-3">Expected</th>
                  <th className="px-4 py-3">Grand Total</th>
                  {showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {orders.map((po) => (
                  <tr key={po.id} onClick={() => router.push(`/dashboard/purchase-orders/${po.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{po.code}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{po.supplierName ?? po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{po.warehouse?.name ?? "—"}</td>
                    <td className="px-4 py-3"><PoStatusBadge status={po.status} /></td>
                    <td className="px-4 py-3 text-xs"><PoPriorityLabel priority={po.priority} /></td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(po.orderDate)}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(po.expectedDeliveryDate)}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{formatMoney(po.grandTotal, po.currency)}</td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <PoRowActions po={po} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/purchase-orders/${po.code}/edit`)} onDelete={() => setConfirm({ open: true, po })} />
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
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="purchase orders" onPage={(p) => patchParams({ page: p > 1 ? String(p) : null }, false)} />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        title="Remove draft order?"
        message={<>This deletes draft <strong className="text-[var(--ink)]">{confirm.po?.code}</strong>. Only drafts can be deleted.</>}
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, po: null })}
      />
    </div>
  );
}
