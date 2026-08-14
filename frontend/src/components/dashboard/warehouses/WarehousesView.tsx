"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Power, Search, Trash2, Warehouse as WarehouseIcon } from "lucide-react";

import * as warehouseService from "@/services/warehouse.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Select";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { EntityCountPill } from "@/components/dashboard/shell/TabCount";
import { useEntityAttention } from "@/hooks/useEntityAttention";
import type { Warehouse, WarehouseStatus } from "@/types/warehouse";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;

// Code · Warehouse · Manager · City · Contact · Status · Needs attention · actions.
// The flat `min-w-[860px]` this replaces gave each ~107px — the tightest table in the app — while
// "London Fulfillment Centre" and a full contact name both run past 170px.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "normal", "normal", "normal", "narrow", "narrow", "narrow"]);

// ── Why these figures don't add up to the sidebar badge ────────────────────────────────────────
//
// They differ in TWO directions, and both are correct:
//
//   • The badge also counts "Stock out too long", which has no per-warehouse form — that read starts
//     from every open job and nets its whole movement history, so there is nothing to group on and
//     running it once per warehouse would be N of the most expensive read in the module.
//   • A job kitted from two warehouses, or a restock split across two, counts at EACH here. That is
//     the truth about the floor: both warehouses have their own lines to pick. To the module it is
//     one piece of work; to the warehouses it is two.
//
// Neither is fixable without breaking something real. Attributing spanning work to a single warehouse
// would hide it from the other one's manager — a genuine bug, not a tidier number. Rebuilding the
// badge from these rows would drop "Stock out too long", the only critical-toned signal on the row.
//
// So the two numbers stay, and the screen says so. This was already written down in the backend
// catalog; the failure was that it was written for whoever reads the code, not for whoever reads the
// page — and the person comparing "16" in the sidebar with these figures is the second one.
const ATTENTION_TITLE =
  "Kit to issue, returns, field stock requests and customer stock waiting at this warehouse. " +
  "Work spanning two warehouses counts at each, so these can total more than the sidebar badge.";
type Sort = "newest" | "oldest" | "name" | "code";


