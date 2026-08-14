// ── Which stock columns survive a narrow screen ────────────────────────────────────────────────
//
// Measured on a 1024×866 laptop, the All Inventory lens showed FOUR rows. The bands above the table
// were the obvious suspect, but they were not the cause: nine columns share a 760px minimum, which
// is ~84px each, and "London Fulfillment Centre" needs about 180px at this font size. So Location
// wrapped to three lines and every row stood ~72px tall instead of ~45px. Roughly 320px of table
// space then holds 4 rows where it should hold 7.
//
// The fix is a column BUDGET, not a smaller font: below `xl` the reference columns step aside so the
// remaining ones get real width and each row stays on one line. Nothing becomes unreachable —
// clicking a row opens the item, and Export CSV always writes every column regardless of what is on
// screen.
//
// A `hidden` cell is removed from layout entirely, so the header and body must apply the SAME class
// to the SAME column or the two would misalign by one cell. That is why this is a table keyed by
// column rather than a class written at each call site.

export type StockCol =
  | "item"
  | "sku"
  | "ownership"
  | "location"
  | "customer"
  | "engineer"
  | "warehouse"
  | "qty"
  | "available"
  | "value"
  | "status"
  | "lastMovement";

/**
 * Columns that step aside on a narrow viewport, and where they come back.
 *
 * Chosen by what a person SCANS a stock list for — what the item is, whose it is, where it is, how
 * much there is, and whether that is a problem. The three below answer follow-up questions instead:
 *
 *   sku          — a lookup key, and the row already shows the item code under its name
 *   value        — reporting, not floor work; the summary cards carry the totals that matter
 *   lastMovement — audit context, and the item's own page has the full movement feed
 *
 * `qty`, `status`, `item`, and the owner/location group are never hidden: dropping any of them would
 * leave rows you cannot tell apart.
 */
const SECONDARY: Partial<Record<StockCol, string>> = {
  sku: "hidden xl:table-cell",
  value: "hidden xl:table-cell",
  lastMovement: "hidden lg:table-cell",
};

/** The responsive class for a column — "" when it is always shown. */
export function columnClass(col: StockCol): string {
  return SECONDARY[col] ?? "";
}

/** Columns actually rendered at a given breakpoint. Exported for the tests and for colSpan maths. */
export function visibleColumns(columns: StockCol[], width: "sm" | "lg" | "xl"): StockCol[] {
  return columns.filter((c) => {
    const cls = SECONDARY[c];
    if (!cls) return true;
    if (width === "xl") return true;
    return width === "lg" && cls.includes("lg:table-cell");
  });
}

/**
 * The minimum width the table asks for, in px.
 *
 * The old flat `min-w-[760px]` was the real bug: it let nine columns squeeze to ~84px each rather
 * than letting the container scroll, so the browser resolved the overflow by wrapping text and
 * growing rows — the one direction that costs rows on a screen already short of them. Sizing from
 * the column count means a wide lens scrolls sideways (cheap, and the user chose that lens) while a
 * narrow one still fits.
 *
 * `item` gets a wider allowance because it carries two lines of content by design (name + code);
 * everything else is a single value.
 */
export function tableMinWidth(columns: StockCol[]): number {
  return columns.reduce((w, c) => w + (c === "item" ? 220 : 120), 0);
}

/** The URL params the filter popover owns. `q` is NOT one — search stays outside it. */
export const FILTER_PARAMS = ["owner", "location", "warehouse", "category", "status", "customer"] as const;
export type FilterParam = (typeof FILTER_PARAMS)[number];

/**
 * How many of the CONFIGURED filters are currently set.
 *
 * Counts only what this screen actually offers: a lens that never shows the customer filter must not
 * report one as active because a stale `?customer=` survived a lens switch, or the trigger would
 * claim a narrowing the user cannot see or clear. Search is excluded — it lives outside the popover,
 * in plain sight.
 */
export function activeFilterCount(
  configured: readonly string[],
  get: (key: string) => string | null,
): number {
  return FILTER_PARAMS.filter((p) => configured.includes(p) && (get(p) ?? "") !== "").length;
}

/** The patch that clears every configured filter — same narrowing rule as the count above. */
export function clearFilterPatch(configured: readonly string[]): Record<string, null> {
  return Object.fromEntries(FILTER_PARAMS.filter((p) => configured.includes(p)).map((p) => [p, null]));
}
