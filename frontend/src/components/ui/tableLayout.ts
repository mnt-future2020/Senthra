// ── Sizing a data table so its rows stay one line ──────────────────────────────────────────────
//
// Measured on a 1024×866 laptop: the Inventory list showed FOUR rows. The bands above the table
// looked like the cause, but they weren't. Nine columns shared a flat `min-w-[760px]` — about 84px
// each — and "London Fulfillment Centre" needs roughly 180px at this font size. The browser resolved
// that by WRAPPING the text and growing the row to ~72px instead of ~45px, which is the one direction
// that costs rows on a screen already short of them.
//
// The same flat-minimum habit is on every list in this app, all of them too small for their content:
//
//   Purchase Orders   9 cols @ 1000px = 111px   supplier and warehouse names run to ~200px
//   Jobs              8 cols @ 1000px = 125px   "JOB-2026-0030" alone needs ~142px
//   Warehouses        8 cols @  860px = 107px
//   Customers         7 cols @    —            no minimum at all, so it shrinks without limit
//
// So a table declares what its columns are WORTH instead of one number for all of them, and the width
// follows. Where the total exceeds the viewport the container scrolls sideways — which is cheap, and
// far better than paying for it in row height.

/** How much room a column's content actually needs, before padding. */
export type ColWidth =
  /** codes, quantities, short dates, badges */
  | "narrow"
  /** the default — names, statuses, contacts */
  | "normal"
  /** free text that regularly runs long: company names, addresses, item descriptions */
  | "wide";

/**
 * Content allowance per class, in px. Cell padding (px-4 = 32px) is added on top.
 *
 * `wide` clears "London Fulfillment Centre" — the ~180px value that was wrapping to three lines and
 * started this — with a little headroom, so a name a shade longer doesn't put the problem straight
 * back. The sibling test pins that relationship rather than the number.
 */
const CONTENT: Record<ColWidth, number> = { narrow: 78, normal: 118, wide: 186 };
const PADDING = 32;

/**
 * The minimum width a table should ask for.
 *
 * @param widths one entry per rendered column, in order
 *
 * Deliberately a floor, not a target: the table still stretches to fill a wide container. It only
 * says "below this, stop squeezing and start scrolling".
 */
export function tableMinWidth(widths: ColWidth[]): number {
  return widths.reduce((total, w) => total + CONTENT[w] + PADDING, 0);
}

/**
 * How important a column is when space runs out.
 *
 * `always` for anything rows are told apart by — drop one of those and the list becomes a wall of
 * near-identical lines. `lg` and `xl` are for the columns that answer a FOLLOW-UP question rather
 * than the one being scanned for: reference codes, money, timestamps. Nothing is lost by hiding
 * them — the row still opens the record, and CSV export always writes every column.
 */
export type ColPriority = "always" | "lg" | "xl";

/**
 * The responsive class for a column.
 *
 * A `hidden` cell leaves the layout entirely, so the header and the body MUST apply the same class to
 * the same column — a mismatch shifts every following cell by one and the table silently misreports
 * which value is which. Always drive both from one table.
 */
export function colClass(priority: ColPriority): string {
  if (priority === "lg") return "hidden lg:table-cell";
  if (priority === "xl") return "hidden xl:table-cell";
  return "";
}

/**
 * The same rule for a table whose cells are rendered from an INDEX rather than written out one by
 * one — the loading skeletons, which draw N identical placeholder cells per row.
 *
 * They are why this exists: their headers carried `colClass` but the generated body cells did not, so
 * below `lg` the skeleton's header row had seven columns and its body rows had nine. The table did not
 * misreport anything (there is no data in a skeleton), but the placeholder was a different shape from
 * the table replacing it, which is the flicker on every list in the app.
 *
 * @param priorities one entry per column, in order — the SAME array the header maps over
 * @returns the class for column `index`; out-of-range indexes (a trailing actions cell the caller
 *          appends itself) are `always`, since that is what an unlisted column has always meant.
 */
export function colClassAt(priorities: ColPriority[], index: number): string {
  return colClass(priorities[index] ?? "always");
}

/**
 * Classes that keep a text cell on ONE line.
 *
 * `truncate` is what makes the sizing above hold for data nobody has seen yet: however long a
 * customer name or an address gets, the row height cannot grow. Pair it with a `title` carrying the
 * full value so nothing becomes unreadable — truncating without that trades one problem for another.
 */
export const CELL_ONE_LINE = "max-w-[22rem] truncate";
