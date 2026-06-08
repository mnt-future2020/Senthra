"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, Lock, Pencil, Plus, Search, Shield, Trash2, Users } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import * as roleService from "@/services/role.service";
import type { Role } from "@/types/role";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "./ConfirmDialog";
import { Pagination } from "./Pagination";

const PAGE_SIZE = 12;

// Skeleton mirrors the roles table so the layout doesn't shift on load.
function RolesTableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border-2)] text-left text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-5 py-3">Role</th>
            <th className="hidden px-5 py-3 sm:table-cell">Type</th>
            <th className="px-5 py-3">Users</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border-2)] last:border-0">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-2.5 w-44" />
                  </div>
                </div>
              </td>
              <td className="hidden px-5 py-3 sm:table-cell">
                <Skeleton className="h-4 w-14 rounded-full" />
              </td>
              <td className="px-5 py-3">
                <Skeleton className="h-3 w-8" />
              </td>
              <td className="px-5 py-3">
                <Skeleton className="ml-auto h-6 w-14 rounded-lg" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RolesView() {
  const { pushToast } = useDashboard();
  const { admin, can } = useAuth();
  const router = useRouter();
  const canCreate = can("roles.create");
  // Seed from the SWR cache so returning from a role form renders instantly.
  const cachedRoles = roleService.getCachedRoles();
  // A delegate can edit/delete only a role whose permissions are all within its
  // own (no managing a role more powerful than yourself); the super-admin can
  // manage any role. System roles are never deletable and are admin-only to edit.
  const manageable = (r: Role) => Boolean(admin) || r.permissions.every((p) => can(p));
  const editable = (r: Role) => (r.isSystem ? Boolean(admin) : can("roles.edit") && manageable(r));
  const deletable = (r: Role) => !r.isSystem && (Boolean(admin) || (can("roles.delete") && manageable(r)));

  const [roles, setRoles] = React.useState<Role[]>(cachedRoles ?? []);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; role: Role | null }>({
    open: false,
    role: null,
  });
  const [deleting, setDeleting] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<"newest" | "oldest" | "name">("name");

  const load = React.useCallback(async () => {
    try {
      setRoles(await roleService.listRoles());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load roles.");
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const doDelete = async () => {
    if (!confirm.role) return;
    setDeleting(true);
    try {
      await roleService.deleteRole(confirm.role.id);
      setConfirm({ open: false, role: null });
      // Removing a role can drop the page count — clamp the current page so the
      // pagination controls don't end up on a stale, out-of-range page.
      const newTotalPages = Math.max(1, Math.ceil((roles.length - 1) / PAGE_SIZE));
      setPage((p) => Math.min(p, newTotalPages));
      await load();
      pushToast("Role deleted.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  // Roles are bounded master-data — load all once, then filter + paginate on the
  // client to keep it compact as it grows.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? roles.filter(
        (r) =>
          r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
      )
    : roles;
  // Sort client-side (ISO createdAt strings compare chronologically).
  const sorted = [...filtered].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "oldest"
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRoles = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-extrabold text-[var(--ink)]">Roles</h3>
          <p className="text-xs text-[var(--muted)]">
            Roles you can assign to users. Built-in roles can&apos;t be deleted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search roles…"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as "newest" | "oldest" | "name");
              setPage(1);
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            title="Sort"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name (A–Z)</option>
          </select>
          {canCreate && (
            <button
              onClick={() => router.push("/dashboard/roles/new")}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Plus className="h-4 w-4" /> Add role
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading && roles.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <RolesTableSkeleton />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm text-[var(--neg)]">
            {error}
          </div>
        ) : roles.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Shield className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No roles yet</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Add your first role to get started.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Search className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No roles match</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Try a different search.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border-2)] text-left text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-5 py-3">Role</th>
                  <th className="hidden px-5 py-3 sm:table-cell">Type</th>
                  <th className="px-5 py-3">Users</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRoles.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-[var(--border-2)] last:border-0 transition-colors hover:bg-[var(--surface-2)]/50"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-10)] text-[var(--accent)]">
                          <Shield className="h-4.5 w-4.5" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-bold text-[var(--ink)]">{r.name}</p>
                          <p
                            className="truncate text-xs text-[var(--muted)]"
                            title={r.description ?? undefined}
                          >
                            {r.description || "No description."}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-5 py-3 sm:table-cell">
                      {r.isSystem ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                          <Lock className="h-2.5 w-2.5" />
                          System
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-[var(--accent)]/30 bg-[var(--accent-10)] px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
                          Custom
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]">
                        <Users className="h-3.5 w-3.5 text-[var(--faint)]" />
                        {r.userCount}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => router.push(`/dashboard/roles/${r.key}`)}
                          className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
                          title="View role"
                          aria-label="View role"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        {editable(r) && (
                          <button
                            onClick={() => router.push(`/dashboard/roles/${r.key}/edit`)}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
                            title="Edit role"
                            aria-label="Edit role"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {deletable(r) && (
                          <button
                            onClick={() => setConfirm({ open: true, role: r })}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                            title="Delete role"
                            aria-label="Delete role"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && !error && filtered.length > 0 && (
        <div className="shrink-0">
          <Pagination
            page={safePage}
            totalPages={totalPages}
            total={filtered.length}
            label="roles"
            onPage={setPage}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        danger
        busy={deleting}
        title="Delete role"
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm.role?.name}</strong>? This
            can&apos;t be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirm({ open: false, role: null })}
      />
    </div>
  );
}
