"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, MoreHorizontal, Pencil, Plus, Rows3, Search, Trash2 } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { usePurchaseOrderSocket } from "@/hooks/usePurchaseOrderSocket";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { CELL_ONE_LINE, colClass, colClassAt, tableMinWidth, type ColPriority } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AttentionBar } from "@/components/dashboard/shell/AttentionBar";
import { HireStateBadge, PO_DERIVED_STATUS_OPTIONS, PO_STATUS_LABELS, PoPriorityLabel, PoStatusBadge, formatDate, formatMoney } from "./poStatus";
import type { PoStatus, PurchaseOrder } from "@/types/purchase-order";

const PAGE_SIZE = 20;

// Code · Supplier · Warehouse · Status · Priority · Order Date · Expected · Grand Total · actions.
// The flat `min-w-[1000px]` this replaces gave each ~111px, while "pex Telecom Solutions" needs ~197
// and "London Fulfillment Centre" ~227 — so both wrapped, the dates wrapped, and every row ran to two
// or three lines. Priority and Order Date step aside on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "wide", "narrow", "narrow", "normal", "normal", "normal", "narrow"]);

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

// One array drives BOTH rows below, which is the rule colClass exists to enforce: a placeholder cell
// that stays visible while its header is hidden shifts every cell after it.
const SKELETON_COLS: ColPriority[] = ["always", "always", "always", "always", "xl", "lg", "always", "always"];

function PoTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Supplier</th>
            <th className="cell-y px-4">Warehouse</th>
            <th className="cell-y px-4">Status</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Priority</th>
            <th className={`cell-y px-4 ${colClass("lg")}`}>Order Date</th>
            <th className="cell-y px-4">Expected</th>
            <th className="cell-y px-4">Grand Total</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 9 : 8 }).map((__, j) => (
                <td key={j} className={`cell-y px-4 ${colClassAt(SKELETON_COLS, j)}`}><Skeleton className="h-3 w-20" /></td>
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
  // "overdue" is a DERIVED pseudo-status the server resolves (receivable POs whose confirmed-or-
  // expected ETA is before the company-timezone start of today) — the same predicate as the overdue
  // dashboard card and the Deliveries-overdue badge. Not a PoStatus: it never reaches a status chip.
  const statusFilter = (searchParams.get("status") as "all" | "overdue" | "awaiting_close" | PoStatus) ?? "all";
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

  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.
  const exportParams = React.useMemo(
    () =>
      awaitingMine
        ? { search: search || undefined, status: "pm_review", pm: "me" }
        : { search: search || undefined, status: statusFilter === "all" ? undefined : statusFilter },
    [awaitingMine, search, statusFilter],
  );

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
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
  }, [exportParams, page, refreshKey]);

  // Live-refresh the list whenever anyone moves a PO through the flow, so a board left open shows
  // the current statuses (and the "awaiting mine" queue empties as the PM sends each order) without
  // a manual reload. The cached read above is only an instant placeholder — the refetch this
  // triggers always goes to the network, so the row that changed is real data, not the stale cache.
  usePurchaseOrderSocket(React.useCallback(() => setRefreshKey((k) => k + 1), []));

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
    <div className="stack flex h-full flex-col">
      {/* Breakdown of the sidebar's Purchase Orders badge — approvals, sends, supplier acceptances,
          overdue deliveries and receipts ready to close.
          INSIDE the toolbar card rather than in a block of its own above it: these chips narrow this
          list exactly as the controls below them do, and as a separate block they also paid the
          layout's 20px flex gap on top of their own height. Not inlined into the filter row (as on
          Jobs) because this row carries up to six chips — enough to wrap the filters onto a second
          line, which would cost more than it saved. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        <AttentionBar
          nav="/dashboard/purchase-orders"
          className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] pb-3"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code, supplier or reference…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patchParams({ status: v === "all" ? null : v, awaiting: null }, true)} options={[{ value: "all", label: "All statuses" }, ...PO_DERIVED_STATUS_OPTIONS, ...(Object.keys(PO_STATUS_LABELS) as PoStatus[]).map((s) => ({ value: s, label: PO_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" disabled={awaitingMine} />
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
        {/* Before "New order" and outside its ml-auto, so the primary action stays hard right. */}
        {can("purchase_orders.export") && (
          <>
            <ExportButton
              label="Export"
              onExport={() => poService.exportPurchaseOrdersCsv(exportParams)}
              disabled={orders.length === 0}
              title="Export the filtered purchase orders — one row per order"
            />
            {/* The spend report: one row per LINE. Separate from the summary rather than replacing
                it, because the two answer different questions — "what did this order cost" is a
                header, "what did we spend on this item" is only pivotable from the lines. */}
            <ExportButton
              label="Export lines"
              icon={Rows3}
              onExport={() => poService.exportPurchaseOrderLinesCsv(exportParams)}
              disabled={orders.length === 0}
              title="Export every order LINE — item, quantity, unit price (for spend analysis)"
            />
          </>
        )}
        {can("purchase_orders.create") && (
          <button onClick={() => router.push("/dashboard/purchase-orders/new")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto">
            <Plus className="h-4 w-4" /> New order
          </button>
        )}
        </div>
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
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th>
                  <th className="cell-y px-4">Supplier</th>
                  <th className="cell-y px-4">Warehouse</th>
                  <th className="cell-y px-4">Status</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Priority</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Order Date</th>
                  <th className="cell-y px-4">Expected</th>
                  <th className="cell-y px-4">Grand Total</th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {orders.map((po) => (
                  <tr key={po.id} onClick={() => router.push(`/dashboard/purchase-orders/${po.code}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{po.code}</td>
                    <td className={`cell-y px-4 font-semibold text-[var(--ink)] ${CELL_ONE_LINE}`} title={po.supplierName ?? po.supplier?.name ?? undefined}>{po.supplierName ?? po.supplier?.name ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={po.warehouse?.name ?? undefined}>{po.warehouse?.name ?? "—"}</td>
                    {/* Status AND hire state. Without the second one the list repeats the header's old lie at
                            scale: an order whose kit went back weeks ago reads "Fully Received" and nothing
                            else, on every row. Renders nothing for a goods-only order. */}
                    <td className="cell-y px-4">
                      <div className="flex flex-wrap items-center gap-1">
                        <PoStatusBadge status={po.status} />
                        <HireStateBadge rentalItems={po.rentalItems} />
                      </div>
                    </td>
                    <td className={`cell-y px-4 text-xs ${colClass("xl")}`}><PoPriorityLabel priority={po.priority} /></td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{formatDate(po.orderDate)}</td>
                    <td className="cell-y px-4 text-[var(--muted)]">{formatDate(po.expectedDeliveryDate)}</td>
                    <td className="cell-y px-4 font-semibold text-[var(--ink)]">{formatMoney(po.grandTotal, po.currency)}</td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <PoRowActions po={po} canEdit={canEdit} canDelete={canDelete} onEdit={() => router.push(`/dashboard/purchase-orders/${po.code}/edit`)} onDelete={() => setConfirm({ open: true, po })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
            <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="purchase orders" onPage={(p) => patchParams({ page: p > 1 ? String(p) : null }, false)} />
        )}
      </div>

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
