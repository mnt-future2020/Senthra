"use client";

import * as React from "react";
import { Building2, Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import * as departmentService from "@/services/department.service";
import type { Department } from "@/types/department";
import { Skeleton } from "@/components/ui/skeleton";
import { inputCls } from "@/components/dashboard/settings/ui/styles";
import { ConfirmDialog } from "./ConfirmDialog";
import { Pagination } from "./Pagination";

const PAGE_SIZE = 12;

export function DepartmentsView() {
  const { pushToast } = useDashboard();
  const { can } = useAuth();
  // Departments are employee master-data, so they reuse the user permissions.
  const canCreate = can("users.create") || can("users.edit");
  const canEdit = can("users.edit");
  const canDelete = can("users.delete");

  // Seed from the SWR cache so returning to this tab renders instantly.
  const [departments, setDepartments] = React.useState<Department[]>(
    () => departmentService.getCachedDepartments() ?? [],
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [sort, setSort] = React.useState<"newest" | "oldest" | "name">("name");

  const [newName, setNewName] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [savingEdit, setSavingEdit] = React.useState(false);

  const [confirm, setConfirm] = React.useState<{ open: boolean; dept: Department | null }>({
    open: false,
    dept: null,
  });
  const [deleting, setDeleting] = React.useState(false);

  // Departments are bounded master-data — load all once, then filter + paginate on
  // the client (alphabetical from the API) to keep the list compact as it grows.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? departments.filter((d) => d.name.toLowerCase().includes(q))
    : departments;
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
  const pageDepts = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const load = React.useCallback(async () => {
    try {
      setDepartments(await departmentService.listDepartments());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load departments.");
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const add = async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      await departmentService.createDepartment(name);
      setNewName("");
      await load();
      pushToast("Department added.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not add department.", "alert");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (d: Department) => {
    setEditingId(d.id);
    setEditName(d.name);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };
  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name || savingEdit) return;
    setSavingEdit(true);
    try {
      await departmentService.updateDepartment(id, name);
      cancelEdit();
      await load();
      pushToast("Department renamed.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not rename department.", "alert");
    } finally {
      setSavingEdit(false);
    }
  };

  const doDelete = async () => {
    if (!confirm.dept) return;
    setDeleting(true);
    try {
      await departmentService.deleteDepartment(confirm.dept.id);
      setConfirm({ open: false, dept: null });
      // Stepping back a page if we removed the last row on a later page.
      const newTotalPages = Math.max(1, Math.ceil((filtered.length - 1) / PAGE_SIZE));
      setPage((p) => Math.min(p, newTotalPages));
      await load();
      pushToast("Department deleted.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      {/* Header + search + inline add */}
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Departments</h3>
            <p className="text-xs text-[var(--muted)]">
              The teams you can assign staff to. These power the Department picker on the user form.
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
                placeholder="Search departments…"
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
          </div>
        </div>
        {canCreate && (
          <div className="mt-3 flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="New department name"
              maxLength={60}
              className={inputCls}
            />
            <button
              onClick={() => void add()}
              disabled={adding || !newName.trim()}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading && departments.length === 0 ? (
          <div className="min-h-0 flex-1 space-y-px overflow-auto">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm text-[var(--neg)]">
            {error}
          </div>
        ) : departments.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Building2 className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No departments yet</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {canCreate ? "Add your first department above." : "Ask an administrator to add one."}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Search className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No departments match</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Try a different search.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <ul>
              {pageDepts.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-3 border-b border-[var(--border-2)] px-5 py-3 last:border-0 transition-colors hover:bg-[var(--surface-2)]/50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-10)] text-[var(--accent)]">
                    <Building2 className="h-4 w-4" />
                  </span>

                  {editingId === d.id ? (
                    <>
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveEdit(d.id);
                          } else if (e.key === "Escape") {
                            cancelEdit();
                          }
                        }}
                        maxLength={60}
                        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        onClick={() => void saveEdit(d.id)}
                        disabled={savingEdit || !editName.trim()}
                        className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--pos)] disabled:opacity-60"
                        title="Save"
                        aria-label="Save"
                      >
                        {savingEdit ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                        title="Cancel"
                        aria-label="Cancel"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-bold text-[var(--ink)]">
                        {d.name}
                      </span>
                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <button
                            onClick={() => startEdit(d)}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
                            title="Rename department"
                            aria-label="Rename department"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setConfirm({ open: true, dept: d })}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                            title="Delete department"
                            aria-label="Delete department"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {!canEdit && !canDelete && (
                          <span className="text-xs text-[var(--faint)]">—</span>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!loading && !error && filtered.length > 0 && (
        <div className="shrink-0">
          <Pagination
            page={safePage}
            totalPages={totalPages}
            total={filtered.length}
            label="departments"
            onPage={setPage}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        danger
        busy={deleting}
        title="Delete department"
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm.dept?.name}</strong>? Staff already
            assigned to it keep the name on their profile; it just won&apos;t appear in the picker.
          </>
        }
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirm({ open: false, dept: null })}
      />
    </div>
  );
}
