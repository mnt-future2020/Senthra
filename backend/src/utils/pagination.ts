// Shared page/pageSize clamping for every list endpoint. The arithmetic (default 20, cap 100, page
// bounded to [1, totalPages], skip derived) was hand-copied across ~13 services; centralising it
// keeps every list's paging semantics identical by construction — change the cap here, not in 13
// places. Callers still fetch their own `total` (each list's count query differs), then call this.

export interface PageBounds {
  page: number;
  pageSize: number;
  totalPages: number;
  skip: number; // (page - 1) * pageSize — ready to hand to a repo's `skip`
}

// Default page size and the hard upper cap a caller can request.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Clamp a raw (page, pageSize) request against a known total.
 * - pageSize: trunc, then bounded to [1, MAX_PAGE_SIZE], defaulting to 20 when absent/NaN.
 * - totalPages: at least 1 (an empty list is still "page 1 of 1").
 * - page: trunc, then bounded to [1, totalPages] (an out-of-range page clamps to the last).
 */
export function paginate(page: number | undefined, pageSize: number | undefined, total: number): PageBounds {
  const size = Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clampedPage = Math.min(Math.max(Math.trunc(page ?? 1), 1), totalPages);
  return { page: clampedPage, pageSize: size, totalPages, skip: (clampedPage - 1) * size };
}
