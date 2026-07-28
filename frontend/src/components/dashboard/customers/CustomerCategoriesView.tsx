"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Loader2, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import * as categoryService from "@/services/category.service";
import type { Category } from "@/types/category";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls } from "@/components/ui/styles";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";

const PAGE_SIZE = 12;

// Customers → Categories: the master list that classifies CUSTOMER-submitted stock entries.
// An in-use category can't be deleted (the API guards it).
//
// This is NOT the IRM catalogue's classification — that's the separate IRM Categories master under
// the Inventory Hub. Naming them both "categories" has caused real confusion, so every label here
// says "customer stock". It lives in the Customers module (not Settings) because that's where the
// convention puts domain master-data: beside the module that owns it, like Warehouses → Types and
// Suppliers → Types.
export function CustomerCategoriesView() {
  const { pushToast } = useDashboard();
  const { can } = useAuth();
  const canCreate = can("categories.create");
  const canEdit = can("categories.edit");
  const canDelete = can("categories.delete");

  const router = useRouter();
  const searchParams = useSearchParams();

  // Filters derived from URL — survive refresh and back/forward navigation.
  const search = searchParams.get("q") ?? "";
  const sort = (searchParams.get("sort") as "newest" | "oldest" | "name") ?? "name";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Preserves all existing params (incl. the panel's ?tab) and uses the current
  // pathname. Filter changes reset to page 1 unless resetPage=false.
  const patch = (updates: Record<string, string | null>, resetPage = true) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    if (resetPage) params.delete("page");
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  };

  // Seed from the SWR cache so returning to this tab renders instantly.
  const [categories, setCategories] = React.useState<Category[]>(
    () => categoryService.getCachedCategories() ?? [],
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [newName, setNewName] = React.useState("");
  const [newDescription, setNewDescription] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [savingEdit, setSavingEdit] = React.useState(false);

  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  const [confirm, setConfirm] = React.useState<{ open: boolean; category: Category | null }>({
    open: false,
    category: null,
  });
  const [deleting, setDeleting] = React.useState(false);

  // Bounded master-data — load all once, then filter + paginate on the client.
  const { filtered, totalPages, safePage, pageCategories } = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? categories.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.description ?? "").toLowerCase().includes(q),
        )
      : categories;
    const sorted = [...filtered].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "oldest"
          ? a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt),
    );
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const pageCategories = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
    return { filtered, totalPages, safePage, pageCategories };
  }, [categories, search, sort, page]);

  const load = React.useCallback(async () => {
    try {
      setCategories(await categoryService.listCategories());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load categories.");
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
      await categoryService.createCategory({
        name,
        description: newDescription.trim() || undefined,
      });
      setNewName("");
      setNewDescription("");
      await load();
      pushToast("Category added.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not add category.", "alert");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (c: Category) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditDescription(c.description ?? "");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
  };
  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name || savingEdit) return;
    setSavingEdit(true);
    try {
      await categoryService.updateCategory(id, {
        // Send the trimmed string (not undefined) so clearing it reaches the API as
        // "" — the service turns that into null. undefined would be dropped by axios
        // and the old description would persist.
        name,
        description: editDescription.trim(),
      });
      cancelEdit();
      await load();
      pushToast("Category updated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update category.", "alert");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleStatus = async (c: Category) => {
    if (togglingId) return;
    setTogglingId(c.id);
    const next = c.status === "active" ? "inactive" : "active";
    try {
      await categoryService.updateCategory(c.id, { status: next });
      await load();
      pushToast(next === "active" ? "Category activated." : "Category deactivated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update status.", "alert");
    } finally {
      setTogglingId(null);
    }
  };

  const doDelete = async () => {
    if (!confirm.category) return;
    setDeleting(true);
    try {
      await categoryService.deleteCategory(confirm.category.id);
      setConfirm({ open: false, category: null });
      const newTotalPages = Math.max(1, Math.ceil((filtered.length - 1) / PAGE_SIZE));
      const clampedPage = Math.min(page, newTotalPages);
      if (clampedPage !== page) patch({ page: clampedPage > 1 ? String(clampedPage) : null }, false);
      await load();
      pushToast("Category deleted.", "success");
    } catch (e) {
      // Surfaces the API's in-use guard ("used by N item(s)…") verbatim.
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
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Customer Stock Categories</h3>
            <p className="text-xs text-[var(--muted)]">
              Classifies stock customers submit to us. Not the IRM catalogue — that has its own
              categories under Inventory.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
              <input
                value={search}
                onChange={(e) => patch({ q: e.target.value || null })}
                placeholder="Search categories…"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
              />
            </div>
            <Select
              size="sm"
              value={sort}
              onChange={(v) => patch({ sort: v === "name" ? null : v })}
              options={[
                { value: "newest", label: "Newest" },
                { value: "oldest", label: "Oldest" },
                { value: "name", label: "Name (A–Z)" },
              ]}
              ariaLabel="Sort"
            />
          </div>
        </div>
        {canCreate && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="New category name"
              maxLength={60}
              className={inputCls}
            />
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="Description (optional)"
              maxLength={300}
              className={inputCls}
            />
            <button
              onClick={() => void add()}
              disabled={adding || !newName.trim()}
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading && categories.length === 0 ? (
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
        ) : categories.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Tag className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No categories yet</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {canCreate ? "Add your first category above." : "Ask an administrator to add one."}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Search className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No categories match</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Try a different search.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <ul>
              {pageCategories.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-[var(--border-2)] px-5 py-3 last:border-0 transition-colors hover:bg-[var(--surface-2)]/50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-10)] text-[var(--accent)]">
                    <Tag className="h-4 w-4" />
                  </span>

                  {editingId === c.id ? (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void saveEdit(c.id);
                            } else if (e.key === "Escape") {
                              cancelEdit();
                            }
                          }}
                          maxLength={60}
                          placeholder="Name"
                          className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void saveEdit(c.id);
                            } else if (e.key === "Escape") {
                              cancelEdit();
                            }
                          }}
                          maxLength={300}
                          placeholder="Description (optional)"
                          className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--muted)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <button
                        onClick={() => void saveEdit(c.id)}
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
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-[var(--ink)]">{c.name}</div>
                        {c.description && (
                          <div className="truncate text-xs text-[var(--muted)]">{c.description}</div>
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] text-[var(--faint)]">
                        {c.itemCount} item{c.itemCount === 1 ? "" : "s"}
                      </span>
                      <button
                        onClick={() => canEdit && void toggleStatus(c)}
                        disabled={!canEdit || togglingId === c.id}
                        title={canEdit ? "Toggle status" : undefined}
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold transition-colors ${
                          c.status === "active"
                            ? "bg-[var(--pos)]/15 text-[var(--pos)]"
                            : "bg-[var(--faint)]/15 text-[var(--faint)]"
                        } ${canEdit ? "cursor-pointer hover:opacity-80" : "cursor-default"} disabled:opacity-60`}
                      >
                        {togglingId === c.id ? "…" : c.status === "active" ? "Active" : "Inactive"}
                      </button>
                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <button
                            onClick={() => startEdit(c)}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
                            title="Edit category"
                            aria-label="Edit category"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setConfirm({ open: true, category: c })}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                            title="Delete category"
                            aria-label="Delete category"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {!canEdit && !canDelete && <span className="text-xs text-[var(--faint)]">—</span>}
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
            label="categories"
            onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        danger
        busy={deleting}
        title="Delete category"
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm.category?.name}</strong>? A category
            in use by stock entries can&apos;t be deleted.
          </>
        }
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirm({ open: false, category: null })}
      />
    </div>
  );
}