function MenuItem({
  icon: Icon,
  danger,
  onClick,
  children,
}: {
  icon: React.ElementType;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${
        danger ? "text-[var(--neg)]" : "text-[var(--ink)]"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

// Per-row ⋯ menu (Edit / Activate-Deactivate / Delete). Anchored + portalled (fixed)
// so the table's scroll container can't clip it. Clicks stopPropagation so they don't
// trigger the row's navigation.
function WarehouseRowActions({
  warehouse,
  canEdit,
  canDelete,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  warehouse: Warehouse;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
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
    setPos(spaceBelow < 200 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
    setOpen(true);
  };
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
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

  if (!canEdit && !canDelete) return null;

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
            <div
              ref={menuRef}
              role="menu"
              aria-label="Warehouse actions"
              className="anim-fade-in fixed z-[60] w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {canEdit && (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                    Edit
                  </MenuItem>
                  <MenuItem icon={Power} onClick={() => { close(); onToggleStatus(); }}>
                    {warehouse.status === "active" ? "Deactivate" : "Activate"}
                  </MenuItem>
                </>
              )}
              {canEdit && canDelete && <div className="my-1 border-t border-[var(--border-2)]" />}
              {canDelete && (
                <MenuItem icon={Trash2} danger onClick={() => { close(); onDelete(); }}>
                  Delete
                </MenuItem>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function WarehousesTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Warehouse</th>
            <th className="cell-y px-4">Manager</th>
            <th className={`cell-y px-4 ${colClass("lg")}`}>City</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Contact</th>
            <th className="cell-y px-4">Status</th>
            <th className="cell-y px-4">Needs attention here</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4"><Skeleton className="h-3 w-16" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-36" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-24" /></td>
              <td className={`cell-y px-4 ${colClass("lg")}`}><Skeleton className="h-3 w-20" /></td>
              <td className={`cell-y px-4 ${colClass("xl")}`}><Skeleton className="h-3 w-24" /></td>
              <td className="cell-y px-4"><Skeleton className="h-5 w-16 rounded-full" /></td>
              <td className="cell-y px-4"><Skeleton className="h-4 w-6 rounded-full" /></td>
              {actions && <td className="cell-y px-4"><Skeleton className="ml-auto h-6 w-6 rounded-lg" /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WarehousesView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from URL
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | WarehouseStatus;
  const sort = (searchParams.get("sort") as Sort) ?? "newest";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local state — not user-facing filters
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => warehouseService.getCachedWarehouses({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; warehouse: Warehouse | null }>({
    open: false,
    warehouse: null,
  });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("warehouse.edit");
  const canDelete = can("warehouse.delete");
  const showActions = canEdit || canDelete;

  // Patch URL params, preserving all existing params (incl. ?tab). Filter changes reset to page 1.
  const patch = React.useCallback((updates: Record<string, string | null>, resetPage = true) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    if (resetPage) params.delete("page");
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  }, [router]);

  // Debounce the search input into ?q
  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.
  const exportParams = React.useMemo(
    () => ({
      search: search || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      sort: sort === "newest" ? undefined : sort,
    }),
    [search, statusFilter, sort],
  );

  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
      const cached = warehouseService.getCachedWarehouses(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await warehouseService.listWarehouses(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load warehouses.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [exportParams, page, refreshKey]);

  const warehouses = data?.warehouses ?? [];
  // Each warehouse's own share of the pending work. Server-filtered to the queues this actor may act
  // on, so a user who can only review van requests sees a column counting exactly those.
  const { rows: attention } = useEntityAttention("warehouse");
  // What the column adds up to across the warehouses ON THIS PAGE — the figure someone is implicitly
  // summing by eye when they compare it with the sidebar. Scoped to the rendered rows so it always
  // describes the column they can actually see, never a hidden page's.
  const attentionTotal = warehouses.reduce((n, w) => n + (attention[w.id]?.count ?? 0), 0);
  const showSkeleton = loading && warehouses.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search);

  const toggleStatus = async (w: Warehouse) => {
    const next = w.status === "active" ? "inactive" : "active";
    try {
      await warehouseService.updateWarehouse(w.id, { status: next });
      pushToast(next === "inactive" ? "Warehouse deactivated." : "Warehouse activated.", "success");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the warehouse.", "alert");
    }
  };

  const onDelete = async () => {
    if (!confirm.warehouse) return;
    setDeleting(true);
    try {
      await warehouseService.deleteWarehouse(confirm.warehouse.id);
      setConfirm({ open: false, warehouse: null });
      pushToast("Warehouse removed.", "success");
      if (warehouses.length === 1 && page > 1) patch({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      {/* This page used to open with the aggregate chip bar (`Job kit to issue · 12`, `Field stock
          requests · 5`, …). Every one of those chips linked to THIS page, because the work behind them
          is done inside a warehouse and no cross-warehouse screen exists — so clicking one reloaded
          the page the user was already standing on. The counts now live on the rows below, where the
          number names the warehouse you have to open and clicking it takes you there. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, code, city or contact…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select
          size="sm"
          value={statusFilter}
          onChange={(v) => patch({ status: v === "all" ? null : v })}
          options={[
            { value: "all", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          ariaLabel="Status filter"
        />
        <Select
          size="sm"
          value={sort}
          onChange={(v) => patch({ sort: v === "newest" ? null : v })}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
            { value: "name", label: "Name (A–Z)" },
            { value: "code", label: "Code" },
          ]}
          ariaLabel="Sort"
        />
        {/* Before "New warehouse" and outside its ml-auto, so the primary action stays hard right. */}
        {can("warehouse.export") && (
          <ExportButton
            onExport={() => warehouseService.exportWarehousesCsv(exportParams)}
            disabled={warehouses.length === 0}
            title="Export the filtered warehouses to CSV"
          />
        )}
        {can("warehouse.create") && (
          <button
            onClick={() => router.push("/dashboard/warehouses/new")}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto"
          >
            <Plus className="h-4 w-4" /> Add warehouse
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <WarehousesTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : warehouses.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <WarehouseIcon className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No warehouses match your search" : "No warehouses yet"}
            </p>
            {!isFiltered && can("warehouse.create") && (
              <button
                onClick={() => router.push("/dashboard/warehouses/new")}
                className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
              >
                Add your first warehouse
              </button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th>
                  <th className="cell-y px-4">Warehouse</th>
                  <th className="cell-y px-4" title="Assigned under Users & Roles">Manager</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>City</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Contact</th>
                  <th className="cell-y px-4">Status</th>
                  {/* Replaces the Items / Qty pair, which rendered a literal "—" in every row under a
                      "Available once inventory is live" tooltip. Two columns of nothing, in the space
                      the one number a warehouse manager opens this list to find had nowhere to go.
                      "here" earns its place in that heading: these are PER-WAREHOUSE figures and do
                      not add up to the sidebar badge — see ATTENTION_NOTE. */}
                  <th className="cell-y px-4" title={ATTENTION_TITLE}>
                    Needs attention here
                  </th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {warehouses.map((w) => (
                  <tr
                    key={w.id}
                    onClick={() => router.push(`/dashboard/warehouses/${w.code}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{w.code}</td>
                    <td className="cell-y px-4">
                      <div className="flex items-center gap-2 font-semibold text-[var(--ink)]">
                        {w.name}
                        {w.isDefault && (
                          <span className="rounded-full bg-[var(--accent-10)] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--faint)]">{w.type?.name ?? "—"}</div>
                    </td>
                    {/* Derived from the Users & Roles assignments — first name, then a +N overflow. */}
                    <td className="cell-y px-4 text-[var(--muted)]">
                      {w.managers.length ? (
                        <>
                          {w.managers[0].name}
                          {w.managers.length > 1 && (
                            <span className="ml-1 text-[11px] text-[var(--faint)]">
                              +{w.managers.length - 1}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{w.city ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE} ${colClass("xl")}`} title={w.contactPerson ?? undefined}>{w.contactPerson ?? "—"}</td>
                    <td className="cell-y px-4">
                      <StatusBadge status={w.status as UserStatus} />
                    </td>
                    {/* A dash when there is nothing to do, so an idle warehouse reads as settled
                        rather than as a count that failed to load. */}
                    <td className="cell-y px-4">
                      {attention[w.id] ? (
                        <EntityCountPill row={attention[w.id]} at={w.name} />
                      ) : (
                        <span className="text-[var(--faint)]">—</span>
                      )}
                    </td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <WarehouseRowActions
                          warehouse={w}
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onEdit={() => router.push(`/dashboard/warehouses/${w.code}/edit`)}
                          onToggleStatus={() => toggleStatus(w)}
                          onDelete={() => setConfirm({ open: true, warehouse: w })}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
            <Pagination embedded
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              label="warehouses"
              onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)}
              // Stated on the page, not just in a tooltip: the person comparing "16" in the sidebar
              // with these figures is looking at the numbers, not hovering the header. Only shown
              // when there is something to explain — with an empty column it would be noise.
              note={
                attentionTotal > 0 ? (
                  <span className="font-normal" title={ATTENTION_TITLE}>
                    · {attentionTotal} awaiting action here — work spanning two warehouses counts at each, so this
                    can exceed the sidebar badge
                  </span>
                ) : null
              }
            />
        )}
      </div>

      <ConfirmDialog
        open={confirm.open}
        title="Remove warehouse?"
        message={
          <>
            This removes{" "}
            <strong className="text-[var(--ink)]">{confirm.warehouse?.name}</strong> ({confirm.warehouse?.code}).
            You can re-add it later. Deactivate instead if you only want to stop using it.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, warehouse: null })}
      />
    </div>
  );
}
