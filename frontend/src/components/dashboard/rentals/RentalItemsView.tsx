"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Package, Plus, Search } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as rentalService from "@/services/rental.service";
import type { RentalCategory, RentalItem } from "@/types/rental";
import type { UserStatus } from "@/types/user";
import { ExportButton } from "@/components/ui/ExportButton";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { toolbarInputCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";

const PAGE_SIZE = 20;

// Code · Name · Category · Unit · Status. Declared per column rather than one flat minimum so a long
// item name scrolls the table sideways instead of wrapping to a second line — a wrapped row is ~27px
// taller, paid once PER ROW, which costs far more of a 1024px laptop than any band above the table.
const TABLE_MIN_WIDTH = tableMinWidth(["narrow", "wide", "normal", "narrow", "narrow"]);

/**
 * Rentals → Catalogue: the master list of equipment the company hires.
 *
 * Deliberately narrower than the IRM catalogue — a hire has no stock level, no reorder policy and
 * no barcode. It carries no PRICE either: what a hire costs is agreed per request, so the figure
 * lives on the PRF rental line rather than as a rate card here.
 */
export function RentalItemsView() {
  const { can } = useAuth();
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
  }, [search, status, categoryId, page]);

  // The category filter is a convenience, not a gate: a failure here leaves the dropdown empty
  // rather than blocking the list the user came for.
  React.useEffect(() => {
    rentalService
      .listRentalCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    </div>
  );
}
