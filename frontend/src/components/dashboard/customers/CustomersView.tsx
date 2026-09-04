"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Search, Send, Trash2, Users2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { Select } from "@/components/ui/Select";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { listToolbarCls } from "@/components/ui/styles";
import { EntityCountPill } from "@/components/dashboard/shell/TabCount";
import { useEntityAttention } from "@/hooks/useEntityAttention";
import type { CustomerStatus, CustomerSummary } from "@/types/customer";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;

// Code · Company · Contact · Email · Status · Needs attention · actions.
// This table declared NO minimum at all, so it shrank without limit and wrapped hardest of the lot —
// an address like "testmailforbuss001@gmail.com" needs ~210px on its own. Email steps aside on a
// narrow screen; it is a contact detail, not something the list is scanned by.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "normal", "wide", "narrow", "narrow", "narrow"]);
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
              {canEdit && canDelete && <div className="my-1 border-t border-[var(--border)]" />}
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
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Code</th>
            <th className="cell-y px-4">Company</th>
            <th className="cell-y px-4">Contact</th>
            <th className={`cell-y px-4 ${colClass("lg")}`}>Email</th>
            <th className="cell-y px-4">Status</th>
            <th className="cell-y px-4">Needs attention</th>
            {actions && <th className="cell-y px-4" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4"><Skeleton className="h-3 w-16" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-32" /></td>
              <td className="cell-y px-4"><Skeleton className="h-3 w-24" /></td>
              <td className={`cell-y px-4 ${colClass("lg")}`}><Skeleton className="h-3 w-40" /></td>
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

export function CustomersView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from URL — survive refresh and back-navigation.
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | CustomerStatus;
  const sort = (searchParams.get("sort") as Sort) ?? "newest";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local input state for the debounced search box.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() =>
    customerService.getCachedCustomers({ pageSize: PAGE_SIZE }),
  );
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);

  // Patch URL params, preserving any existing params (e.g. ?tab for panel-embedded views).
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

  // Each customer's own pending work. Server-filtered to the queues this actor may act on, so a user
  // who can approve submissions but not resend invites gets a column counting only submissions.
  const { rows: attention } = useEntityAttention("customer");

  // Debounce the search input into ?q in the URL.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  // Re-fetch on any query change. Cache-first (instant) then revalidate.
  // The filters WITHOUT paging — one definition, used by the list (which adds the page) and by the
  // CSV export (which must not). Two copies is how a download quietly stops matching the screen it
  // was taken from, and nothing about the resulting file looks wrong.
  const exportParams = React.useMemo(
    () => ({
      search: search || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      // "newest" is the server default → omit it so the cache key matches the initial seed
      // (getCachedCustomers({ pageSize })), which has no sort.
      sort: sort === "newest" ? undefined : sort,
    }),
    [search, statusFilter, sort],
  );

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { ...exportParams, page, pageSize: PAGE_SIZE };
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
  }, [exportParams, page, refreshKey]);

  const goToNew = () => router.push("/dashboard/customers/new");

  const customers = data?.customers ?? [];
  const showSkeleton = loading && customers.length === 0;
  const isFiltered = statusFilter !== "all" || Boolean(search);

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
      if (customers.length === 1 && page > 1) patch({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      {/* No page header here — CustomersPanel owns it, so it stays put while you switch tabs
          (same split as WarehousesView / SuppliersView). */}
      {/* Toolbar: search + filter + sort + add */}
      <div className={listToolbarCls}>
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, code, email or contact…"
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
          ]}
          ariaLabel="Sort"
        />
        {/* Before "New customer" and outside its ml-auto, so the primary action stays hard right. */}
        {can("customers.export") && (
          <ExportButton
            onExport={() => customerService.exportCustomersCsv(exportParams)}
            disabled={customers.length === 0}
            title="Export the filtered customers to CSV"
          />
        )}
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
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Code</th>
                  <th className="cell-y px-4">Company</th>
                  <th className="cell-y px-4">Contact</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Email</th>
                  <th className="cell-y px-4">Status</th>
                  {/* Stock submissions awaiting review and portal invites never accepted. Both are
                      worked on the customer's own page, so this row is the only way in — the module
                      chip bar that used to carry these numbers could only link back to this list. */}
                  <th className="cell-y px-4" title="Stock submissions to review and portal invites not yet accepted">
                    Needs attention
                  </th>
                  {showActions && <th className="cell-y px-4" />}
                </tr>
              </thead>
              <tbody>
                {customers.map((c: CustomerSummary) => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/dashboard/customers/${c.customerCode}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{c.customerCode}</td>
                    <td className={`cell-y px-4 font-semibold text-[var(--ink)] ${CELL_ONE_LINE}`} title={c.name}>{c.name}</td>
                    <td className="cell-y px-4 text-[var(--muted)]">{c.contactPerson ?? "—"}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE} ${colClass("lg")}`} title={c.email}>{c.email}</td>
                    <td className="cell-y px-4">
                      <StatusBadge status={c.status as UserStatus} />
                    </td>
                    <td className="cell-y px-4">
                      {attention[c.id] ? (
                        <EntityCountPill row={attention[c.id]} at={c.name} />
                      ) : (
                        <span className="text-[var(--faint)]">—</span>
                      )}
                    </td>
                    {showActions && (
                      <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
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
        {data && data.total > 0 && (
            <Pagination embedded
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              label="customers"
              onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)}
            />
        )}
      </div>

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
