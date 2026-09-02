import * as rentalItemService from "#modules/rental-item/rental-item.service.js";
import { calculateUnitPricePence, type RatePeriod } from "../../utils/rental-pricing.js";
import { computeNotifyOnDate, isTerminalHireStatus } from "./rentalHire.predicate.js";
import type { PoRentalLineRow } from "./purchase-order.repository.js";
import type { RentalLineInput } from "./rentalLine.validation.js";

// ── A rental line, from the wire to the row ───────────────────────────────────────────────────
//
// ONE builder for every document that carries a hire. A purchase request and a directly-raised
// purchase order both take the same line from the same form, and both have to file it the same
// way: the catalogue item checked to be live, its name and unit snapshotted, the money decided by
// the server. Two builders would be two answers to "what does this hire cost", and the request's and
// the order's would drift the first time one was touched.
//
// Sibling of rentalLine.validation.ts and in this module for the same reason: the purchase-request
// service already imports from purchase-order, and the reverse edge (order → request SERVICE) would
// drag the whole request module — approvals, emails, the reorder engine — into every order write.

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** A hire as REQUESTED — the row a purchase request stores, and what a purchase order commits. */
export interface RentalLineRow {
  rentalItemId: string;
  itemName: string;
  baseUnit: string | null;
  quantity: number;
  hireStartDate: Date;
  hireEndDate: Date;
  notifyDaysBefore: number;
  deliveryAddress: string | null;
  ratePeriod: string;
  ratePence: number | null;
  priceOverridden: boolean;
  returnMode: string;
  returnAddress: string | null;
  unitPricePence: number;
  vatRate: number;
  lineTotalPence: number;
  sortOrder: number;
  notes: string | null;
}

/**
 * The money a rental line is stored with.
 *
 * On a rate basis it is the arithmetic — computed here so the figure filed can never disagree with
 * the rate filed beside it. An OVERRIDDEN line keeps what was sent: a supplier-negotiated price is
 * a commercial fact, not a calculation, and the rate is still recorded so the difference is visible.
 */
export function agreedUnitPricePence(line: {
  ratePeriod?: string;
  ratePence?: number | null;
  priceOverridden?: boolean;
  unitPricePence: number;
  hireStartDate: Date;
  hireEndDate: Date;
}): number {
  const period = (line.ratePeriod ?? "total") as RatePeriod;
  if (period === "total" || line.priceOverridden) return line.unitPricePence;
  return (
    calculateUnitPricePence(period, line.ratePence, line.hireStartDate, line.hireEndDate) ??
    line.unitPricePence
  );
}

/**
 * Validate each rental line's item is ACTIVE, snapshot its name/unit, and compute the line total.
 *
 * The dates arrive already normalised to UTC midnight by the validation layer, so nothing here has
 * to think about time-of-day — see utils/calendar-day.ts. ONE guard and ONE read for the whole
 * set, however many lines there are: a document with six hires must not become twelve lookups.
 */
