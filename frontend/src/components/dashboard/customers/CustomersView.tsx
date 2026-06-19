"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Search, Send, Trash2, Users2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { Select } from "@/components/ui/Select";
import type { CustomerStatus, CustomerSummary } from "@/types/customer";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;
type Sort = "newest" | "oldest" | "name";

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

// Per-row ⋯ menu (Edit / Resend invite / Delete). The whole row already opens the
// detail; this surfaces the secondary actions. Anchored to the button and portalled
// (fixed) so the table's scroll container can't clip it. Clicks stopPropagation so
// they don't trigger the row's navigation.
function CustomerRowActions({
  canEdit,
  canDelete,
  onEdit,
  onResend,
  onDelete,
}: {
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onResend: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // Close and return focus to the trigger (keyboard users land back where they were).
  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPos(
      spaceBelow < 200
        ? { bottom: window.innerHeight - rect.top + 4, right }
        : { top: rect.bottom + 4, right },
    );
    setOpen(true);
  };

  // While open: a captured position goes stale on scroll/resize — close instead of
  // drifting; Escape closes; and focus moves into the menu for keyboard users.
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
              aria-label="Customer actions"
              className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {canEdit && (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                    Edit
                  </MenuItem>
                  <MenuItem icon={Send} onClick={() => { close(); onResend(); }}>
                    Resend invite
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

function CustomersTableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Company</th>
            <th className="px-4 py-3">Contact</th>
            <th className="px-4 py-3">Email</th>
            <th className="px-4 py-3">Status</th>
            {actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-32" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-40" /></td>
              <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
              {actions && <td className="px-4 py-3"><Skeleton className="ml-auto h-6 w-6 rounded-lg" /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CustomersView() {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | CustomerStatus>("all");
  const [sort, setSort] = React.useState<Sort>("newest");
  const [page, setPage] = React.useState(1);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() =>
    customerService.getCachedCustomers({ pageSize: PAGE_SIZE }),
  );
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; customer: CustomerSummary | null }>({
    open: false,
    customer: null,
  });
  const [deleting, setDeleting] = React.useState(false);
  const [resendTarget, setResendTarget] = React.useState<CustomerSummary | null>(null);
  const [resending, setResending] = React.useState(false);
  const [resendCreds, setResendCreds] = React.useState<{ email: string; password: string } | null>(
    null,
  );

  const canEdit = can("customers.edit");
  const canDelete = can("customers.delete");
  const showActions = canEdit || canDelete;

  // Debounce the search box so each keystroke doesn't fire a request.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Re-fetch on any query change. Cache-first (instant) then revalidate.
  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = {
        search: debounced || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        // "newest" is the server default → omit it so the cache key matches the
        // initial seed (getCachedCustomers({ pageSize })), which has no sort.
        sort: sort === "newest" ? undefined : sort,
        page,
        pageSize: PAGE_SIZE,
      };
      const cached = customerService.getCachedCustomers(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await customerService.listCustomers(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load customers.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [debounced, statusFilter, sort, page, refreshKey]);

  const onSearchChange = (v: string) => {
    setSearch(v);
    setPage(1);
  };
  const onStatusChange = (v: "all" | CustomerStatus) => {
    setStatusFilter(v);
    setPage(1);
  };
  const onSortChange = (v: Sort) => {
    setSort(v);
    setPage(1);
  };
  const goToNew = () => router.push("/dashboard/customers/new");

  const customers = data?.customers ?? [];
  const showSkeleton = loading && customers.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(debounced);

  const doResend = async () => {
    if (!resendTarget) return;
    setResending(true);
    try {
      const { temporaryPassword } = await customerService.resendInvite(resendTarget.id);
      setResendCreds({ email: resendTarget.email, password: temporaryPassword });
      setResendTarget(null);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not resend invite.", "alert");
    } finally {
      setResending(false);
    }
  };

  const onDelete = async () => {
    if (!confirm.customer) return;
    setDeleting(true);
    try {
      await customerService.deleteCustomer(confirm.customer.id);
      setConfirm({ open: false, customer: null });
      pushToast("Customer removed.", "success");
      // Drop back a page if we just removed the last row on a later page.
      if (customers.length === 1 && page > 1) setPage(page - 1);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div
        className="shrink-0 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
        style={{ borderRadius: "var(--radius)" }}
      >
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Customers</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">
          Customer companies and their read-only portal access.
        </p>
      </div>

      {/* Toolbar: search + filter + sort + add */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, code, email or contact…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select
          size="sm"
          value={statusFilter}
          onChange={(v) => onStatusChange(v as "all" | CustomerStatus)}
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
          onChange={(v) => onSortChange(v as Sort)}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
            { value: "name", label: "Name (A–Z)" },
          ]}
          ariaLabel="Sort"
        />
        {can("customers.create") && (
          <button
            onClick={goToNew}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto"
          >
            <Plus className="h-4 w-4" /> Add customer
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <CustomersTableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Users2 className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No customers match your search" : "No customers yet"}
            </p>
            {!isFiltered && can("customers.create") && (
              <button
                onClick={goToNew}
                className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
              >
                Add your first customer
              </button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  {showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {customers.map((c: CustomerSummary) => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/dashboard/customers/${c.customerCode}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{c.customerCode}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{c.name}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{c.contactPerson ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{c.email}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.status as UserStatus} />
                    </td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <CustomerRowActions
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onEdit={() => router.push(`/dashboard/customers/${c.customerCode}/edit`)}
                          onResend={() => setResendTarget(c)}
                          onDelete={() => setConfirm({ open: true, customer: c })}
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
            label="customers"
            onPage={setPage}
          />
        </div>
      )}

      <ConfirmDialog
        open={resendTarget !== null}
        title="Re-send invite?"
        message={
          <>
            This generates a new temporary password for{" "}
            <strong className="text-[var(--ink)]">{resendTarget?.name}</strong>, emails it, and
            <strong> invalidates their current password</strong>.
          </>
        }
        confirmLabel="Re-send invite"
        busy={resending}
        onConfirm={doResend}
        onClose={() => setResendTarget(null)}
      />

      <ConfirmDialog
        open={confirm.open}
        title="Remove customer?"
        message={
          <>
            This removes{" "}
            <strong className="text-[var(--ink)]">{confirm.customer?.name}</strong> and revokes their
            portal access. This can be undone by re-adding them.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onClose={() => setConfirm({ open: false, customer: null })}
      />

      {resendCreds && (
        <TempPasswordModal
          open
          title="Invite re-sent"
          portal
          resent
          email={resendCreds.email}
          password={resendCreds.password}
          onClose={() => setResendCreds(null)}
        />
      )}
    </div>
  );
}
