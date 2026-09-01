"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Power, Search, Trash2, Truck } from "lucide-react";

import * as supplierService from "@/services/supplier.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Select";
import { listSupplierTypes } from "@/services/supplier-type.service";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import type { Supplier, SupplierStatus } from "@/types/supplier";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;

// Code · Supplier · Type · Primary Contact · Payment Terms · Currency · Lead Time · Status · actions.
// Supplier and contact names are the long values; nine columns at `min-w-[1100px]` gave each ~122px.
// Currency and Lead Time step aside on a narrow screen — both are reference detail.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "normal", "wide", "normal", "narrow", "narrow", "narrow", "narrow"]);
type Sort = "newest" | "oldest" | "name" | "code";

// Payment terms cell: a "Custom" term shows the free-text value instead of the word.
function paymentTermsLabel(s: Supplier): string {
  if (!s.paymentTerms) return "—";
  if (s.paymentTerms === "Custom") return s.customPaymentTerms || "Custom";
  return s.paymentTerms;
}

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
function SupplierRowActions({
  supplier,
  canEdit,
  canDelete,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  supplier: Supplier;
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
              aria-label="Supplier actions"
              className="anim-fade-in fixed z-[60] w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {canEdit && (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                    Edit
                  </MenuItem>
                  <MenuItem icon={Power} onClick={() => { close(); onToggleStatus(); }}>
                    {supplier.status === "active" ? "Deactivate" : "Activate"}
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

function SuppliersTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Supplier</th>
            <th className="cell-y px-4">Type</th>
            <th className="cell-y px-4">Primary Contact</th>
            <th className="cell-y px-4">Payment Terms</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Currency</th>
            <th className={`cell-y px-4 ${colClass("xl")}`}>Lead Time</th>
            <th className="cell-y px-4">Status</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4"><Skeleton className="h-3 w-16" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-36" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-24" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-24" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>
              <td className={`cell-y px-4 ${colClass("xl")}`}><Skeleton className="h-3 w-10" /></td>
              <td className={`cell-y px-4 ${colClass("xl")}`}><Skeleton className="h-3 w-12" /></td>
              <td className="cell-y px-4"><Skeleton className="h-5 w-16 rounded-full" /></td>
              {actions && <td className="cell-y px-4"><Skeleton className="ml-auto h-6 w-6 rounded-lg" /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SuppliersView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from URL params
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | SupplierStatus;
  const sort = (searchParams.get("sort") as Sort) ?? "newest";
  const typeFilter = searchParams.get("type") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local text-box value (debounced into ?q)
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => supplierService.getCachedSuppliers({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; supplier: Supplier | null }>({
    open: false,
    supplier: null,
  });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("suppliers.edit");
  const canDelete = can("suppliers.delete");
  const showActions = canEdit || canDelete;

  // Writer: preserves all existing params (incl. ?tab) and resets page by default
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

  // Debounce the search box into ?q
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.

  // The type list. Degrades to an empty array — which renders as "All types" alone — because the
  // master-data read is its own permission and a list user need not hold it.
  const [types, setTypes] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    listSupplierTypes()
      .then((rows) => alive && setTypes(rows.filter((t) => t.status !== "inactive").map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => alive && setTypes([]));
    return () => { alive = false; };
  }, []);

  const exportParams = React.useMemo(
    () => ({
      search: search || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      type: typeFilter || undefined,
      sort: sort === "newest" ? undefined : sort,
    }),
    [search, statusFilter, typeFilter, sort],
  );

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
      const cached = supplierService.getCachedSuppliers(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await supplierService.listSuppliers(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load suppliers.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [exportParams, page, refreshKey]);

  const suppliers = data?.suppliers ?? [];
  const showSkeleton = loading && suppliers.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search) || Boolean(typeFilter);

  const toggleStatus = async (s: Supplier) => {
    const next = s.status === "active" ? "inactive" : "active";
    try {
      await supplierService.updateSupplier(s.id, { status: next });
      pushToast(next === "inactive" ? "Supplier deactivated." : "Supplier activated.", "success");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the supplier.", "alert");
    }
  };

  const onDelete = async () => {
    if (!confirm.supplier) return;
    setDeleting(true);
    try {
      await supplierService.deleteSupplier(confirm.supplier.id);
      setConfirm({ open: false, supplier: null });
      pushToast("Supplier removed.", "success");
      if (suppliers.length === 1 && page > 1) patch({ page: String(page - 1) }, false);
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
            placeholder="Search name, code or contact…"
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
        {/* Supplier TYPE. The API has always accepted it; the toolbar simply never offered it, so a
            list of every supplier could only be narrowed by active/inactive. */}
        <Select
          size="sm"
          value={typeFilter}
          onChange={(v) => patch({ type: v || null })}
          options={[{ value: "", label: "All types" }, ...types.map((t) => ({ value: t.id, label: t.name }))]}
          ariaLabel="Filter by supplier type"
        />
        {/* Before "New supplier" and outside its ml-auto, so the primary action stays hard right. */}
        {can("suppliers.export") && (
          <ExportButton
            onExport={() => supplierService.exportSuppliersCsv(exportParams)}
            disabled={suppliers.length === 0}
            title="Export the filtered suppliers to CSV"
          />
        )}
        {can("suppliers.create") && (
          <button
            onClick={() => router.push("/dashboard/suppliers/new")}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto"
          >
            <Plus className="h-4 w-4" /> Add supplier
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <SuppliersTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : suppliers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Truck className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No suppliers match your search" : "No suppliers yet"}
            </p>
            {!isFiltered && can("suppliers.create") && (
              <button
                onClick={() => router.push("/dashboard/suppliers/new")}
                className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
              >
                Add your first supplier
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
                  <th className="cell-y px-4">Type</th>
                  <th className="cell-y px-4">Primary Contact</th>
                  <th className="cell-y px-4">Payment Terms</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Currency</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Lead Time</th>
                  <th className="cell-y px-4">Status</th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/dashboard/suppliers/${s.code}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{s.code}</td>
                    <td className="cell-y px-4">
                      <div className="font-semibold text-[var(--ink)]">{s.name}</div>
                      {s.legalName && <div className="text-[11px] text-[var(--faint)]">{s.legalName}</div>}
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">{s.type?.name ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={s.contactPerson ?? undefined}>{s.contactPerson ?? "—"}</td>
                    <td className="cell-y px-4 text-[var(--muted)]">{paymentTermsLabel(s)}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")}`}>{s.currency ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")}`}>
                      {s.leadTimeDays != null ? `${s.leadTimeDays} days` : "—"}
                    </td>
                    <td className="cell-y px-4">
                      <StatusBadge status={s.status as UserStatus} />
                    </td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                        <SupplierRowActions
                          supplier={s}
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onEdit={() => router.push(`/dashboard/suppliers/${s.code}/edit`)}
                          onToggleStatus={() => toggleStatus(s)}
                          onDelete={() => setConfirm({ open: true, supplier: s })}
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
              label="suppliers"
              onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)}
            />
        )}
      </div>

      <ConfirmDialog
        open={confirm.open}
        title="Remove supplier?"
        message={
          <>
            This removes{" "}
            <strong className="text-[var(--ink)]">{confirm.supplier?.name}</strong> ({confirm.supplier?.code}).
            You can re-add it later. Deactivate instead if you only want to stop using it.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, supplier: null })}
      />
    </div>
  );
}
