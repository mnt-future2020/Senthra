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
  /**
   * The two custody facts the order page could not previously show.
   *
   * `lostQuantity` is units that are gone. Without it this page reads "100 ordered · on hire · £300"
   * with nothing anywhere saying one of them will never come back — which is precisely the page an
   * accountant opens. `damagedHeldQuantity` is what is broken and STILL HERE, as against
   * `damagedQuantity`, which is the provider-facing lifetime total and counts units already handed back.
   */
  lostQuantity: number;
  damagedHeldQuantity: number;
  /**
   * Units out with an ENGINEER right now — ours to answer for, but not in the building.
   *
   * Here so the page can tell whether a delivery may still be unwound: a unit in a van has its arrival
   * on the record, so the note that delivered it can no longer be given back.
   */
  issuedQuantity: number;
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
  /**
   * Units out with an ENGINEER on a job right now — ours to answer for, but not in the building.
   *
   * `received − returned` is what we owe the provider; subtract this and you have what is actually on
   * the shelf for a collecting driver. The warehouse pane shows the split, because one number made a
   * row read "3 held" when only 2 could be handed over.
   */
  issuedQuantity: number;
  /**
   * How many units of this hire could go out on a NEW job today — decided by the SERVER, using the
   * same rule the scan and the kit-request composer work from.
   *
   * Not the same as what is on the shelf: a hire whose period has ended, or one on an order the
   * supplier was never sent, can have units standing in the yard that nobody may issue. Never derived
   * on the client — the row does not carry the purchase order's status, so a screen cannot decide this
   * correctly, and a second implementation is how a pane comes to promise stock the scan then refuses.
   */
  availableToIssue: number;
  /** Reported damaged while with us — what the warehouse's rental pane filters on. */
  damagedQuantity: number;
  /**
   * Units currently unresolved-LOST — declared gone and not since recovered.
   *
   * They leave `heldOnHire`: we cannot hand back what we do not have, and a pane counting them as held
   * would offer a collecting driver equipment that is not in the building.
   */
  lostQuantity: number;
  /**
   * Units on the shelf currently held DAMAGED — what must not go out to a new job again.
   *
   * NOT the same number as `damagedQuantity`, and the difference matters on screen: that one is the
   * provider-facing lifetime total from their damage notes, including units already handed back; this
   * is what is broken and still here.
   */
  damagedHeldQuantity: number;
  /** Who is holding this hire's issued units right now — what "Declare lost" names the write-off against. */
  holders: { engineerId: string; engineerName: string; quantity: number }[];
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
  /**
   * True when `deliveryLocation` fell through to the delivery WAREHOUSE — no line address, no order
   * override. Lets a warehouse-scoped pane say "this warehouse" instead of printing its own name on
   * every row and burying the hires that genuinely go elsewhere.
   */
  deliveryAtWarehouse: boolean;
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
export type OnHireFilter = "all" | "expiring" | "overdue" | "awaiting" | "late" | "custody" | "returned" | "cancelled";

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
/**
 * What a hire note records.
 *
 * `loss` settles what the provider charges for equipment that never came back. It is NOT a movement —
 * the units left when the loss was declared — which is why it is a direction of its own rather than a
 * flavour of `damage`: a lost unit is barred from the damage note's cap outright, and folding the money
 * for one into the document for the other would tell the supplier a missing tester was merely broken.
 */
export type ReceiptDirection = "in" | "out" | "damage" | "loss";

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

/**
 * Hired equipment that left normal usable custody — returned broken, or never returned at all.
 *
 * The read shape of the record every rental write has been producing since damage and loss became
 * events rather than counters. It exists because the counters alone could not answer the questions
 * anyone actually asks of them: which job, which engineer, what happened, and has the provider been
 * charged for it yet.
 */
export interface HireCustodyExit {
  id: string;
  purchaseOrderRentalLineId: string;
  purchaseOrderId: string;
  poCode: string | null;
  warehouseId: string;
  kind: "damage" | "loss";
  qty: number;
  /** What it was — snapshotted, so the row shows an ITEM where every other damaged row shows one. */
  itemName: string;
  /** damage: held_damaged | returned_to_supplier | withdrawn — loss: lost | recovered. */
  custodyState: string;
  /** unsettled | settled | dismissed. Moves independently of custody — a credit note finds nothing. */
  settlementState: string;
  reason: string;
  notes: string | null;
  photoUrl: string | null;
  jobId: string | null;
  jobNumber: string | null;
  engineerId: string | null;
  engineerName: string | null;
  declaredBy: string | null;
  declaredAt: string;
  settledByReceiptId: string | null;
  settledAt: string | null;
  recoveredBy: string | null;
  recoveredAt: string | null;
  recoveryNotes: string | null;
  /**
   * The note this was settled on, identified — so a row can read "£90 · HLS-0002" without fetching it.
   *
   * `settledCharge` is null when the note carries no figure: nothing has been quoted yet, which is a
   * different fact from a charge of zero and must not be shown as one.
   */
  settledByCode: string | null;
  /** What was charged for THIS record's hire line on that note — never the whole document total. */
  settledCharge: number | null;
  /**
   * The date the settling note carries: when the damage was WRITTEN UP, as against `declaredAt`, which
   * is when it was FOUND. Both are true and they are days apart on anything written up in a batch.
   */
  settledNotedAt: string | null;
  /**
   * The NOTE this record was raised from, when that note is a warehouse damage report.
   *
   * Two different undos hang off a record: withdrawing the REPORT says the damage never happened,
   * withdrawing the CHARGE says the money was wrong while the tester stays broken. Each reverses a
   * different note. Null for damage found on a job — its source is a movement on the return, not a
   * note anybody can reverse.
   */
  sourceReceiptId: string | null;
  sourceCode: string | null;
  /**
   * Files on the note this record is tied to — the photographs a WAREHOUSE report carries.
   *
   * Damage found on a job keeps its picture on the record itself (`photoUrl`); damage found here is
   * filed on a form and its pictures are attachments to the note that form creates. Both are the same
   * evidence to whoever argues the charge, so the record carries both.
   */
  attachments: { id: string; url: string; fileName: string; fileType: string; fileSizeBytes: number }[];
  /** The note those files belong to — what a removal has to be addressed to. */
  attachmentsReceiptId: string | null;
}
