"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";

// Reusable client-side table primitives for the portal's fully-loaded lists (engineer/customer
// stock). The whole list arrives in one request and is bounded by nature (one van's holdings), so
// search / sort / pagination run in-memory — instant, no per-keystroke round-trip, no backend
// pagination to maintain. Mirrors the admin list look (search box, sortable headers, Pagination).
//
// The filter/sort is re-derived each render as plain values (no useMemo) — cheap for a bounded list.
// Note: the lint config (eslint-plugin-react-hooks v7) enforces React-Compiler compatibility, so
// reading a ref during render is banned — hence the render-time state-adjust pattern below rather
// than a ref to skip deps.

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

interface PortalTableOptions<T> {
  /** Concatenated searchable text for a row (case-folded internally). */
  searchText: (row: T) => string;
  /** Ascending comparators keyed by sort key; descending is the negation. */
  comparators: Record<string, (a: T, b: T) => number>;
  initialSort: SortState;
  /** Optional predicate (e.g. a dropdown filter); pair with `filterToken` so page-reset tracks it. */
  filter?: (row: T) => boolean;
  /** A primitive that changes whenever `filter` changes — drives the page reset. */
  filterToken?: string;
  pageSize?: number;
}

export interface PortalTable<T> {
  query: string;
  setQuery: (q: string) => void;
  sort: SortState;
  toggleSort: (key: string) => void;
  page: number;
  setPage: (n: number) => void;
  /** The current page's rows (already filtered + sorted). */
  rows: T[];
  /** Filtered row count across all pages. */
  total: number;
  totalPages: number;
  /** True when a search/filter is active but nothing matched (vs. genuinely empty source). */
  noMatches: boolean;
}

export function usePortalTable<T>(data: T[], options: PortalTableOptions<T>): PortalTable<T> {
  const { searchText, comparators, initialSort, filter, filterToken = "", pageSize = 15 } = options;

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(initialSort);
  const [page, setPage] = React.useState(1);

  const q = query.trim().toLowerCase();

  // Reset to page 1 whenever the result set changes shape (new search or filter). Adjusting state
  // during render — the React-recommended pattern — avoids an extra render pass. JSON.stringify keeps
  // the two parts unambiguous (a plain join could let "a b"+"c" collide with "a"+"b c").
  const sig = JSON.stringify([q, filterToken]);
  const [prevSig, setPrevSig] = React.useState(sig);
  if (prevSig !== sig) {
    setPrevSig(sig);
    setPage(1);
  }

  let filtered = data;
  if (filter) filtered = filtered.filter(filter);
  if (q) filtered = filtered.filter((r) => searchText(r).toLowerCase().includes(q));
  const cmp = comparators[sort.key];
  if (cmp) {
    const dir = sort.dir;
    filtered = [...filtered].sort((a, b) => (dir === "asc" ? cmp(a, b) : -cmp(a, b)));
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return {
    query,
    setQuery,
    sort,
    toggleSort,
    page: safePage,
    setPage,
    rows,
    total,
    totalPages,
    noMatches: total === 0 && (q !== "" || filterToken !== ""),
  };
}

// Search box matching the admin filter-bar input.
export function PortalSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full shrink-0 sm:max-w-xs">
      <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
      />
    </div>
  );
}

// A clickable, direction-aware table header. Drop it in as a `TableCard` header node.
export function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={
        active
          ? `${label}, sorted ${sort.dir === "asc" ? "ascending" : "descending"} — activate to reverse`
          : `Sort by ${label}`
      }
      className={`group inline-flex items-center gap-1 transition-colors hover:text-[var(--ink)] ${active ? "text-[var(--ink)]" : ""}`}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
      ) : (
        // Kept faintly visible (not hover-only) so the sort affordance is discoverable on touch.
        <ChevronsUpDown className="h-3 w-3 text-[var(--faint)] opacity-40 transition-opacity group-hover:opacity-70" />
      )}
    </button>
  );
}