export async function buildRentalLineRows(lines: RentalLineInput[]): Promise<RentalLineRow[]> {
  if (lines.length === 0) return [];
  // ONE lookup for the whole set: the guard RETURNS the rows it validated, so the snapshots come
  // from that same read rather than from a second identical query.
  const items = await rentalItemService.requireActiveRentalItems(lines.map((l) => l.rentalItemId));
  return lines.map((line, i) => {
    const item = items.get(line.rentalItemId)!; // guaranteed by requireActiveRentalItems
    // Resolved ONCE and used for both the unit price and the line total. Computing it twice is how
    // a line ends up filed with a £2,475 unit price and a £0.03 total: the second reader used the
    // figure the client sent instead of the one the server decided.
    const unitPricePence = agreedUnitPricePence(line);
    return {
      rentalItemId: line.rentalItemId,
      itemName: item.name,
      baseUnit: item.baseUnit ?? null,
      quantity: line.quantity,
      hireStartDate: line.hireStartDate,
      hireEndDate: line.hireEndDate,
      notifyDaysBefore: line.notifyDaysBefore ?? 3,
      deliveryAddress: line.deliveryAddress ?? null,
      // The MONEY is decided here, not by the client. On a rate basis the price is arithmetic, so a
      // sent figure is at best redundant and at worst a way to file a number that does not match the
      // rate printed beside it. The one exception is a line someone deliberately overrode — a
      // negotiated price is not the arithmetic, and the rate stays on the line to show the gap.
      ratePeriod: line.ratePeriod ?? "total",
      ratePence: (line.ratePeriod ?? "total") === "total" ? null : (line.ratePence ?? null),
      priceOverridden: Boolean(line.priceOverridden) && (line.ratePeriod ?? "total") !== "total",
      // Absent means `delivery` — what every line meant before the field existed.
      returnMode: line.returnMode ?? "delivery",
      returnAddress: line.returnMode === "other" ? (line.returnAddress ?? null) : null,
      unitPricePence,
      // The LINE's own VAT, with no catalogue fallback: the rental master carries no pricing at
      // all, because what a hire costs is negotiated per period and per supplier. An IRM line still
      // falls back to its item's rate — that master legitimately holds one.
      vatRate: line.vatRate ?? 0,
      lineTotalPence: line.quantity * unitPricePence,
      sortOrder: i,
      notes: trimToNull(line.notes),
    };
  });
}

/** The fields a committed hire is built from — a requested row, or a request's stored line. */
export type RequestedHireLine = Omit<RentalLineRow, "sortOrder">;

/**
 * A requested hire → the row a PURCHASE ORDER commits.
 *
 * The complete line, not just the id — the order is the record the supplier reads and the deadline
 * alert counts, so a partial copy would leave the hire without its period or its price. Used by
 * conversion from a request AND by an order raised directly, so a hire reaches the order in exactly
 * one shape whichever door it came through. That parity is the point of the function: the two
 * paths must never be able to disagree about what a committed hire looks like.
 *
 * Committed, NOT delivered: the warehouse confirms arrival (POST .../receive), and only then does
 * the hire start counting towards any return deadline. `notifyOnDate` is computed rather than
 * copied because a request has no such column — the alert is an order-side concept.
 */
export function committedHireRow(line: RequestedHireLine, sortOrder: number): PoRentalLineRow {
  return {
    rentalItemId: line.rentalItemId,
    itemName: line.itemName,
    baseUnit: line.baseUnit,
    quantity: line.quantity,
    hireStartDate: line.hireStartDate,
    hireEndDate: line.hireEndDate,
    notifyDaysBefore: line.notifyDaysBefore,
    deliveryAddress: line.deliveryAddress,
    ratePeriod: line.ratePeriod,
    ratePence: line.ratePence,
    priceOverridden: line.priceOverridden,
    returnMode: line.returnMode,
    returnAddress: line.returnAddress,
    unitPricePence: line.unitPricePence,
    vatRate: line.vatRate,
    lineTotalPence: line.lineTotalPence,
    sortOrder,
    notes: line.notes,
    hireStatus: "awaiting_delivery",
    notifyOnDate: computeNotifyOnDate(line.hireStartDate, line.hireEndDate, line.notifyDaysBefore),
  };
}

/**
 * Whether a committed hire may still be REWRITTEN — deleted and re-created by a draft edit.
 *
 * Replacing a line drops its row, and a row that has been received, issued to an engineer, sent
 * back, extended, closed short or lost has receipts, custody and extension records hanging off it.
 * An order can only be edited in draft, and a draft's hires have done none of that — so this can
 * only be false on a row that reached a draft by a path this module does not know about, and the
 * safe answer to that is to refuse rather than orphan its history.
 */
export function hireLineUntouched(l: {
  hireStatus: string;
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity: number;
  cancelledQuantity: number;
  lostQuantity: number;
  extensionChargePence: number;
}): boolean {
  return (
    !isTerminalHireStatus(l.hireStatus) &&
    l.receivedQuantity === 0 &&
    l.returnedQuantity === 0 &&
    l.issuedQuantity === 0 &&
    l.cancelledQuantity === 0 &&
    l.lostQuantity === 0 &&
    l.extensionChargePence === 0
  );
}
