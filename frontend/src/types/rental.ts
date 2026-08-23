// Rental types — mirror the backend DTOs. Equipment the company HIRES rather than owns.
//
// A rental never becomes stock: no reorder levels, no inventory balance, no Goods In. What it has
// instead is a HIRE PERIOD and a deadline, which is the whole point of the module.

export type RentalStatus = "active" | "inactive";
/** Stored values. The UI renders these as "On Hire" and "Returned" — see rentalHireStatus.tsx. */
// Mirrors the server's HIRE_STATUSES (rentalHire.predicate.ts), in life order. A hire starts
// AWAITING DELIVERY: the purchase order commits us to the provider, but the kit is not ours until the
// warehouse confirms it arrived — and no return deadline applies before that.
export type HireStatus = "awaiting_delivery" | "on_hire" | "returned" | "cancelled";

export interface RentalCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: RentalStatus;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

export interface RentalItem {
  id: string;
  code: string; // auto-allocated, e.g. RNT-0001
  name: string;
  description: string | null;
  status: RentalStatus;
  rentalCategoryId: string;
  rentalCategoryName: string | null;
  baseUnit: string;
  // NO PRICING. This master says WHAT can be hired; what a hire costs is negotiated per period and
  // per supplier, so price, VAT and currency live on the PRF rental line below.
  notes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One depot currently holding a hired item, and how many units are free to take.
 *
 * A RentalItem carries no quantity of its own — deliberately — so "where can the engineer collect
 * this" is answered by the live hires, whose warehouse is their purchase order's delivery warehouse.
 */
export interface RentalItemAvailability {
  warehouseId: string;
  warehouseName: string | null;
  warehouseCode: string | null;
  available: number;
  /** The soonest deadline among the hires stocking this depot. */
  nextDueBack: string | null;
}

/** A hired line on a purchase request — where the period and delivery address are captured. */
export interface PrfRentalLine {
  id: string;
  rentalItemId: string;
  itemName: string;
  baseUnit: string | null;
  quantity: number;
  hireStartDate: string;
  hireEndDate: string;
  hireDays: number;
  notifyDaysBefore: number;
  deliveryAddress: string | null;
  /** How the price was arrived at: "total" | "day" | "week" | "month" — see utils/rental-pricing.ts. */
  ratePeriod: string;
  /** The quoted rate in pence for that basis; null on the `total` basis. */
  ratePence: number | null;
  /** True when someone typed over the calculated figure — a negotiated price, not the arithmetic. */
  priceOverridden: boolean;
  /** Where the hire goes back: "delivery" | "warehouse" | "other" — see the backend's rentalReturn.ts. */
  returnMode: string;
  returnAddress: string | null;
  /** BOTH legs, resolved server-side so a screen can never disagree with the order document. */
  deliveryLocation: { label: string; address: string | null };
  returnLocation: { label: string; address: string | null };
  unitPricePence: number;
  unitPrice: number;
  vatRate: number;
  lineTotalPence: number;
  lineTotal: number;
  notes: string | null;
  rentalItem: { id: string; code: string; name: string; status: string } | null;
}

/** ONE extension of one hire — an entry in the breakdown behind `extensionCharge`. */
export interface HireExtensionEntry {
  id: string;
  previousEndDate: string;
  newEndDate: string;
  addedDays: number;
  /** The line charge for this one extension, in pounds — per unit x quantity. */
  charge: number;
  /** What the hire's own rate priced it at. Null on the `total` basis, which has no rate. */
  calculatedCharge: number | null;
  priceOverridden: boolean;
  agreedBy: string | null;
  agreedAt: string;
}

/** A row on the Extensions register — one extension, flattened with its order. */
export interface HireExtensionRow extends HireExtensionEntry {
  purchaseOrderId: string;
  purchaseOrderCode: string | null;
  supplierName: string | null;
  itemName: string;
  quantity: number;
  ratePeriod: string | null;
  ratePence: number | null;
}

export interface PagedHireExtensions {
  extensions: HireExtensionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** What THIS page adds up to, in pounds — the export carries the whole period. */
  totalCharge: number;
}

/** The same line once the request converts — the COMMITTED hire, and what the badge counts. */
export interface PoRentalLine extends Omit<PrfRentalLine, "rentalItem"> {
  notifyOnDate: string;
  hireStatus: HireStatus;
  /** Ordered vs actually arrived — a part delivery is ordinary, and every screen has to show it. */
  receivedQuantity: number;
  /** Nothing more is expected — every unit arrived, or the rest was closed short. */
  fullyReceived: boolean;
  /** Ordered units recorded as never arriving, and why. `received + cancelled = ordered`. */
  cancelledQuantity: number;
  shortClosedAt: string | null;
  shortClosedBy: string | null;
  shortCloseReason: string | null;
  /** What has gone BACK, and whether everything we hold has. The return form caps on these. */
  returnedQuantity: number;
  fullyReturned: boolean;
  /** Reported damaged while with us — clamped by every reader to what is still held. */
  damagedQuantity: number;
  /** Stamped when the warehouse confirmed the kit arrived; null while awaiting delivery. */
  receivedAt: string | null;
  receivedBy: string | null;
  /** Cumulative extension charges. Deliberately NOT part of the order's totals. */
  extensionChargePence: number;
  extensionCharge: number;
  /**
   * The BREAKDOWN of that total, oldest first. Extend a hire three times and the total reads £725 —
   * true, and unable to say how many times, when, or how much each. Both are kept: the sum is what
   * every deadline screen needs at a glance, this is what a reader asks for next.
   */
  extensions: HireExtensionEntry[];
  /** What the total holds that no entry explains — extensions agreed before they were recorded. */
  unexplainedExtensionCharge: number;
  returnedAt: string | null;
  returnedBy: string | null;
  rentalItem: { id: string; code: string; name: string; status: string } | null;
}

/** A row on the On hire tab — one live hire, flattened with its order. */
export interface OnHireLine {
  id: string;
  purchaseOrderId: string;
  purchaseOrderCode: string;
  supplierName: string | null;
  rentalItemId: string;
  rentalItemCode: string | null;
  itemName: string;
  quantity: number;
  hireStartDate: string;
  hireEndDate: string;
  hireDays: number;
  /** Negative once the hire has run out — "3 days left" / "2 days over". */
  daysRemaining: number;
  /** How much of this hire is actually here, and how much has already gone back. */
  receivedQuantity: number;
  fullyReceived: boolean;
  /** Ordered units recorded as never arriving, and why — the row shows "2 of 5 · 3 cancelled". */
  cancelledQuantity: number;
  shortCloseReason: string | null;
  returnedQuantity: number;
  fullyReturned: boolean;
  /** Reported damaged while with us — what the warehouse's rental pane filters on. */
  damagedQuantity: number;
  notifyOnDate: string;
  /** Which deadline window the SERVER put this hire in — the same clock the badges use. */
  window: "ok" | "expiring" | "overdue";
  deliveryAddress: string | null;
  /** How the price was arrived at: "total" | "day" | "week" | "month" — see utils/rental-pricing.ts. */
  ratePeriod: string;
  /** The quoted rate in pence for that basis; null on the `total` basis. */
  ratePence: number | null;
  /** True when someone typed over the calculated figure — a negotiated price, not the arithmetic. */
  priceOverridden: boolean;
  /** Where the hire goes back: "delivery" | "warehouse" | "other" — see the backend's rentalReturn.ts. */
  returnMode: string;
  returnAddress: string | null;
  /** BOTH legs, resolved server-side so a screen can never disagree with the order document. */
  deliveryLocation: { label: string; address: string | null };
  returnLocation: { label: string; address: string | null };
  /** Cumulative extension charges on this hire. NOT part of the order's totals. */
  extensionCharge: number;
  hireStatus: HireStatus;
  /** Stamped when the warehouse confirmed the kit arrived; null while awaiting delivery. */
  receivedAt: string | null;
  /** The agreed price for one unit and for the whole line, in pounds. Extensions are NOT in either. */
  unitPrice: number;
  lineTotal: number;
  /**
   * When the equipment physically MOVED — first delivery, last collection — off its own movement
   * notes rather than off the moment somebody typed the record in. A supplier invoices from these.
   */
  deliveredOn: string | null;
  collectedOn: string | null;
  /**
   * Days actually held, on the same convention as `hireDays`: the collection day is not charged.
   * Null until both ends are known — a hire still out has no length yet.
   */
  daysOnHire: number | null;
  /**
   * What the supplier is charging for damage to this hire, in pounds, across its live damage reports
   * and returns. Null when nothing is quoted yet — which is NOT zero, and the screens say so.
   */
  damageCharge: number | null;
}

/** The On hire tab's filters. Resolved server-side through the same predicates the badges count. */
// `late` is the narrower half of `awaiting`: nothing has arrived AND the hire has already started.
// It exists so the "Hires not yet received" badge opens exactly the rows it counted — it used to
// link to `awaiting`, the whole receiving queue, and read a smaller number than the list it opened.
// `returned` is the odd one out and belongs here anyway: every other value narrows the LIVE hires and
// it selects the finished ones — the same rows at the end of the same life, and the only place a
// completed hire can be found. Every other rental surface is live-only by design.
export type OnHireFilter = "all" | "expiring" | "overdue" | "awaiting" | "late" | "returned" | "cancelled";

// ── Hire deliveries ─────────────────────────────────────────────────────────────────────────────
//
// Supplier-owned kit arriving at a warehouse. NOT a goods receipt: a GRN writes an inventory balance
// and a stock movement, and hired equipment never becomes our stock. See the backend's
// modules/rental-receipt.

/** The condition the kit arrived in. Per-line `damagedQuantity` carries the detail. */
export type ReceiptCondition = "good" | "damaged";

export interface RentalReceiptLine {
  id: string;
  purchaseOrderRentalLineId: string;
  itemName: string;
  baseUnit: string | null;
  orderedQuantity: number;
  /** What had already arrived before this delivery — the snapshot, not a live figure. */
  previouslyReceived: number;
  receivedQuantity: number;
  damagedQuantity: number;
  /** The SUPPLIER's own asset tags for the units delivered. Recorded, not tracked. */
  assetTags: string[];
  notes: string | null;
  /**
   * What the supplier is charging for the damage on this line, in pounds.
   *
   * `null` is "no charge recorded", 0 is "they are not charging" — a real distinction, because the
   * damage is written down the day it is found and the quote arrives days later.
   */
  damageCharge: number | null;
}

/** Which way the equipment moved — or, for `damage`, that it did not move at all. */
export type ReceiptDirection = "in" | "out" | "damage";

export interface RentalReceipt {
  id: string;
  code: string;
  direction: ReceiptDirection;
  purchaseOrderId: string;
  poCode: string | null;
  supplierName: string | null;
  warehouseId: string;
  warehouseName: string | null;
  deliveryDate: string;
  carrier: string | null;
  deliveryNoteRef: string | null;
  condition: ReceiptCondition | string;
  conditionNotes: string | null;
  notes: string | null;
  receivedBy: string | null;
  /** The supplier's quote or invoice number for the damage on this note. */
  damageChargeRef: string | null;
  /** Every line's charge added up, in pounds. Null when not one line carries a figure yet. */
  damageChargeTotal: number | null;
  /** Set once REVERSED — the note moved nothing, and its quantities were given back. */
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  createdAt: string;
  lines: RentalReceiptLine[];
  attachments: {
    id: string;
    label: string | null;
    fileName: string;
    fileType: string;
    fileSizeBytes: number;
    url: string;
    uploadedBy: string | null;
    createdAt: string;
  }[];
}

/** The movement register's filters. Every one of them is resolved server-side. */
export interface HireMovementFilters {
  search?: string;
  direction?: ReceiptDirection;
  warehouse?: string;
  supplier?: string;
  purchaseOrder?: string;
  /** Inclusive calendar days (yyyy-mm-dd) on the date the equipment MOVED — a reporting period. */
  from?: string;
  to?: string;
  /** Drops reversed notes. Off by default: a corrected note is still a fact about the period. */
  liveOnly?: boolean;
}

export interface PagedHireMovements {
  receipts: RentalReceipt[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** What the return form posts — the mirror of a delivery, and the leg a dispute is argued over. */
export interface RentalReturnPayload {
  purchaseOrderId: string;
  returnDate: string;
  collectedBy?: string;
  returnNoteRef?: string;
  condition?: ReceiptCondition;
  conditionNotes?: string;
  notes?: string;
  /** The supplier's quote or invoice number for any damage charged on this note. */
  damageChargeRef?: string;
  lines: {
    purchaseOrderRentalLineId: string;
    returnedQuantity: number;
    damagedQuantity?: number;
    /** In POUNDS. Usually left out here and recorded later, when the supplier's quote arrives. */
    damageCharge?: number;
    assetTags?: string[];
    notes?: string;
  }[];
}

/** What the damage form posts. It moves no quantity — the equipment is still with us. */
export interface HireDamagePayload {
  purchaseOrderId: string;
  reportedDate: string;
  conditionNotes: string;
  notes?: string;
  damageChargeRef?: string;
  lines: {
    purchaseOrderRentalLineId: string;
    damagedQuantity: number;
    /** In POUNDS. Usually left out here and recorded later, when the supplier's quote arrives. */
    damageCharge?: number;
    assetTags?: string[];
    notes?: string;
  }[];
}

/**
 * What the "record damage charge" form posts — the money, after the note already exists.
 *
 * `null` on a line CLEARS its charge (a quote that never came); omitting the line leaves whatever is
 * on file. The reference alone updates only the reference.
 */
export interface RecordDamageChargePayload {
  damageChargeRef?: string;
  lines?: { purchaseOrderRentalLineId: string; damageCharge: number | null }[];
}

/** What the receive form posts. Zero-quantity lines are allowed and dropped server-side. */
export interface RentalReceiptPayload {
  purchaseOrderId: string;
  deliveryDate: string;
  carrier?: string;
  deliveryNoteRef?: string;
  condition?: ReceiptCondition;
  conditionNotes?: string;
  notes?: string;
  lines: {
    purchaseOrderRentalLineId: string;
    receivedQuantity: number;
    damagedQuantity?: number;
    assetTags?: string[];
    notes?: string;
  }[];
}
