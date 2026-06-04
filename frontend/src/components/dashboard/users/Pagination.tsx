"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

const navBtn =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--muted)]";

// Footer pagination bar — shows the total count, and prev/next + "Page X of Y"
// when there's more than one page. Works for both server- and client-paged lists.
export function Pagination({
  page,
  totalPages,
  total,
  label = "items",
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  label?: string;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-xs sm:flex-row">
      <span className="text-xs font-bold text-[var(--faint)]">
        {total} {total === 1 ? label.replace(/s$/, "") : label}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            className={navBtn}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="px-1 text-xs font-bold text-[var(--muted)]">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => onPage(page + 1)}
            disabled={page >= totalPages}
            className={navBtn}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
