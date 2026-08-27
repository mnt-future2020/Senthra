"use client";

import * as React from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Package, Pencil, Plus, Power, Search, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import * as rentalService from "@/services/rental.service";
import type { RentalCategory, RentalItem } from "@/types/rental";
import type { UserStatus } from "@/types/user";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ExportButton } from "@/components/ui/ExportButton";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { toolbarInputCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { nextRentalStatus, rentalRowActions } from "./rentalRowActions";

const PAGE_SIZE = 20;

// Code · Name · Category · Unit · Status · actions. Declared per column rather than one flat minimum
// so a long item name scrolls the table sideways instead of wrapping to a second line — a wrapped row
// is ~27px taller, paid once PER ROW, which costs far more of a 1024px laptop than any band above the
// table. The actions cell holds one 28px button, so it asks for the smallest class there is.
const TABLE_MIN_WIDTH = tableMinWidth(["narrow", "wide", "normal", "narrow", "narrow", "narrow"]);

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

/**
 * The "…" menu on a catalogue row.
 *
 * Mechanically the same control as IrmItemsView's — portalled to <body> so the table's own
 * `overflow-auto` cannot clip it, flipped above the trigger when there is no room below, dismissed on
 * Escape / scroll / resize / outside click, and returning focus to the trigger when it closes.
 *
 * A copy rather than a shared component ON PURPOSE: nine other lists in this app each carry their own
 * (`SupplierRowActions`, `WarehouseRowActions`, `IrmRowActions`, …) and lifting all ten into
 * `components/ui/` is a refactor of nine screens this change has no business touching. When that
 * extraction happens it should take this one with it.
 *
 * WHICH entries appear is not decided here — see rentalRowActions.ts, which is testable without a DOM.
 */
function RentalRowActions({
  item,
  canEdit,
  canDelete,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  item: RentalItem;
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
    // Focus the first entry on open, so the menu is operable from the keyboard alone.
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const actions = rentalRowActions({ status: item.status, canEdit, canDelete });
  if (actions.length === 0) return null;

  const run = { edit: onEdit, "toggle-status": onToggleStatus, delete: onDelete } as const;
  const icons = { edit: Pencil, "toggle-status": Power, delete: Trash2 } as const;

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
        aria-label={`Actions for ${item.code}`}
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
              aria-label="Rental item actions"
              className="anim-fade-in fixed z-[60] w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {actions.map((a, idx) => (
                <React.Fragment key={a.key}>
                  {/* Delete sits behind a divider — the destructive entry should not be the immediate
                      neighbour of the one above it in a menu people click quickly. */}
                  {a.danger && idx > 0 && <div className="my-1 border-t border-[var(--border-2)]" />}
                  <MenuItem
                    icon={icons[a.key]}
                    danger={a.danger}
                    onClick={() => {
                      close();
                      run[a.key]();
                    }}
                  >
                    {a.label}
                  </MenuItem>
                </React.Fragment>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/**
 * Rentals → Catalogue: the master list of equipment the company hires.
 *
 * Deliberately narrower than the IRM catalogue — a hire has no stock level, no reorder policy and
 * no barcode. It carries no PRICE either: what a hire costs is agreed per request, so the figure
 * lives on the PRF rental line rather than as a rate card here.
 */
export function RentalItemsView() {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();

  const search = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  const categoryId = searchParams.get("category") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // useCallback so the debounce effect below can depend on it without re-arming on every render.
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

  /**
   * The search box is typed into locally and pushed to the URL on a delay.
   *
   * Bound straight to `?q` it dropped characters: every keystroke was a `router.replace` plus a
   * refetch, and because `searchParams` only updates after the transition, React re-rendered the
   * controlled input with the STALE value — so typing at normal speed lost letters and jumped the
   * caret. The three sibling registers (OnHireView, HireMovementsView, HireExtensionsView) all carry
   * this same guard; the catalogue was the one that did not.
   */
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seeded during render when ?q changes outside typing (browser back/forward) — the
  // React-recommended pattern, and no cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  React.useEffect(() => {
    const t = setTimeout(() => {
      // Only when the box actually diverges from the URL, so a deep-linked ?page survives mount and
      // browser back/forward (patch defaults to resetPage, which would drop it).
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  const [items, setItems] = React.useState<RentalItem[]>([]);
  const [categories, setCategories] = React.useState<RentalCategory[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped after a row mutation so the SAME filters refetch — the list effect keys on the filters,
  // which have not changed, so without this the row keeps its stale badge until the next navigation.
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [confirm, setConfirm] = React.useState<{ open: boolean; item: RentalItem | null }>({ open: false, item: null });
  const [deleting, setDeleting] = React.useState(false);

  const canEdit = can("rentals.edit");
  const canDelete = can("rentals.delete");
  // The whole column goes when a viewer can do neither — an empty cell on every row is a column's
  // worth of width spent on nothing, and this table is already six columns wide.
  const showActions = canEdit || canDelete;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await rentalService.listRentalItems({
          search: search || undefined,
          status: status || undefined,
          categoryId: categoryId || undefined,
          page,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load rental items.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search, status, categoryId, page, refreshKey]);

  // The category filter is a convenience, not a gate: a failure here leaves the dropdown empty
  // rather than blocking the list the user came for.
  React.useEffect(() => {
    rentalService
      .listRentalCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /**
   * Retire an item, or bring it back.
   *
   * A STATUS-ONLY PATCH, and that is the point of doing it here rather than routing the user through
   * the edit form. `/rental-items/:id` takes `createRentalItemSchema.partial()`, so every field the
   * body omits is left exactly as the server has it. Sending the row's other values back — the shape
   * the edit form uses, because it has actually collected them — would make this control capable of
   * silently reverting a name or a category that someone else changed since this page was loaded.
   * The row in `items` is a snapshot from the last fetch; it is not authority on anything.
   *
   * Everything else about the change stays where it already lives: the service records
   * `rental_item.updated` for the audit trail, and an inactive item is still refused at PRF→PO
   * conversion by `requireActiveRentalItems`. Nothing here re-implements either.
   */
  const toggleStatus = async (item: RentalItem) => {
    const next = nextRentalStatus(item.status);
    try {
      await rentalService.updateRentalItem(item.id, { status: next });
      pushToast(next === "inactive" ? "Rental item deactivated." : "Rental item activated.", "success");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the rental item.", "alert");
    }
  };

  /**
   * Same call, same guards and same failure wording as the detail page's Delete.
   *
   * The server refuses while any purchase request, purchase order, job kit list or engineer-held hire
   * still references the item, and its 409 names WHICH — so the message is surfaced as-is. Mirroring
   * that rule on the client would give us a second copy to keep in step with
   * DELETE_DEPENDENCY_CHECKERS, and the copy that drifts is always the one that lets a delete through.
   */
  const onDelete = async () => {
    if (!confirm.item || deleting) return;
    setDeleting(true);
    try {
      await rentalService.deleteRentalItem(confirm.item.id);
      setConfirm({ open: false, item: null });
      pushToast("Rental item deleted.", "success");
      // Deleting the last row of a page would otherwise leave the user on an empty page N.
      if (items.length === 1 && page > 1) patch({ page: page - 1 > 1 ? String(page - 1) : null }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
      setConfirm({ open: false, item: null });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      {/* One row of controls, no heading block. The Rentals tab and the Catalogue pill directly above
          already say what this list is, and on a 1024px laptop a title beside these five controls
          forced the toolbar onto a second line — a whole band spent restating the two words above it.
          Same shape as the IRM catalogue's toolbar, which is the list this one sits beside. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or code…"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <Select
          size="sm"
          value={categoryId}
          onChange={(v) => patch({ category: v || null })}
          options={[{ value: "", label: "All categories" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
          ariaLabel="Filter by category"
        />
        <Select
          size="sm"
          value={status}
          onChange={(v) => patch({ status: v || null })}
          options={[
            { value: "", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          ariaLabel="Filter by status"
        />
        {/* NO SCAN BUTTON HERE, and that is the house pattern rather than an omission.
            Catalogue screens PRINT the label; the WAREHOUSE FLOWS read it — goods-management's job
            scan and the van-request fulfil are where a scanned code becomes a transaction line. The
            IRM catalogue, which prints the same kind of label, has never carried one either.
            This one did, and all it did was navigate: scan a rental code, land on that item's page.
            The search box to the left already finds an item by its code, so it offered a second way
            to do one thing and no way to do anything else — while reading, from the catalogue, as if
            scanning were a rental workflow. The rental workflow (a scanner in the Receive / Return
            forms, matching a supplier's asset tag as well as our code) does not exist yet. When it
            does, it belongs there. */}
        {/* Before the primary action and outside its ml-auto, so "New rental item" stays hard right. */}
        {can("rentals.export") && (
          <ExportButton
            onExport={() =>
              rentalService.exportRentalItemsCsv({
                search: search || undefined,
                status: status || undefined,
                categoryId: categoryId || undefined,
              })
            }
            disabled={items.length === 0}
            title="Export the filtered catalogue to CSV"
          />
        )}
        {can("rentals.create") && (
          <Link href="/dashboard/rentals/new" className={`${toolbarPrimaryBtn} sm:ml-auto`}>
            <Plus className="h-4 w-4" /> New rental item
          </Link>
        )}
      </div>

      {/* The card is the flex COLUMN and the table scrolls inside it, so the total/pagination strip
          rides along the bottom of the same surface instead of costing a card — border, shadow and
          the layout's gap — of its own. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="p-6 text-center text-xs text-[var(--neg)]">{error}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <Package className="h-8 w-8 text-[var(--faint)]" />
            <p className="text-xs text-[var(--muted)]">No rental items yet.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs" style={{ minWidth: TABLE_MIN_WIDTH }}>
            <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
              <tr>
                <th className="cell-y px-4">Code</th>
                <th className="cell-y px-4">Name</th>
                <th className="cell-y px-4">Category</th>
                {/* The unit answers a follow-up, not the question the list is scanned for, so it is
                    the column that goes when the viewport runs out. Header and body must carry the
                    same class or every following cell shifts by one. */}
                <th className={`cell-y px-4 ${colClass("lg")}`}>Unit</th>
                <th className="cell-y px-4">Status</th>
                {/* Deliberately unlabelled, like every other actions column in the app — a header
                    over a 28px button reads as a column of data that isn't there. */}
                {showActions && <th className="cell-y px-4" />}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => router.push(`/dashboard/rentals/${item.code}`)}
                  className="cursor-pointer border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-2)]"
                >
                  <td className="cell-y px-4 font-mono font-bold text-[var(--ink)]">{item.code}</td>
                  <td className={`cell-y px-4 text-[var(--ink)] ${CELL_ONE_LINE}`} title={item.name}>{item.name}</td>
                  <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`}>{item.rentalCategoryName ?? "—"}</td>
                  <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{item.baseUnit}</td>
                  <td className="cell-y px-4">
                    <StatusBadge status={item.status as UserStatus} />
                  </td>
                  {/* The whole CELL stops the click, not just the trigger: the row navigates on
                      click, so a press that lands on the cell's padding — or on the menu's own
                      backdrop — would open the item underneath the action being taken. */}
                  {showActions && (
                    <td className="cell-y px-4" onClick={(e) => e.stopPropagation()}>
                      <RentalRowActions
                        item={item}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onEdit={() => router.push(`/dashboard/rentals/${item.code}/edit`)}
                        onToggleStatus={() => toggleStatus(item)}
                        onDelete={() => setConfirm({ open: true, item })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {!loading && !error && total > 0 && (
          <Pagination
            embedded
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            total={total}
            label="items"
            onPage={(p) => patch({ page: p > 1 ? String(p) : null }, false)}
          />
        )}
      </div>

      {/* Same wording as the detail page's dialog, and for the same reason: a rental code is
          allocated once and never freed, so this is not the IRM catalogue's "you can re-add it
          later". Naming the item AND its code is what makes the dialog checkable — from a list, the
          row that opened it is no longer the one being read. */}
      <ConfirmDialog
        open={confirm.open}
        title="Delete rental item"
        confirmLabel="Delete"
        danger
        busy={deleting}
        onClose={() => setConfirm({ open: false, item: null })}
        onConfirm={onDelete}
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm.item?.name}</strong> ({confirm.item?.code})? An item
            referenced by any purchase request, purchase order, job kit list or engineer-held hire cannot be deleted.
            Deactivate instead if you only want to stop it being requested.
          </>
        }
      />
    </div>
  );
}
