"use client";

import * as React from "react";
import { Check, Layers, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import * as irmTypeService from "@/services/irm-type.service";
import type { IrmType } from "@/types/irm-type";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls } from "@/components/ui/styles";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";

const PAGE_SIZE = 12;

// Settings → IRM Types: the item-type classification master. IRM items pick a type from
// here; an in-use type can't be deleted. Mirrors the Supplier Types settings screen.
export function IrmTypesView() {
  const { pushToast } = useDashboard();
  const { can } = useAuth();
  const canCreate = can("irm_types.create");
  const canEdit = can("irm_types.edit");
  const canDelete = can("irm_types.delete");

  const [types, setTypes] = React.useState<IrmType[]>(() => irmTypeService.getCachedIrmTypes() ?? []);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [sort, setSort] = React.useState<"newest" | "oldest" | "name">("name");

  const [newName, setNewName] = React.useState("");
  const [newDescription, setNewDescription] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [savingEdit, setSavingEdit] = React.useState(false);

  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  const [confirm, setConfirm] = React.useState<{ open: boolean; type: IrmType | null }>({ open: false, type: null });
  const [deleting, setDeleting] = React.useState(false);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? types.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
    : types;
  const sorted = [...filtered].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "oldest"
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageTypes = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const load = React.useCallback(async () => {
    try {
      setTypes(await irmTypeService.listIrmTypes());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load IRM types.");
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
      await irmTypeService.createIrmType({ name, description: newDescription.trim() || undefined });
      setNewName("");
      setNewDescription("");
      await load();
      pushToast("IRM type added.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not add IRM type.", "alert");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (t: IrmType) => {
    setEditingId(t.id);
    setEditName(t.name);
    setEditDescription(t.description ?? "");
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
      await irmTypeService.updateIrmType(id, { name, description: editDescription.trim() });
      cancelEdit();
      await load();
      pushToast("IRM type updated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update IRM type.", "alert");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleStatus = async (t: IrmType) => {
    if (togglingId) return;
    setTogglingId(t.id);
    const next = t.status === "active" ? "inactive" : "active";
    try {
      await irmTypeService.updateIrmType(t.id, { status: next });
      await load();
      pushToast(next === "active" ? "Type activated." : "Type deactivated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update status.", "alert");
    } finally {
      setTogglingId(null);
    }
  };

  const doDelete = async () => {
    if (!confirm.type) return;
    setDeleting(true);
    try {
      await irmTypeService.deleteIrmType(confirm.type.id);
      setConfirm({ open: false, type: null });
      const newTotalPages = Math.max(1, Math.ceil((filtered.length - 1) / PAGE_SIZE));
      setPage((p) => Math.min(p, newTotalPages));
      await load();
      pushToast("IRM type deleted.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-extrabold text-[var(--ink)]">IRM Types</h3>
            <p className="text-xs text-[var(--muted)]">
              The item-type classification list. IRM items pick a type from here.
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
                placeholder="Search types…"
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
              placeholder="New IRM type name"
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading && types.length === 0 ? (
          <div className="min-h-0 flex-1 space-y-px overflow-auto">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm text-[var(--neg)]">{error}</div>
        ) : types.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Layers className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No IRM types yet</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {canCreate ? "Add your first type above." : "Ask an administrator to add one."}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
            <Search className="mb-3 h-10 w-10 text-[var(--faint)]" />
            <p className="font-extrabold text-[var(--ink)]">No types match</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Try a different search.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <ul>
              {pageTypes.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 border-b border-[var(--border-2)] px-5 py-3 last:border-0 transition-colors hover:bg-[var(--surface-2)]/50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-10)] text-[var(--accent)]">
                    <Layers className="h-4 w-4" />
                  </span>

                  {editingId === t.id ? (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void saveEdit(t.id);
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
                              void saveEdit(t.id);
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
                        onClick={() => void saveEdit(t.id)}
                        disabled={savingEdit || !editName.trim()}
                        className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--pos)] disabled:opacity-60"
                        title="Save"
                        aria-label="Save"
                      >
                        {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
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
                        <div className="truncate text-sm font-bold text-[var(--ink)]">{t.name}</div>
                        {t.description && <div className="truncate text-xs text-[var(--muted)]">{t.description}</div>}
                      </div>
                      <span className="shrink-0 text-[11px] text-[var(--faint)]">
                        {t.itemCount} item{t.itemCount === 1 ? "" : "s"}
                      </span>
                      <button
                        onClick={() => canEdit && void toggleStatus(t)}
                        disabled={!canEdit || togglingId === t.id}
                        title={canEdit ? "Toggle status" : undefined}
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold transition-colors ${
                          t.status === "active" ? "bg-[var(--pos)]/15 text-[var(--pos)]" : "bg-[var(--faint)]/15 text-[var(--faint)]"
                        } ${canEdit ? "cursor-pointer hover:opacity-80" : "cursor-default"} disabled:opacity-60`}
                      >
                        {togglingId === t.id ? "…" : t.status === "active" ? "Active" : "Inactive"}
                      </button>
                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <button
                            onClick={() => startEdit(t)}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
                            title="Edit type"
                            aria-label="Edit type"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setConfirm({ open: true, type: t })}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                            title="Delete type"
                            aria-label="Delete type"
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
          <Pagination page={safePage} totalPages={totalPages} total={filtered.length} label="IRM types" onPage={setPage} />
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        danger
        busy={deleting}
        title="Delete IRM type"
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm.type?.name}</strong>? A type in use by
            items can&apos;t be deleted.
          </>
        }
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirm({ open: false, type: null })}
      />
    </div>
  );
}
