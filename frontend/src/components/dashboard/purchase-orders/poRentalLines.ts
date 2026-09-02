import {
  isFilledRentalRow,
  savedRentalLineRow,
  toRentalPayload,
  type RentalLinePayload,
  type RentalLineRow,
} from "@/components/dashboard/purchase-requests/rentalLineRows";
import type { PoRentalLine } from "@/types/rental";

// The purchase order form's half of the rental-line model — what an ORDER needs beyond the row
// model the request form already has: its saved hires back into rows, each row's destination on
// the multi-warehouse create, and the hire half of the live estimate. Every rule about the row
// itself stays in rentalLineRows.ts, shared with the request form.

/** One hire on the split-create body — the shared line plus the depot it is delivered to. */
export interface SplitRentalLinePayload extends RentalLinePayload {
  warehouseId: string;
}

/**
 * An order's SAVED hires as editable rows — how the edit form reopens them.
 *
 * Identity is `rentalItemId`, exactly as it is on the request form; the picker resolves each id
 * against the catalogue, so a renamed item still lands on the same line and a retired one shows
 * its historical name rather than an empty picker. Nothing about the hire's STATE comes back into
 * the row: an order is only editable in draft, and a draft's hires have not moved.
 */
export function rentalRowsFromOrder(order: { rentalItems: PoRentalLine[] } | null | undefined): RentalLineRow[] {
  return (order?.rentalItems ?? []).map(savedRentalLineRow);
}

/**
 * Rows → the split-create body. The same payload the request sends, plus each row's destination —
 * resolved through the caller because a single-warehouse manager's depot is locked rather than
 * stored on the row.
 */
export function toSplitRentalPayload(rows: RentalLineRow[], warehouseFor: (row: RentalLineRow) => string): SplitRentalLinePayload[] {
  return rows.filter(isFilledRentalRow).map((row) => ({ ...toRentalPayload([row])[0]!, warehouseId: warehouseFor(row) }));
}

/** True when a filled hire has no destination yet — the create form's "select a warehouse" rule. */
export function rentalRowsMissingWarehouse(rows: RentalLineRow[], warehouseFor: (row: RentalLineRow) => string): boolean {
  return rows.filter(isFilledRentalRow).some((row) => !warehouseFor(row));
}

/**
 * Have the hires on screen actually CHANGED from what the order stores?
 *
 * Sending them decides whether the server replaces them, and a replacement is a delete plus a
 * re-create of every hire row inside the update transaction. Without this, saving a header-only
 * edit — a note, a reference, a date — rewrote every hire on the order and handed each one a new
 * id, for rows whose content had not moved. Compared as the PAYLOAD, because that is what the
 * server would act on: a blank spare row, or a value the payload rounds, is not a change.
 */
export function rentalRowsChanged(rows: RentalLineRow[], order: { rentalItems: PoRentalLine[] } | null | undefined): boolean {
  return JSON.stringify(toRentalPayload(rows)) !== JSON.stringify(toRentalPayload(rentalRowsFromOrder(order)));
}

// The hire half of a form's live estimate lives with the row model, shared with the request form —
// re-exported here so an order-side caller has one import site for its rental helpers.
export { rentalEstimate } from "@/components/dashboard/purchase-requests/rentalLineRows";

/**
 * The same half from an order's SAVED hires, for an edit that cannot show them.
 *
 * A user who may edit orders but not read the rental catalogue (`rentals.view`) gets no rental
 * grid: the picker would 403 on every search. Their save leaves the hires exactly as stored, and
 * the estimate has to keep counting them — or a hire-only order reads £0 in the aside while the
 * server totals its hires all the same.
 */
export function savedRentalEstimate(lines: { lineTotal: number; vatRate: number }[]): { subtotal: number; vat: number } {
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    subtotal += l.lineTotal;
    vat += (l.lineTotal * l.vatRate) / 100;
  }
  return { subtotal, vat };
}
