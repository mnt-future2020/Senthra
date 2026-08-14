"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, PackageSearch, Pencil, Plus, Power, Search, Trash2 } from "lucide-react";

import * as irmService from "@/services/irm.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Select";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import type { IrmItem, IrmStatus } from "@/types/irm";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;

// Code · Item · Type · Category · Primary Supplier · Base Unit · Standard Cost · Status · actions.
// Item names and supplier names are the long values; nine columns at `min-w-[1100px]` gave each
// ~122px. Base Unit and Standard Cost step aside on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "normal", "normal", "wide", "narrow", "normal", "narrow", "narrow"]);
type Sort = "newest" | "oldest" | "name" | "code";

function formatCost(item: IrmItem): string {
  if (item.standardCost == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: item.currency ?? "GBP" }).format(item.standardCost);
  } catch {
    return `${item.standardCost}`;
  }
}

function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ElementType; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
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

function IrmRowActions({
  item,
  canEdit,
  canDelete,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  item: IrmItem;
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
              aria-label="IRM item actions"
              className="anim-fade-in fixed z-[60] w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {canEdit && (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                    Edit
                  </MenuItem>
                  <MenuItem icon={Power} onClick={() => { close(); onToggleStatus(); }}>
                    {item.status === "active" ? "Deactivate" : "Activate"}
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

function IrmTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Item</th>
            <th className="cell-y px-4">Type</th>
            <th className="cell-y px-4">Category</th>
            <th className="cell-y px-4">Primary Supplier</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Base Unit</th>
            <th className={`cell-y px-4 ${colClass("lg")}`}>Standard Cost</th>
            <th className="cell-y px-4">Status</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4"><Skeleton className="h-3 w-16" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-40" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-24" /></td>
              <td className={`cell-y px-4 ${colClass("xl")}`}><Skeleton className="h-3 w-12" /></td>
              <td className={`cell-y px-4 ${colClass("lg")}`}><Skeleton className="h-3 w-14" /></td>
              <td className="cell-y px-4"><Skeleton className="h-5 w-16 rounded-full" /></td>
              {actions && <td className="cell-y px-4"><Skeleton className="ml-auto h-6 w-6 rounded-lg" /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IrmItemsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from the URL — survive a browser refresh.
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | IrmStatus;
  const sort = (searchParams.get("sort") as Sort) ?? "newest";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local input state for debouncing — seeded from URL q.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => irmService.getCachedIrmItems({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; item: IrmItem | null }>({ open: false, item: null });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("irm.edit");
  const canDelete = can("irm.delete");
  const showActions = canEdit || canDelete;

  // Preserve all existing params (incl. ?tab) and reset page on filter changes.
  const patch = (updates: Record<string, string | null>, resetPage = true) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    if (resetPage) params.delete("page");
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  };

  // Debounce the search box into ?q.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, search]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
      const cached = irmService.getCachedIrmItems(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await irmService.listIrmItems(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load IRM items.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [exportParams, page, refreshKey]);

  const items = data?.items ?? [];
  const showSkeleton = loading && items.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search);

  const toggleStatus = async (i: IrmItem) => {
    const next = i.status === "active" ? "inactive" : "active";
    try {
      await irmService.updateIrmItem(i.id, { status: next });
      pushToast(next === "inactive" ? "Item deactivated." : "Item activated.", "success");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the item.", "alert");
    }
  };

  const onDelete = async () => {
    if (!confirm.item) return;
    setDeleting(true);
    try {
      await irmService.deleteIrmItem(confirm.item.id);
      setConfirm({ open: false, item: null });
      pushToast("Item removed.", "success");
      if (items.length === 1 && page > 1) patch({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, code, SKU, brand or MPN…"
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
        {/* Before "New item" and outside its ml-auto, so the primary action stays hard right. */}
        {can("irm.export") && (
          <ExportButton
            onExport={() => irmService.exportIrmItemsCsv(exportParams)}
            disabled={items.length === 0}
            title="Export the filtered catalogue to CSV"
          />
        )}
        {can("irm.create") && (
          <button
            onClick={() => router.push("/dashboard/irm/new")}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto"
          >
            <Plus className="h-4 w-4" /> Add item
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <IrmTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <PackageSearch className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No items match your search" : "No IRM items yet"}
            </p>
            {!isFiltered && can("irm.create") && (
              <button
                onClick={() => router.push("/dashboard/irm/new")}
                className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
              >
                Add your first item
              </button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th>
                  <th className="cell-y px-4">Item</th>
                  <th className="cell-y px-4">Type</th>
                  <th className="cell-y px-4">Category</th>
                  <th className="cell-y px-4">Primary Supplier</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Base Unit</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Standard Cost</th>
                  <th className="cell-y px-4">Status</th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    onClick={() => router.push(`/dashboard/irm/${i.code}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{i.code}</td>
                    <td className="cell-y px-4">
                      <div className="font-semibold text-[var(--ink)]">{i.name}</div>
                      {(i.brand || i.mpn) && (
                        <div className="text-[11px] text-[var(--faint)]">{[i.brand, i.mpn].filter(Boolean).join(" · ")}</div>
                      )}
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">{i.type?.name ?? "—"}</td>
                    <td className="cell-y px-4 text-[var(--muted)]">{i.category?.name ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={i.primarySupplier?.name ?? undefined}>{i.primarySupplier?.name ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")}`}>{i.baseUnit ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{formatCost(i)}</td>
                    <td className="cell-y px-4">
                      <StatusBadge status={i.status as UserStatus} />
                    </td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <IrmRowActions
                          item={i}
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onEdit={() => router.push(`/dashboard/irm/${i.code}/edit`)}
                          onToggleStatus={() => toggleStatus(i)}
                          onDelete={() => setConfirm({ open: true, item: i })}
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
            <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="items" onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)} />
        )}
      </div>

      <ConfirmDialog
        open={confirm.open}
        title="Remove IRM item?"
        message={
          <>
            This removes <strong className="text-[var(--ink)]">{confirm.item?.name}</strong> ({confirm.item?.code}). You can
            re-add it later. Deactivate instead if you only want to stop using it.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, item: null })}
      />
    </div>
  );
}
