"use client";

import type * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const navBtn =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--muted)]";

// Singularize a plural label for the "Total: 1 <thing>" line. Stripping a trailing "s" alone is
// wrong for the two plural forms this app actually uses: "deliveries" became "deliverie" and
// "categories" became "categorie". Order matters — test -ies before the bare -s.
// Deliberately narrow: these are our own hardcoded labels, not arbitrary user input, so the goal
// is to get every label passed to <Pagination> right, not to be a general English pluralizer.
export function singularize(label: string): string {
  if (/[^aeiou]ies$/i.test(label)) return label.replace(/ies$/i, "y"); // deliveries → delivery
  if (/(ch|sh|ss|x|z)es$/i.test(label)) return label.replace(/es$/i, ""); // addresses → address
  if (/[^s]s$/i.test(label)) return label.slice(0, -1); // jobs → job
  return label; // already singular, or an irregular we don't try to handle
}

// Footer pagination bar — shows the total count, and prev/next + "Page X of Y"
// when there's more than one page. Works for both server- and client-paged lists.
export function Pagination({
  page,
  totalPages,
  total,
  label = "items",
  onPage,
  embedded = false,
  note,
}: {
  page: number;
  totalPages: number;
  total: number;
  label?: string;
  onPage: (page: number) => void;
  /**
   * Render as a strip INSIDE the table's own card instead of as a card of its own.
   *
   * A standalone card costs its border, its shadow, its rounding and — the part that actually hurt —
   * the parent's flex gap above it. On a 1024px laptop that was ~35px of a screen already down to
   * four rows of data, spent on separating a footer from the table it belongs to. Embedded it reads
   * as one surface and the rows get the space back.
   */
  embedded?: boolean;
  /**
   * A short caption rendered beside the total.
   *
   * For the one thing a footer is well placed to say: what a column on this table adds up to, and why
   * that figure may not match a number elsewhere on screen. It sits next to "Total: 9 warehouses"
   * because that is where someone is already reading counts, rather than as a banner nobody asked
   * for.
   */
  note?: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-between gap-3 px-4 py-3 sm:flex-row ${
        embedded
          ? "shrink-0 border-t border-[var(--border)]"
          : "rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs"
      }`}
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold text-[var(--faint)]">
        <span>
          Total: {total} {total === 1 ? singularize(label) : label}
        </span>
        {note}
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
