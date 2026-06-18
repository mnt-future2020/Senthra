"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Power, Search, Trash2, Truck } from "lucide-react";

import * as supplierService from "@/services/supplier.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Supplier, SupplierStatus } from "@/types/supplier";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;
type Sort = "newest" | "oldest" | "name" | "code";

const selectCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]";

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
      <table className="w-full min-w-[1100px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Supplier</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Primary Contact</th>
            <th className="px-4 py-3">Owner</th>
            <th className="px-4 py-3">Payment Terms</th>
            <th className="px-4 py-3">Currency</th>
            <th className="px-4 py-3">Lead Time</th>
            <th className="px-4 py-3">Status</th>
            {actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-36" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-10" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-12" /></td>
              <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
              {actions && <td className="px-4 py-3"><Skeleton className="ml-auto h-6 w-6 rounded-lg" /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SuppliersView() {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | SupplierStatus>("all");
  const [sort, setSort] = React.useState<Sort>("newest");
  const [page, setPage] = React.useState(1);
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

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = {
        search: debounced || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        sort: sort === "newest" ? undefined : sort,
        page,
        pageSize: PAGE_SIZE,
      };
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
  }, [debounced, statusFilter, sort, page, refreshKey]);

  const suppliers = data?.suppliers ?? [];
  const showSkeleton = loading && suppliers.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(debounced);

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
      if (suppliers.length === 1 && page > 1) setPage(page - 1);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search name, code or contact…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as "all" | SupplierStatus);
            setPage(1);
          }}
          className={selectCls}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            setPage(1);
          }}
          className={selectCls}
          title="Sort"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name (A–Z)</option>
          <option value="code">Code</option>
        </select>
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
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Primary Contact</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Payment Terms</th>
                  <th className="px-4 py-3">Currency</th>
                  <th className="px-4 py-3">Lead Time</th>
                  <th className="px-4 py-3">Status</th>
                  {showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/dashboard/suppliers/${s.code}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{s.code}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--ink)]">{s.name}</div>
                      {s.legalName && <div className="text-[11px] text-[var(--faint)]">{s.legalName}</div>}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{s.type?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{s.contactPerson ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{s.owner?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{paymentTermsLabel(s)}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{s.currency ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {s.leadTimeDays != null ? `${s.leadTimeDays} days` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status as UserStatus} />
                    </td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
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
      </div>

      {data && data.total > 0 && (
        <div className="shrink-0">
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            label="suppliers"
            onPage={setPage}
          />
        </div>
      )}

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
