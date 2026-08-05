import { useCallback, useMemo, useState } from "react";

// Client-side search + sort + pagination over an already-fetched list — the
// mobile twin of the web's usePortalTable. Pass `opts` as a module-level
// constant (comparators/searchText are static per screen); `filter` may change
// per render (e.g. the customer dropdown).

export interface ClientTableOptions<T> {
  /** Haystack the search query is matched against (case-insensitive substring). */
  searchText: (item: T) => string;
  /** Ascending comparators by sort key; "key:desc" reverses. */
  comparators: Record<string, (a: T, b: T) => number>;
  /** e.g. "updated:desc" — must reference a comparator key. */
  initialSort: string;
  pageSize?: number;
}

export function useClientTable<T>(
  source: T[],
  opts: ClientTableOptions<T>,
  filter?: (item: T) => boolean,
) {
  const pageSize = opts.pageSize ?? 15;
  const [query, setQueryState] = useState("");
  const [sort, setSortState] = useState(opts.initialSort);
  const [page, setPage] = useState(1);

  const setQuery = useCallback((v: string) => {
    setQueryState(v);
    setPage(1);
  }, []);
  const setSort = useCallback((v: string) => {
    setSortState(v);
    setPage(1);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = filter ? source.filter(filter) : source;
    if (q) rows = rows.filter((r) => opts.searchText(r).toLowerCase().includes(q));
    const [key, dir] = sort.split(":");
    const cmp = key ? opts.comparators[key] : undefined;
    if (cmp) {
      rows = [...rows].sort(cmp);
      if (dir === "desc") rows.reverse();
    }
    return rows;
  }, [source, query, sort, filter, opts]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp derived in render (never setState) so a shrinking result set can't
  // strand the view on an empty page.
  const clampedPage = Math.min(page, totalPages);
  const rows = filtered.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  return {
    query,
    setQuery,
    sort,
    setSort,
    page: clampedPage,
    setPage,
    rows,
    total,
    totalPages,
    /** Search/filter active but nothing matched (the source itself is non-empty). */
    noMatches: total === 0 && source.length > 0,
  };
}
