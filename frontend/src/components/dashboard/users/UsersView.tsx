"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Ban,
  Check,
  CheckCircle2,
  Copy,
  MoreHorizontal,
  Pencil,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import * as roleService from "@/services/role.service";
import * as userService from "@/services/user.service";
import type { Role } from "@/types/role";
import type { User, UserStatus } from "@/types/user";
import { Skeleton } from "@/components/ui/skeleton";
import { ghostBtn, labelCls, primaryBtn } from "@/components/dashboard/settings/ui/styles";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Pagination } from "./Pagination";
import { StatusBadge } from "./StatusBadge";
import { UserFormModal } from "./UserFormModal";

const PAGE_SIZE = 20;

function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ElementType;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] ${
        danger ? "text-[var(--neg)]" : "text-[var(--ink)]"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function RowActions({
  user,
  onEdit,
  onToggleStatus,
  onResend,
  onDelete,
}: {
  user: User;
  onEdit: () => void;
  onToggleStatus: () => void;
  onResend: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const activate = user.status !== "active";

  // Anchor the menu to the button and render it in a portal (fixed) so the
  // table's horizontal-scroll container can't clip it. Flip above the button
  // when there isn't room below.
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPos(
      spaceBelow < 220
        ? { bottom: window.innerHeight - rect.top + 4, right }
        : { top: rect.bottom + 4, right },
    );
    setOpen(true);
  };

  // The captured position would go stale on scroll/resize — close instead.
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => close();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  return (
    <div className="flex justify-end">
      <button
        ref={btnRef}
        onClick={() => (open ? close() : openMenu())}
        className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        aria-label="Actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={close} />
            <div
              className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>
                Edit
              </MenuItem>
              <MenuItem
                icon={activate ? CheckCircle2 : Ban}
                onClick={() => { close(); onToggleStatus(); }}
              >
                {activate ? "Activate" : "Suspend"}
              </MenuItem>
              <MenuItem icon={Send} onClick={() => { close(); onResend(); }}>
                Resend invite
              </MenuItem>
              <div className="my-1 border-t border-[var(--border-2)]" />
              <MenuItem icon={Trash2} danger onClick={() => { close(); onDelete(); }}>
                Delete
              </MenuItem>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function TempPasswordModal({
  open,
  email,
  password,
  isResend,
  onClose,
}: {
  open: boolean;
  email: string;
  password: string;
  isResend: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable — the value is visible to copy manually
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={isResend ? "Invite re-sent" : "User created"}
      subtitle={email}
      footer={
        <button onClick={onClose} className={primaryBtn}>
          Done
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          An account email has been sent to{" "}
          <strong className="text-[var(--ink)]">{email}</strong>. You can share the
          temporary password securely if needed — it won&apos;t be shown again.
        </p>
        <div>
          <label className={labelCls}>Temporary password</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 font-mono text-sm text-[var(--ink)]">
              {password}
            </code>
            <button onClick={copy} className={ghostBtn}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Skeleton mirrors the real table layout so the page doesn't shift on load.
function UsersTableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border-2)] text-left text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-5 py-3">User</th>
            <th className="px-5 py-3">Role</th>
            <th className="px-5 py-3">Status</th>
            <th className="hidden px-5 py-3 md:table-cell">Added</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border-2)] last:border-0">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-2.5 w-40" />
                  </div>
                </div>
              </td>
              <td className="px-5 py-3">
                <Skeleton className="h-5 w-20 rounded-md" />
              </td>
              <td className="px-5 py-3">
                <Skeleton className="h-5 w-16 rounded-full" />
              </td>
              <td className="hidden px-5 py-3 md:table-cell">
                <Skeleton className="h-3 w-16" />
              </td>
              <td className="px-5 py-3">
                <Skeleton className="ml-auto h-6 w-6 rounded-lg" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsersView() {
  const { pushToast } = useDashboard();

  const [users, setUsers] = React.useState<User[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | UserStatus>("all");
  const [roleFilter, setRoleFilter] = React.useState<string>("all");
  const [refreshKey, setRefreshKey] = React.useState(0);

  const [form, setForm] = React.useState<{ open: boolean; mode: "create" | "edit"; user: User | null }>({
    open: false,
    mode: "create",
    user: null,
  });
  const [confirm, setConfirm] = React.useState<{ open: boolean; user: User | null }>({
    open: false,
    user: null,
  });
  const [deleting, setDeleting] = React.useState(false);
  const [tempPw, setTempPw] = React.useState<{ open: boolean; email: string; password: string; isResend: boolean }>({
    open: false,
    email: "",
    password: "",
    isResend: false,
  });

  // Roles power the filter dropdown + the create/edit form (full list — bounded).
  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await roleService.listRoles();
        if (active) setRoles(r);
      } catch {
        // non-fatal — the filter/dropdown just stays empty
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch the current page from the server whenever the page, a filter or a
  // refresh trigger changes. setState lives inside the async IIFE (not the
  // effect body) so it isn't a synchronous setState-in-effect.
  React.useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await userService.listUsers({
          page,
          pageSize: PAGE_SIZE,
          search: debouncedSearch || undefined,
          status: statusFilter === "all" ? undefined : statusFilter,
          roleId: roleFilter === "all" ? undefined : roleFilter,
        });
        if (!active) return;
        setUsers(res.users);
        setTotal(res.total);
        setTotalPages(res.totalPages);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load users.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, debouncedSearch, statusFilter, roleFilter, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  // Filter/search changes reset to page 1 (in handlers, not an effect).
  const onSearchChange = (v: string) => {
    setSearch(v);
    setPage(1);
  };
  const onStatusChange = (v: "all" | UserStatus) => {
    setStatusFilter(v);
    setPage(1);
  };
  const onRoleChange = (v: string) => {
    setRoleFilter(v);
    setPage(1);
  };

  const handleSaved = (result: { user: User; temporaryPassword?: string }) => {
    setForm({ open: false, mode: "create", user: null });
    if (result.temporaryPassword) {
      setPage(1); // a new user sorts to the top
      refresh();
      setTempPw({
        open: true,
        email: result.user.email,
        password: result.temporaryPassword,
        isResend: false,
      });
    } else {
      refresh();
      pushToast("User updated.", "success");
    }
  };

  const toggleStatus = async (user: User) => {
    const next: UserStatus = user.status === "active" ? "suspended" : "active";
    try {
      await userService.setUserStatus(user.id, next);
      refresh();
      pushToast(`${user.firstName} ${next === "active" ? "activated" : "suspended"}.`, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    }
  };

  const resend = async (user: User) => {
    try {
      const { temporaryPassword } = await userService.resendInvite(user.id);
      setTempPw({ open: true, email: user.email, password: temporaryPassword, isResend: true });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not resend invite.", "alert");
    }
  };

  const doDelete = async () => {
    if (!confirm.user) return;
    setDeleting(true);
    try {
      await userService.deleteUser(confirm.user.id);
      setConfirm({ open: false, user: null });
      // Step back a page if we just removed the only row on a later page.
      if (users.length === 1 && page > 1) setPage(page - 1);
      else refresh();
      pushToast("User removed.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  const showSkeleton = loading && users.length === 0;
  const hasFilters =
    Boolean(debouncedSearch) || statusFilter !== "all" || roleFilter !== "all";

  return (
    <div className="flex h-full flex-col gap-5">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, email, role…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as "all" | UserStatus)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
        </select>
        <select
          value={roleFilter}
          onChange={(e) => onRoleChange(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        >
          <option value="all">All roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setForm({ open: true, mode: "create", user: null })}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 sm:ml-auto"
        >
          <UserPlus className="h-4 w-4" /> Add user
        </button>
      </div>

      {/* Table */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {showSkeleton ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <UsersTableSkeleton />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm text-[var(--neg)]">
            {error}
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Users className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No users found</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {hasFilters
                ? "Try adjusting your search or filters."
                : "Add your first user to get started."}
            </p>
          </div>
        ) : (
          <div
            className={`min-h-0 flex-1 overflow-auto transition-opacity ${
              loading ? "pointer-events-none opacity-60" : ""
            }`}
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border-2)] text-left text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-5 py-3">User</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="hidden px-5 py-3 md:table-cell">Added</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[var(--border-2)] last:border-0 transition-colors hover:bg-[var(--surface-2)]/50"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar
                          url={u.profileImageUrl}
                          firstName={u.firstName}
                          lastName={u.lastName}
                          size={36}
                        />
                        <div className="min-w-0">
                          <p className="truncate font-bold text-[var(--ink)]">
                            {u.firstName} {u.lastName}
                          </p>
                          <p className="truncate text-xs text-[var(--muted)]">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {u.role ? (
                        <span className="inline-flex items-center rounded-md border border-[var(--accent-10)] bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
                          {u.role.name}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--faint)]">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="hidden px-5 py-3 text-xs text-[var(--muted)] md:table-cell">
                      {new Date(u.createdAt).toLocaleDateString("en-GB")}
                    </td>
                    <td className="px-5 py-3">
                      <RowActions
                        user={u}
                        onEdit={() => setForm({ open: true, mode: "edit", user: u })}
                        onToggleStatus={() => toggleStatus(u)}
                        onResend={() => resend(u)}
                        onDelete={() => setConfirm({ open: true, user: u })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!showSkeleton && !error && total > 0 && (
        <div className="shrink-0">
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            label="users"
            onPage={setPage}
          />
        </div>
      )}

      {form.open && (
        <UserFormModal
          mode={form.mode}
          user={form.user}
          roles={roles}
          onClose={() => setForm({ open: false, mode: "create", user: null })}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={confirm.open}
        danger
        busy={deleting}
        title="Remove user"
        message={
          <>
            Remove <strong className="text-[var(--ink)]">{confirm.user?.firstName} {confirm.user?.lastName}</strong>? They&apos;ll be soft-deleted and can be restored from the database if needed.
          </>
        }
        confirmLabel="Remove"
        onConfirm={doDelete}
        onClose={() => setConfirm({ open: false, user: null })}
      />

      <TempPasswordModal
        open={tempPw.open}
        email={tempPw.email}
        password={tempPw.password}
        isResend={tempPw.isResend}
        onClose={() => setTempPw((s) => ({ ...s, open: false }))}
      />
    </div>
  );
}
