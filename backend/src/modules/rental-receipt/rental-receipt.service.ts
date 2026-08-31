import type { Prisma } from "@prisma/client";

import * as receiptRepo from "./rental-receipt.repository.js";
import type { RentalReceiptWithRelations } from "./rental-receipt.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { parseFilterDate } from "../../utils/filter-date.js";
import { instantForDay } from "../../utils/calendar-day.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import * as audit from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import { recomputeRentalReceiptStatus } from "#modules/purchase-order/purchase-order.service.js";
import type { ReceiptDirection } from "./rentalReceiptCode.js";
import { emitHireUpdated } from "#modules/purchase-order/rentalHire.realtime.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import { hireAtWarehouse, hireUntouched } from "#modules/purchase-order/rentalHire.allocation.js";
import type {
  CreateRentalReceiptInput,
  CreateRentalReturnInput,
  RecordDamageChargeInput,
  ChargeCustodyExitInput,
  ReportHireDamageInput,
  ReverseRentalReceiptInput,
} from "./rental-receipt.validation.js";

// ── Hire movements — supplier-owned kit arriving, going back, and breaking in between ───────────
//
// The rental counterpart of Goods In, and a separate module for a reason that is enforced, not merely
// intended: modules/__tests__/rental.boundary.test.ts fails the build if `goods-in` so much as
// mentions a rental model. A GRN's completion writes an inventory balance and a stock movement; hired
// kit is the supplier's, so it must never take that path.
//
// What this module owns: the record of each physical MOVEMENT of hired equipment — what arrived (in),
// what went back (out), what was found damaged while we had it (damage) — each with its own date,
// quantities, condition, the supplier's asset tags and photographs; the running totals on each hire
// line; and the moments a hire STARTS and ENDS. What it deliberately does not own: anything to do with
// stock.
//
// Three directions, ONE table and one set of rules, because a hire is a loop and the argument at the
// end of it is a COMPARISON: it arrived scratched — did it go back worse? That question is one query
// over one table. Split across three, it is a join nobody would write and an answer nobody would
// trust.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * When a hire can be RECEIVED — the goods-in window, exactly.
 *
 * Imported from the purchase-order repository rather than retyped, because "exactly" has to survive
 * the next edit: the client's rule is that a hire follows the IRM flow, and two hand-written lists
 * agreeing today is not the same as one list.
 *
 * It used to include `draft` (and `fully_received`), on the reasoning that paperwork lags reality and
 * a supplier who dropped kit off against a phone call has to be recordable. That put two Receive
 * buttons with two different rules on one purchase order, and it let a draft order be received
 * against — an order the supplier was never sent. Nothing is lost by narrowing it: a PRF-born draft
 * is already on the approval queue and an approved one on the awaiting-send queue, so the order is
 * being chased either way, and the work owed there is "approve and send", not "receive".
 */
const RECEIVABLE_PO_STATUSES = new Set<string>(poRepo.RECEIVABLE_PO_STATUSES);

/**
 * When a hire can be RETURNED or reported damaged — anywhere kit can still be in our hands.
 *
 * Wider than receiving on purpose, and it has to be: a fully-received order is the ordinary state for
 * a hire that is out, and restricting returns to the receiving window would make the last delivery
 * the moment the kit could no longer be handed back.
 *
 * `closed` is absent because closing is now refused while any hire is still out (see
 * closePurchaseOrder) — so a closed order has nothing left to return.
 */
const HOLDING_PO_STATUSES = new Set<string>([...poRepo.RECEIVABLE_PO_STATUSES, "fully_received"]);

export interface PublicRentalReceiptLine {
  id: string;
  purchaseOrderRentalLineId: string;
  itemName: string;
  baseUnit: string | null;
  orderedQuantity: number;
  previouslyReceived: number;
  receivedQuantity: number;
  damagedQuantity: number;
  assetTags: string[];
  notes: string | null;
  /**
   * What the supplier is charging for the damage on this line, in pounds.
   *
   * `null` is "no charge recorded", 0 is "they are not charging" — a real distinction, because a
   * damage report is written the day the fault is found and the quote arrives days later.
   */
  damageCharge: number | null;
}

export interface PublicRentalReceipt {
  id: string;
  code: string;
  /** in = delivered to us · out = gone back · damage = broken while we had it. */
  direction: ReceiptDirection;
  purchaseOrderId: string;
  poCode: string | null;
  supplierName: string | null;
  warehouseId: string;
  warehouseName: string | null;
  deliveryDate: string;
  carrier: string | null;
  deliveryNoteRef: string | null;
  condition: string;
  conditionNotes: string | null;
  notes: string | null;
  receivedBy: string | null;
  /** The supplier's quote or invoice number for the damage on this note. */
  damageChargeRef: string | null;
  /** Every line's charge added up, in pounds. Null when not one line carries a figure yet. */
  damageChargeTotal: number | null;
  /** Set once the note has been REVERSED — it moved nothing, and its quantities are given back. */
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  createdAt: string;
  lines: PublicRentalReceiptLine[];
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

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Pounds off the wire to integer pence, or NOTHING recorded.
 *
 * `null`/`undefined` stays null on purpose: a damage charge that has not been quoted yet is not a
 * charge of zero, and every screen tells the two apart. Rounded, because 44.99 * 100 is 4498.9999 in
 * binary floating point and truncation would quietly lose a penny per line.
 */
const toPence = (pounds: number | null | undefined): number | null =>
  pounds == null ? null : Math.round(pounds * 100);

const fromPence = (pence: number | null | undefined): number | null => (pence == null ? null : pence / 100);

function toPublic(r: RentalReceiptWithRelations): PublicRentalReceipt {
  return {
    id: r.id,
    code: r.code,
    direction: (r.direction ?? "in") as ReceiptDirection,
    purchaseOrderId: r.purchaseOrderId,
    poCode: r.poCode,
    supplierName: r.supplierName,
    warehouseId: r.warehouseId,
    warehouseName: r.warehouse?.name ?? null,
    deliveryDate: r.deliveryDate.toISOString(),
    carrier: r.carrier,
    deliveryNoteRef: r.deliveryNoteRef,
    condition: r.condition ?? "good",
    conditionNotes: r.conditionNotes,
    notes: r.notes,
    receivedBy: r.receivedBy,
    damageChargeRef: r.damageChargeRef,
    // Null, not 0, when nothing is on file — otherwise a note awaiting a quote reads as one the
    // supplier settled for nothing.
    damageChargeTotal: r.lines.some((l) => l.damageChargePence != null)
      ? r.lines.reduce((sum, l) => sum + (l.damageChargePence ?? 0), 0) / 100
      : null,
    reversedAt: iso(r.reversedAt),
    reversedBy: r.reversedBy,
    reversalReason: r.reversalReason,
    createdAt: r.createdAt.toISOString(),
    lines: r.lines.map((l) => ({
      id: l.id,
      purchaseOrderRentalLineId: l.purchaseOrderRentalLineId,
      itemName: l.itemName,
      baseUnit: l.baseUnit,
      orderedQuantity: l.orderedQuantity,
      previouslyReceived: l.previouslyReceived,
      receivedQuantity: l.receivedQuantity,
      damagedQuantity: l.damagedQuantity,
      assetTags: l.assetTags,
      notes: l.notes,
      damageCharge: fromPence(l.damageChargePence),
    })),
    attachments: r.attachments.map((a) => ({
      id: a.id,
      label: a.label,
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url: a.url,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * Every live delivery against a purchase order, newest first.
 *
 * Takes an id OR a code, like every other read in this codebase — the screens that link here carry
 * `PO-0063`, and a reader that only accepted an ObjectId answered a perfectly good code with
 * "Purchase order not found."
 */
export async function listForPurchaseOrder(idOrCode: string, actor?: AuditActor): Promise<PublicRentalReceipt[]> {
  const po = OBJECT_ID_RE.test(idOrCode) ? await poRepo.findById(idOrCode) : await poRepo.findByCode(idOrCode);
  if (!po) throw notFound("Purchase order not found.");
  if (po.warehouseId) assertWarehouseAccess(actor, po.warehouseId);
  const rows = await receiptRepo.findByPurchaseOrder(po.id);
  return rows.map(toPublic);
}

// ── The register ──────────────────────────────────────────────────────────────────────────────

export interface ListRentalReceiptsParams {
  search?: string;
  direction?: string;
  warehouse?: string;
  supplier?: string;
  purchaseOrder?: string;
  /** Inclusive calendar days, as the user typed them — the reporting period. */
  from?: string;
  to?: string;
  /** `false` drops reversed notes. Defaults to including them — see the filter's own note. */
  includeReversed?: boolean;
  page?: number;
  pageSize?: number;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export interface PagedRentalReceipts {
  receipts: PublicRentalReceipt[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** The three legs of the loop. A direction outside this set is not a filter, it is a typo. */
const DIRECTIONS = new Set(["in", "out", "damage"]);

/**
 * Every hire movement, filtered — the register the order page could not be.
 *
 * The actor's warehouse SCOPE applies alongside every other filter, exactly as it does on the GRN
 * register: a supplier or a date range narrows what this caller may already see, and can never widen
 * it. `assertWarehouseAccess` on the single-note read is the same rule at the other end.
 */
export async function listRentalReceipts(
  params: ListRentalReceiptsParams = {},
  actor?: AuditActor,
): Promise<PagedRentalReceipts> {
  const filters: receiptRepo.RentalReceiptListFilters = {
    search: params.search,
    // A direction the client invented would otherwise select nothing while the screen showed a
    // filter that looked applied — ignored instead, like every other unrecognised filter here.
    direction: DIRECTIONS.has(params.direction ?? "") ? params.direction : undefined,
    warehouseId: params.warehouse,
    warehouseIds: warehouseScopeFilter(actor),
    supplierId: params.supplier,
    purchaseOrderId: params.purchaseOrder,
    // The SHARED widening rule, not a local one. utils/filter-date says why in as many words: "a
    // second hand-written copy would eventually disagree with the first — and a To filter that
    // silently excludes the last day is the kind of bug nobody reports, they just stop trusting the
    // screen." This module had written its own; every other date-range filter in the app uses this.
    dateFrom: parseFilterDate(params.from, "start"),
    dateTo: parseFilterDate(params.to, "end"),
    includeReversed: params.includeReversed,
  };
  const total = await receiptRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await receiptRepo.findMany(filters, skip, pageSize);
  return { receipts: rows.map(toPublic), total, page, pageSize, totalPages };
}

/** What each direction is CALLED in a file somebody else will read. */
const DIRECTION_LABEL: Record<string, string> = {
  in: "Delivered to us",
  out: "Returned to supplier",
  damage: "Damage reported",
};

/** Units moved and units damaged on one note — the two numbers every register row is summed on. */
function noteTotals(r: PublicRentalReceipt): { moved: number; damaged: number } {
  return r.lines.reduce(
    (acc, l) => ({ moved: acc.moved + l.receivedQuantity, damaged: acc.damaged + l.damagedQuantity }),
    { moved: 0, damaged: 0 },
  );
}

/**
 * The SAME filtered register as a CSV, minus paging — the supplier-invoice reconciliation.
 *
 * Delegates to listRentalReceipts rather than re-deriving the filters, for the reason its own comment
 * gives: the actor's warehouse scope lives in there, and a second copy of a filter set is how a
 * download quietly stops matching the screen it was taken from.
 */
export async function exportRentalReceiptsCsv(
  params: ListRentalReceiptsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for, so
  // without it every export stopped at one page AND reported itself complete.
  const { receipts } = await listRentalReceipts({ ...params, ...EXPORT_PAGING }, actor);
  const rows = receipts.slice(0, EXPORT_MAX);
  const regional = await getRegionalSettings();
  // UTC on the movement date: it is a calendar day stored as UTC midnight, and formatting it in any
  // zone behind UTC shows the day before.
  const day = (isoDate: string) => formatDate(new Date(isoDate), regional.dateFormat, "UTC");

  const csv = toCsv(
    [
      "Note", "Movement", "Date", "Purchase Order", "Supplier", "Warehouse",
      "Delivery Note", "Carrier", "Condition", "Lines", "Units", "Damaged Units",
      // What the supplier is charging us for that damage, and their reference for it — the two
      // columns that turn this file from a movement log into something an invoice can be checked
      // against. Blank means no figure is on file yet, which is NOT the same as nothing to pay.
      "Damage Charge", "Damage Charge Ref",
      "Reversed", "Reversal Reason", "Recorded By",
    ],
    rows.map((r) => {
      const t = noteTotals(r);
      return [
        r.code,
        DIRECTION_LABEL[r.direction] ?? r.direction,
        day(r.deliveryDate),
        r.poCode,
        r.supplierName,
        r.warehouseName,
        r.deliveryNoteRef,
        r.carrier,
        r.condition,
        r.lines.length,
        // A REVERSED note moved nothing. Its quantities are still printed — the row has to be
        // readable — but the Reversed column beside them is what a reader filters on before summing,
        // and it is why that column is not optional in this file.
        t.moved,
        t.damaged,
        r.damageChargeTotal == null ? "" : r.damageChargeTotal.toFixed(2),
        r.damageChargeRef,
        r.reversedAt ? "yes" : "",
        r.reversalReason,
        r.receivedBy,
      ];
    }),
  );

  // `notes` and `conditionNotes` stay out, as on every other export in this codebase: staff free
  // text about a delivery, and sometimes about the supplier who sent it.
  audit.record({ actor, action: "rental_receipt.exported", targetType: "rental_receipt", targetLabel: `${rows.length} rows` });
  return { csv, capped: receipts.length > EXPORT_MAX };
}

/**
 * The same movements, ONE ROW PER ITEM — the file a hire is actually reconciled and disputed on.
 *
 * The header export says a note moved 4 units and 1 of them was damaged. This says WHICH item, with
 * which of the supplier's asset tags. At the end of a hire the argument is always about a specific
 * unit: it went back on this note, it was already marked damaged on that one. A header row cannot
 * carry that, because the item never appears in one.
 */
export async function exportRentalReceiptLinesCsv(
  params: ListRentalReceiptsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  const { receipts } = await listRentalReceipts({ ...params, ...EXPORT_PAGING }, actor);
  const notes = receipts.slice(0, EXPORT_MAX);
  const regional = await getRegionalSettings();
  const day = (isoDate: string) => formatDate(new Date(isoDate), regional.dateFormat, "UTC");

  const all = notes.flatMap((r) =>
    r.lines.map((l) => [
      r.code,
      DIRECTION_LABEL[r.direction] ?? r.direction,
      day(r.deliveryDate),
      r.poCode,
      r.supplierName,
      r.warehouseName,
      l.itemName,
      l.baseUnit,
      l.orderedQuantity,
      l.previouslyReceived,
      l.receivedQuantity,
      l.damagedQuantity,
      // Per ITEM, which is the only level a damage charge can be argued at: "£450 on this note" is
      // not a claim, "£450 for the tester" is.
      l.damageCharge == null ? "" : l.damageCharge.toFixed(2),
      // The supplier's own identifiers for the units that moved. The only thing that settles "is
      // this the unit you gave us" — flattened, because a spreadsheet cell holds one string.
      l.assetTags.join(" | "),
      r.reversedAt ? "yes" : "",
    ]),
  );
  // Capped on LINES, not notes: one delivery can carry hundreds.
  const rows = all.slice(0, EXPORT_MAX);

  const csv = toCsv(
    [
      "Note", "Movement", "Date", "Purchase Order", "Supplier", "Warehouse",
      "Item", "Unit", "Ordered Qty", "Previously Moved", "Units", "Damaged Units",
      "Damage Charge", "Asset Tags", "Reversed",
    ],
    rows,
  );

  audit.record({ actor, action: "rental_receipt.exported", targetType: "rental_receipt", targetLabel: `${rows.length} lines` });
  return { csv, capped: receipts.length > EXPORT_MAX || all.length > EXPORT_MAX };
}

/**
 * Resolve a movement by id OR by the code the register actually displays.
 *
 * `findById` is a `findUnique` on an `@db.ObjectId` column: handed anything that is not 24 hex it
 * raises Prisma P2023 ("Malformed ObjectID"), which the error middleware logs as a 5xx and answers
 * with a generic message — where every one of these paths plainly intends a 404. Since the register
 * shows codes, someone pasting HDN-0007 into a URL is the ordinary case, not an attack.
 *
 * One helper rather than the check written out at each call site, because it was written out at two
 * and forgotten at three.
 */
function findByIdOrCode(idOrCode: string) {
  return OBJECT_ID_RE.test(idOrCode) ? receiptRepo.findById(idOrCode) : receiptRepo.findByCode(idOrCode);
}

export async function getRentalReceipt(idOrCode: string, actor?: AuditActor): Promise<PublicRentalReceipt> {
  const r = await findByIdOrCode(idOrCode);
  if (!r) throw notFound("Hire delivery not found.");
  assertWarehouseAccess(actor, r.warehouseId);
  return toPublic(r);
}

/** What a hire line becomes, written in the note's own transaction. See HireLineWrite. */
type HireUpdate = receiptRepo.HireLineWrite;

/**
 * The order a note can be written against — loaded, scoped and checked once for all three directions.
 *
 * The status gate is the same in every direction on purpose. A cancelled or deleted order's hire lines
 * are excluded from every predicate in rentalHire.predicate.ts, so a note written against one would
 * move totals nothing reads and appear on no screen — which is worse than a refusal, because nobody
 * would find out.
 */
async function loadOrderForNote(
  purchaseOrderId: string,
  verb: string,
  // Receiving asks the goods-in window; the other two ask where kit can still be held. One function,
  // because everything else it checks — the order exists, the warehouse is in scope, it has hires — is
  // the same question three times.
  allowed: Set<string>,
  actor?: AuditActor,
) {
  const po = await poRepo.findById(purchaseOrderId);
  if (!po) throw notFound("Purchase order not found.");
  if (po.warehouseId) assertWarehouseAccess(actor, po.warehouseId);
  if (!po.warehouseId) throw badRequest("This purchase order has no delivery warehouse.");
  if (!allowed.has(po.status ?? "")) {
    throw conflict(`This purchase order is ${humanStatus(po.status ?? "")} and its hires can no longer be ${verb}.`);
  }
  if (po.rentalItems.length === 0) throw badRequest("This purchase order has no hire lines.");
  return po;
}

/** `pending_approval` reads as a state machine's key, not as English. */
const humanStatus = (s: string) => s.replace(/_/g, " ");

/**
 * Record a delivery of hired kit.
 *
 * Every quantity is re-checked against what is still OUTSTANDING on the live order, inside this call:
 * the form was drawn from a snapshot, and another receipt may have landed since. Over-receiving is
 * refused rather than clamped — a van that brought more than was ordered is a conversation with the
 * supplier, not a number for the system to quietly adjust.
 */
export async function createRentalReceipt(
  input: CreateRentalReceiptInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const po = await loadOrderForNote(input.purchaseOrderId, "received", RECEIVABLE_PO_STATUSES, actor);

  // The lines that actually delivered something. Zeroes are accepted on the wire (the form posts every
  // row it displayed) and dropped here, so a delivery records only what arrived on it.
  const posted = input.lines.filter((l) => l.receivedQuantity > 0);
  if (posted.length === 0) throw badRequest("Enter the quantity received on at least one line.");

  const byId = new Map(po.rentalItems.map((r) => [r.id, r]));
  const now = new Date();
  const lines: receiptRepo.NewReceiptLine[] = [];
  const hireUpdates: HireUpdate[] = [];

  for (const [i, l] of posted.entries()) {
    const hire = byId.get(l.purchaseOrderRentalLineId);
    if (!hire) throw badRequest("One of those lines is not on this purchase order.");
    if (hire.hireStatus === "returned") {
      throw conflict(`${hire.itemName} has already been returned — it can't take a new delivery.`);
    }
    // Closed short: somebody recorded that these units are never arriving, with a reason. If they
    // turn up after all that decision has to be revisited deliberately rather than overwritten by a
    // delivery — reopening a short close is not modelled, exactly as it is not for a customer stock
    // assignment. Checked BEFORE the outstanding maths below, which a short close has already zeroed.
    if (hire.hireStatus === "cancelled" || hire.shortClosedAt) {
      throw conflict(
        `${hire.itemName} was closed short — the outstanding units were recorded as not arriving. Reopen the hire before receiving against it.`,
      );
    }
    const already = hire.receivedQuantity ?? 0;
    const outstanding = hire.quantity - already;
    if (outstanding <= 0) {
      throw conflict(`${hire.itemName}: all ${hire.quantity} already received.`);
    }
    if (l.receivedQuantity > outstanding) {
      throw conflict(
        `${hire.itemName}: only ${outstanding} still outstanding (ordered ${hire.quantity}, already received ${already}).`,
      );
    }
    const damaged = l.damagedQuantity ?? 0;
    if (damaged > l.receivedQuantity) {
      throw badRequest(`${hire.itemName}: damaged can't be more than the quantity received.`);
    }
    lines.push({
      purchaseOrderRentalLineId: hire.id,
      itemName: hire.itemName,
      baseUnit: hire.baseUnit,
      orderedQuantity: hire.quantity,
      previouslyReceived: already,
      receivedQuantity: l.receivedQuantity,
      damagedQuantity: damaged,
      // Blanks dropped: a row of empty boxes on the form must not become empty strings in the record.
      assetTags: (l.assetTags ?? []).map((t) => t.trim()).filter(Boolean),
      notes: l.notes ?? null,
      sortOrder: i,
      // Never on the ARRIVAL leg. Damage that came with the kit is the supplier's own fault and is
      // evidenced against them; a charge recorded here would be us booking a payment for their
      // mistake. The request shape does not offer the field, and this says why.
      damageChargePence: null,
    });
    const total = already + l.receivedQuantity;
    hireUpdates.push({
      id: hire.id,
      expect: { receivedQuantity: already },
      data: {
        receivedQuantity: total,
        // Off the receiving queue only when every ordered unit is actually here. Written with the
        // number it summarises, in the same transaction, so the two can never drift.
        fullyReceived: total >= hire.quantity,
        // RE-DERIVED, not left alone. `fullyReturned` means "everything we currently hold has gone
        // back", which is a statement ABOUT `receivedQuantity` — so raising the one invalidates the
        // other. Receive 2, hand those 2 back, then receive the outstanding 3, and a stale `true`
        // would leave the line matching NO predicate at all: not `onHireWhere` (which asks for
        // `fullyReturned: false`), not `awaitingDeliveryWhere` (which asks for `fullyReceived:
        // false`). Three units of the supplier's kit in the yard, on no list, no badge and no
        // reminder — the exact disappearance the stored flags exist to prevent.
        fullyReturned: (hire.returnedQuantity ?? 0) >= total,
        // ANY quantity arriving starts the hire: the return deadline applies to the units that are
        // here, and a part delivery is still kit in our yard. How much is here is the quantity's job.
        ...(hire.hireStatus === "awaiting_delivery"
          ? { hireStatus: "on_hire", receivedAt: now, receivedBy: actor?.email ?? null }
          : {}),
      },
    });
  }

  const actorLabel = actor?.email ?? null;
  const receipt = await receiptRepo.createWithCode(
    {
      direction: "in",
      damageChargeRef: null,
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierId: po.supplierId ?? null,
      supplierName: po.supplierName ?? null,
      warehouseId: po.warehouseId,
      deliveryDate: input.deliveryDate,
      carrier: input.carrier ?? null,
      deliveryNoteRef: input.deliveryNoteRef ?? null,
      notes: input.notes ?? null,
      condition: input.condition ?? "good",
      conditionNotes: input.conditionNotes ?? null,
      receivedBy: actorLabel,
      createdBy: actorLabel,
    },
    lines,
    hireUpdates,
  );

  // The order's own received status follows its lines — hire lines included, which is what lets a
  // hire-only order ever reach `fully_received` instead of sitting in `sent` forever.
  //
  // NOT allowed to fail the request. The note is already committed at this point; a throw here would
  // answer a successful delivery with "Could not save that record", and the user would record the
  // same arrival again. The order's status is derived, so the next movement recomputes it anyway.
  try {
    await recomputeRentalReceiptStatus(po.id, actor);
  } catch (e) {
    console.error(`PO ${po.code} status recompute after ${receipt.code} failed:`, e instanceof Error ? e.message : e);
  }
  emitHireUpdated(po.id, po.code);

  audit.record({
    actor,
    action: "rental_receipt.created",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: {
      receipt: receipt.code,
      deliveryDate: input.deliveryDate.toISOString(),
      condition: receipt.condition,
      // `changes[]` is what the purchase order's own Audit Trail tab renders — without it the entry
      // reads as a bare action name with the detail visible only in the global log's raw JSON.
      changes: lines.map((l) => ({
        label:
          `${l.itemName}: received ${l.receivedQuantity} of ${l.orderedQuantity}` +
          (l.previouslyReceived > 0 ? ` (${l.previouslyReceived} previously)` : "") +
          (l.damagedQuantity > 0 ? ` · ${l.damagedQuantity} damaged on arrival` : "") +
          ` · ${receipt.code}`,
      })),
    },
  });
  return toPublic(receipt);
}

/**
 * Record kit going BACK to the supplier.
 *
 * The mirror of a delivery, and deliberately built as one rather than as a status flip: a hire ends in
 * a handover, the handover is where damage gets argued about, and a boolean cannot hold a date, a
 * quantity, a collector's name, a condition or a photograph. It is now the ONLY way a hire ends: the
 * old "mark returned" shortcut wrote no note at all, so every hire closed through it reported a blank
 * held period and a blank collection date on the register that exists to answer exactly that.
 *
 * Partial collections are ordinary: a supplier's van takes 3 of 5 today and the rest on Friday, so the
 * quantity is capped against what is still OUT (received minus already returned), re-read here rather
 * than trusted from the form's snapshot.
 */
export async function createRentalReturn(
  input: CreateRentalReturnInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const po = await loadOrderForNote(input.purchaseOrderId, "returned", HOLDING_PO_STATUSES, actor);

  const posted = input.lines.filter((l) => l.returnedQuantity > 0);
  if (posted.length === 0) throw badRequest("Enter the quantity returned on at least one line.");

  const byId = new Map(po.rentalItems.map((r) => [r.id, r]));
  const now = new Date();
  const lines: receiptRepo.NewReceiptLine[] = [];
  const hireUpdates: HireUpdate[] = [];
  // Damage already reported but not yet on any provider paper — read ONCE for the whole note rather
  // than per line. See the cap below for what it is netted against and why.
  const openDamage = await custodyExitRepo.openDamageQtyByLines(posted.map((l) => l.purchaseOrderRentalLineId));

  for (const [i, l] of posted.entries()) {
    const hire = byId.get(l.purchaseOrderRentalLineId);
    if (!hire) throw badRequest("One of those lines is not on this purchase order.");
    // Nothing can go back that never arrived. The honest answer to "we never took delivery" is to
    // cancel the hire, which this module does not model — so it says so rather than recording a
    // collection of equipment that was never in our hands.
    if (hire.hireStatus === "awaiting_delivery") {
      throw conflict(`${hire.itemName} hasn't been received yet — record the delivery before returning it.`);
    }
    if (hire.hireStatus === "returned") throw conflict(`${hire.itemName} has already been returned.`);
    // Nothing ever arrived against a cancelled hire, so there is nothing to hand back. (A hire that
    // partly arrived and was closed short is `on_hire` or `returned`, never `cancelled` — its held
    // units still go back through here normally.)
    if (hire.hireStatus === "cancelled") {
      throw conflict(`${hire.itemName} was cancelled — nothing was ever delivered against it.`);
    }

    // What we still HOLD for the provider: everything that arrived, less what has gone back, less what
    // is gone for good. A unit declared lost cannot be handed to a collecting driver — offering it here
    // would let a return note close a hire on equipment nobody can produce.
    const lost = hire.lostQuantity ?? 0;
    const here = (hire.receivedQuantity ?? 0) - lost;
    const already = hire.returnedQuantity ?? 0;
    const stillOut = here - already;
    if (stillOut <= 0) throw conflict(`${hire.itemName}: all ${here} received units have already gone back.`);
    if (l.returnedQuantity > stillOut) {
      throw conflict(
        `${hire.itemName}: only ${stillOut} still out (received ${here}, already returned ${already}).`,
      );
    }
    // Units in an ENGINEER'S VAN are not on the shelf for the provider to collect.
    //
    // Without this the warehouse can hand back a hire while some of it is physically on a job, and
    // the damage is not just a wrong number: `fullyReturned`/`hireStatus` go terminal, the hire drops
    // off the deadline badge that was the only thing chasing it, and an EngineerRentalHolding row is
    // left pointing at a hire the record says is finished. The kit then goes missing quietly, which is
    // the exact failure the rental module exists to prevent.
    //
    // `issuedQuantity` is a maintained column on the hire row (see schema.prisma), moved in the same
    // transaction as every job issue and return, so this reads one document and cannot disagree with
    // the custody ledger it summarises.
    const withEngineers = hire.issuedQuantity ?? 0;
    const onShelf = stillOut - withEngineers;
    if (withEngineers > 0 && l.returnedQuantity > onShelf) {
      throw conflict(
        `${hire.itemName}: only ${Math.max(0, onShelf)} of the ${stillOut} still out ${onShelf === 1 ? "is" : "are"} at the warehouse — ` +
          `${withEngineers} ${withEngineers === 1 ? "is" : "are"} out with an engineer on a job. ` +
          `Rental items have to be scanned back in before the provider collects them.`,
      );
    }
    const damaged = l.damagedQuantity ?? 0;
    if (damaged > l.returnedQuantity) {
      throw badRequest(`${hire.itemName}: damaged can't be more than the quantity returned.`);
    }
    // Damage is a count of UNITS, not of events — and this note is the SECOND place that count can be
    // written. A unit reported broken in week one and named again on the collection note six weeks
    // later is the same unit, but the charge total takes every note that is not a delivery
    // (movementDatesByHireLine), so it was billed twice while the tally it was billed against said
    // one. Capped against units NEVER recorded damaged, so the two cannot overlap.
    //
    // Against `received - alreadyDamaged` rather than `held - alreadyDamaged`: a unit that went back
    // damaged is off the site but still on the record, and the undamaged ones behind it can still
    // break. Netting it against what is HELD would refuse them.
    //
    // OPEN CUSTODY EXITS COUNT AS ALREADY REPORTED, even though they have moved no tally yet. That is
    // the whole gap: an engineer's damaged return opens an exit and leaves `damagedQuantity` at zero
    // deliberately — the tally moves when the exit is settled. Netted only against `alreadyDamaged`,
    // this note could name that same broken unit, and `chargeCustodyExit` would then advance the tally
    // AGAIN for the exit still standing open behind it. One fault, billed twice, on a total that ended
    // up higher than the units ever received. Those units are not lost to the note — they reach the
    // supplier through their own exit, with the engineer's words and photograph on it, which is the
    // stronger document anyway.
    const alreadyDamaged = hire.damagedQuantity ?? 0;
    const pendingDamage = openDamage.get(hire.id) ?? 0;
    const damageable = Math.max(0, Math.min(l.returnedQuantity, here - alreadyDamaged - pendingDamage));
    if (damaged > damageable) {
      throw conflict(
        `${hire.itemName}: only ${damageable} of the ${l.returnedQuantity} going back ` +
          `${damageable === 1 ? "is" : "are"} not already reported damaged` +
          (pendingDamage > 0
            ? ` — ${pendingDamage} ${pendingDamage === 1 ? "is" : "are"} on a damage report still waiting for a note. `
            : ". ") +
          `A unit already on a damage report keeps its charge there — recording it again would bill it twice.`,
      );
    }

    lines.push({
      purchaseOrderRentalLineId: hire.id,
      itemName: hire.itemName,
      baseUnit: hire.baseUnit,
      orderedQuantity: hire.quantity,
      previouslyReceived: already,
      receivedQuantity: l.returnedQuantity,
      damagedQuantity: damaged,
      assetTags: (l.assetTags ?? []).map((t) => t.trim()).filter(Boolean),
      notes: l.notes ?? null,
      sortOrder: i,
      // Usually null here and filled in later, when the supplier's quote arrives — see
      // recordDamageCharge. Accepted now for the case where the driver hands over the figure at
      // collection, which is common enough that refusing it would mean re-opening the note.
      damageChargePence: toPence(l.damageCharge),
    });

    const total = already + l.returnedQuantity;
    // The hire CLOSES only when everything ordered has arrived AND everything that arrived has gone
    // back. Closing it while units are still to be delivered would drop them out of the receiving
    // queue — `awaitingDeliveryWhere` excludes `returned` — and nobody would ever chase them again.
    const closes = total >= here && hire.fullyReceived;
    hireUpdates.push({
      id: hire.id,
      // `fullyReceived` is pinned alongside the total because `closes` is DERIVED from it. A short
      // close landing in the window flips it true; a return that then commits its stale `closes:
      // false` leaves the line `on_hire` with everything already back — refused by this path (nothing
      // still out), refused by mark-returned (collection records), and with Close short hidden on the
      // board. Losing the race has to mean reload-and-retry, and on the retry the hire closes.
      expect: { returnedQuantity: already, fullyReceived: hire.fullyReceived, damagedQuantity: alreadyDamaged },
      data: {
        returnedQuantity: total,
        // The SAME tally a damage report moves. Written here too, or damage found at the collection is
        // invisible to every screen that counts it while its charge is counted anyway — a hire
        // reading "Damaged Qty 0 · Damage Charge £450".
        damagedQuantity: alreadyDamaged + damaged,
        // Everything we hold has gone back. Kept separate from the status for the case above: this is
        // what takes the line off the return deadlines, whether or not the hire itself is finished.
        fullyReturned: total >= here,
        ...(closes ? { hireStatus: "returned", returnedAt: now, returnedBy: actor?.email ?? null } : {}),
      },
    });
  }

  const actorLabel = actor?.email ?? null;
  const receipt = await receiptRepo.createWithCode(
    {
      direction: "out",
      damageChargeRef: input.damageChargeRef ?? null,
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierId: po.supplierId ?? null,
      supplierName: po.supplierName ?? null,
      warehouseId: po.warehouseId,
      // One column for all three notes — see the schema's comment. On a return it is the date the
      // supplier collected, which is not always today: paperwork catches up.
      deliveryDate: input.returnDate,
      carrier: input.collectedBy ?? null,
      deliveryNoteRef: input.returnNoteRef ?? null,
      notes: input.notes ?? null,
      condition: input.condition ?? "good",
      conditionNotes: input.conditionNotes ?? null,
      receivedBy: actorLabel,
      createdBy: actorLabel,
    },
    lines,
    hireUpdates,
    // THE DAMAGE GOES BACK WITH THE KIT. `alsoInTx` runs after the hire counters have landed, so the
    // reconciliation reads the shelf this collection just left behind rather than the one before it.
    //
    // No note field says which damaged units the driver took — a collection note's own damage column
    // is capped against units never reported, so it can only ever describe NEW damage found at the
    // door. The shelf is the evidence: it cannot hold more damaged units than it holds units.
    async (tx) => {
      for (const l of lines) {
        await custodyExitRepo.reconcileDamageCustodyTx(tx, l.purchaseOrderRentalLineId);
      }
    },
  );

  // Deliberately NOT recomputing the order's received status: a return does not un-receive anything.
  // The order stayed `fully_received` the moment the kit arrived, and it still did arrive.
  emitHireUpdated(po.id, po.code);

  audit.record({
    actor,
    action: "rental_return.created",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: {
      receipt: receipt.code,
      returnDate: input.returnDate.toISOString(),
      condition: receipt.condition,
      changes: lines.map((l) => ({
        label:
          `${l.itemName}: returned ${l.receivedQuantity}` +
          (l.previouslyReceived > 0 ? ` (${l.previouslyReceived} previously)` : "") +
          (l.damagedQuantity > 0 ? ` · ${l.damagedQuantity} damaged` : "") +
          ` · ${receipt.code}`,
      })),
    },
  });
  return toPublic(receipt);
}

/**
 * Report damage found while the kit is WITH US — a note that moves nothing.
 *
 * The third direction exists because the other two only fire at the ends of a hire, and a six-week
 * hire breaks in the middle of one. Recorded when it happens, with a photograph, it is evidence; the
 * same fact typed into a return note six weeks later is our word against the supplier's.
 *
 * No quantity on the hire line moves: the equipment is still here and still on hire. What the report
 * carries is the count, the units' asset tags, the words and the pictures.
 */
export async function reportHireDamage(
  input: ReportHireDamageInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const po = await loadOrderForNote(input.purchaseOrderId, "reported on", HOLDING_PO_STATUSES, actor);

  const posted = input.lines.filter((l) => l.damagedQuantity > 0);
  if (posted.length === 0) throw badRequest("Enter how many units are damaged on at least one line.");

  const byId = new Map(po.rentalItems.map((r) => [r.id, r]));
  // WHAT IS ALREADY REPORTED AND UNPRICED on the lines this note touches — one grouped query for the
  // whole note, never one per line. Subtracted from what this note may report, so a message can name
  // the figure. NOT the authoritative cap: that is re-read inside the transaction below.
  const capsByLine = await custodyExitRepo.damageCapFiguresByLines(posted.map((l) => l.purchaseOrderRentalLineId));
  const lines: receiptRepo.NewReceiptLine[] = [];
  const hireUpdates: HireUpdate[] = [];
  // Built alongside the note's own lines and written once the note has an id — a custody exit is
  // keyed on the document that justifies it, and that id does not exist until the note is created.
  const exitsToOpen: (Omit<custodyExitRepo.NewCustodyExit, "sourceId"> & { sourceType: string })[] = [];
  // What the cap below decided, kept so the SAME arithmetic can be re-run inside the note's own
  // transaction. `ceiling` is the half that cannot move behind us — it is built from `receivedQuantity`
  // and `damagedQuantity`, and every hire line carries `expect: { damagedQuantity }` so a concurrent
  // move of either aborts the write anyway. Only `quarantinedNotTallied` is re-read. See the reassert.
  const capChecks: { lineId: string; itemName: string; ceiling: number; want: number }[] = [];
  const actorLabelForExits = actor?.email ?? null;

  for (const [i, l] of posted.entries()) {
    const hire = byId.get(l.purchaseOrderRentalLineId);
    if (!hire) throw badRequest("One of those lines is not on this purchase order.");
    if (hire.hireStatus === "awaiting_delivery") {
      throw conflict(`${hire.itemName} hasn't been received yet — it can't be damaged in our hands.`);
    }
    if (hire.hireStatus === "returned") {
      throw conflict(`${hire.itemName} has gone back — damage found after a return is the supplier's to raise.`);
    }
    // Nothing was ever delivered against a cancelled hire, so nothing of it can have been damaged
    // here. (`awaiting_delivery` above says the same thing for a hire still expected.)
    if (hire.hireStatus === "cancelled") {
      throw conflict(`${hire.itemName} was cancelled — nothing was ever delivered against it.`);
    }
    // Capped at what we actually HOLD, MINUS what is already reported damaged.
    //
    // Both halves matter. Against the order it would let three be damaged out of two on site, and a
    // typo in a damage claim is what the supplier's side of the argument is built on. Against the
    // holding alone it would let the SAME unit be reported twice — a 1-unit line reported damaged
    // today and again tomorrow would carry a running total of 2, which is a number that cannot be
    // true. The screens clamp it back to what is held, so the wrong figure would sit in the database
    // looking right on every page that reads it.
    //
    // This is a count of damaged UNITS, not of damage events. A second fault on a unit already
    // reported is more evidence about the same unit, and belongs on the note that already names it.
    // Netting LOST off as well: damage is a claim about equipment's condition, and a claim about a unit
    // nobody can produce is the weakest possible position in a dispute with the provider.
    const held = (hire.receivedQuantity ?? 0) - (hire.returnedQuantity ?? 0) - (hire.lostQuantity ?? 0);
    if (held <= 0) throw conflict(`${hire.itemName}: nothing from this line is still with us.`);
    const alreadyDamaged = hire.damagedQuantity ?? 0;
    const caps = capsByLine.get(hire.id) ?? { quarantinedNotTallied: 0 };
    const alreadyReported = caps.quarantinedNotTallied;
    // MORE DAMAGE WAS FOUND — the only thing this note can mean. Three ceilings and the lowest wins:
    // only kit HELD can be broken here, only units never recorded damaged are left to record, and —
    // the term this cap was missing — only units that no report is ALREADY holding out of the pool.
    //
    // That third term is the whole double-quarantine guard, and it is what let the choice go away. The
    // guard used to be enforced by CONSUMING the open report, which is precisely why a new fault could
    // not be told from an old one. Enforced as arithmetic instead, both facts can be true at once — 1
    // unit reported by the engineer, 1 more found here, 2 units broken — and this endpoint cannot
    // quarantine one physical unit twice however it is called.
    //
    // `quarantinedNotTallied` counts DISMISSED reports too: dismissing drops the claim, not the damage,
    // so the unit is still broken, still on the shelf and still out of the pool.
    //
    // `received - alreadyDamaged` is netted against what was RECEIVED, not what is held — a unit that
    // went back damaged is off the site but still on the record, and netting it against the holding
    // would quietly refuse an undamaged unit standing behind it.
    const ceiling = Math.min(held, (hire.receivedQuantity ?? 0) - alreadyDamaged);
    const reportable = ceiling - alreadyReported;
    capChecks.push({ lineId: hire.id, itemName: hire.itemName, ceiling, want: l.damagedQuantity });
    if (reportable <= 0) {
      // Says where the rest went, and sends them to the record that owns it rather than offering to
      // absorb it here. See the note on `damageLineSchema`.
      throw conflict(
        alreadyReported > 0
          ? `${hire.itemName}: every unit with us is already recorded as damaged — ${alreadyReported} of them on ${alreadyReported === 1 ? "a report" : "reports"} you can charge or dismiss from the order's damage list.`
          : `${hire.itemName}: all ${held} unit${held === 1 ? "" : "s"} with us ${held === 1 ? "is" : "are"} already reported damaged.`,
      );
    }
    if (l.damagedQuantity > reportable) {
      throw conflict(
        `${hire.itemName}: only ${reportable} of the ${held} with us ${reportable === 1 ? "is" : "are"} not already recorded as damaged${alreadyReported > 0 ? ` (${alreadyReported} ${alreadyReported === 1 ? "is" : "are"} on an existing report)` : ""}.`,
      );
    }

    lines.push({
      purchaseOrderRentalLineId: hire.id,
      itemName: hire.itemName,
      baseUnit: hire.baseUnit,
      orderedQuantity: hire.quantity,
      previouslyReceived: hire.receivedQuantity ?? 0,
      // Both, and equal: `receivedQuantity` is "the units this note is about" and every one of them
      // is damaged. It keeps `damagedQuantity <= receivedQuantity` true in all three directions, so
      // one reader can total any note without asking which kind it is.
      receivedQuantity: l.damagedQuantity,
      damagedQuantity: l.damagedQuantity,
      assetTags: (l.assetTags ?? []).map((t) => t.trim()).filter(Boolean),
      notes: l.notes ?? null,
      sortOrder: i,
      damageChargePence: toPence(l.damageCharge),
    });
    // The ONE number a damage report moves: what the warehouse's own pane counts as damaged hire kit
    // at its site. Written in the note's transaction, so the pane can never show a total the records
    // do not add up to.
    hireUpdates.push({
      id: hire.id,
      expect: { damagedQuantity: alreadyDamaged },
      data: { damagedQuantity: alreadyDamaged + l.damagedQuantity },
    });
    // …and a custody exit, which is what actually takes the units out of the ISSUABLE pool. EVERY
    // damage event opens one, whichever door it came in by — a return scan or this note — because one
    // physical event must be one row. Counting the note total AND a separate field-damage figure would
    // quarantine the same tester twice.
    //
    // Born SETTLED: this note is the settlement document, so there is nothing left for the office to
    // do and the row must not appear on the "needs a note" worklist it was created from.
    exitsToOpen.push({
      purchaseOrderRentalLineId: hire.id,
      purchaseOrderId: po.id,
      poCode: po.code,
      warehouseId: po.warehouseId,
      kind: "damage" as const,
      qty: l.damagedQuantity,
      itemName: hire.itemName,
      custodyState: custodyExitRepo.CUSTODY_HELD_DAMAGED,
      reason: input.conditionNotes?.trim() || l.notes?.trim() || "Damage found while the equipment was with us",
      notes: l.notes ?? null,
      declaredBy: actorLabelForExits,
      // The day the FORM says the damage was found, not the moment this note was typed. Those are the
      // same day for a report written the day it happened and days apart for the ones written up in a
      // batch, and the record is read beside the note that carries the reported date — a record
      // disagreeing with its own note is the kind of discrepancy a supplier gets to point at.
      declaredAt: instantForDay(input.reportedDate),
      sourceType: "warehouse_damage_note",
    });
  }

  const actorLabel = actor?.email ?? null;
  const receipt = await receiptRepo.createWithCode(
    {
      direction: "damage",
      damageChargeRef: input.damageChargeRef ?? null,
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierId: po.supplierId ?? null,
      supplierName: po.supplierName ?? null,
      warehouseId: po.warehouseId,
      deliveryDate: input.reportedDate,
      carrier: null,
      deliveryNoteRef: null,
      notes: input.notes ?? null,
      condition: "damaged",
      conditionNotes: input.conditionNotes,
      receivedBy: actorLabel,
      createdBy: actorLabel,
    },
    lines,
    // No equipment moves — it is where it was. Only the damaged tally moves, because only what we
    // know about it has changed.
    hireUpdates,
    // The custody exits, in the note's own transaction. They quarantine the units and the note settles
    // them; born together so no window exists in which a damage note is on file and its equipment is
    // still being offered to the next engineer.
    async (tx, receiptId) => {
      // THE CAP, RE-ASSERTED WHERE IT IS AUTHORITATIVE. The preflight read above shapes the form's
      // refusal message; this one decides. Between the two, an engineer scanning a damaged return can
      // open a `held_damaged` exit — which moves `quarantinedNotTallied` WITHOUT touching
      // `damagedQuantity`, the only figure the hire lines' optimistic `expect` watches — so a note
      // built on the stale figure could quarantine one physical unit twice.
      //
      // Throwing here aborts the whole transaction: no receipt, no note lines, no tally move, no
      // custody rows and no charge. A half-written damage claim is the one outcome worse than a
      // refused one, and this is the seam that guarantees there cannot be one.
      const capsNow = await custodyExitRepo.damageCapFiguresByLinesTx(tx, capChecks.map((c) => c.lineId));
      for (const c of capChecks) {
        const roomNow = c.ceiling - (capsNow.get(c.lineId)?.quarantinedNotTallied ?? 0);
        if (c.want > roomNow) {
          throw conflict(
            `${c.itemName}: more damage was reported on this line while you were filling this in — only ${Math.max(0, roomNow)} of the units with us ${roomNow === 1 ? "is" : "are"} not already recorded as damaged. Reload the order and check the damage list before filing.`,
          );
        }
      }
      const settledAt = new Date();
      for (const e of exitsToOpen) {
        // ITS OWN EVENT, ALWAYS. Its date, its words, its evidence and its charge stay on it, and no
        // report already on file is read, settled or re-dated. The re-assert directly above guaranteed
        // — in this transaction — that there are unquarantined units for it to be about, so nothing
        // here has to negotiate with the past.
        const exit = await custodyExitRepo.createExitTx(tx, { ...e, sourceId: receiptId });
        await custodyExitRepo.moveSettlementStateTx(tx, exit.id, custodyExitRepo.SETTLE_UNSETTLED, custodyExitRepo.SETTLE_SETTLED, {
          settledByReceiptId: receiptId,
          settledAt,
        });
      }
    },
  );

  emitHireUpdated(po.id, po.code);

  audit.record({
    actor,
    action: "rental_damage.reported",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: {
      receipt: receipt.code,
      reportedDate: input.reportedDate.toISOString(),
      // NEWLY FOUND, said so. This action can no longer mean anything else — settling damage already
      // on file is `rental_damage.charged` or `rental_damage.dismissed`, each naming its own record —
      // so the trail keeps the three as three.
      changes: exitsToOpen.map((e) => ({
        label: `${e.itemName}: ${e.qty} newly found damaged in service · ${receipt.code}`,
      })),
    },
  });
  return toPublic(receipt);
}

/**
 * Reverse a note — it did not happen, or it was recorded wrongly.
 *
 * "Reverse" and not "cancel": everywhere else in this codebase cancelling means stopping something
 * BEFORE it takes effect (a draft goods receipt, a pending purchase order, an un-issued van stock
 * line). This undoes an effect that has already landed, which is a different act — and the one word
 * this app does not otherwise use for anything.
 *
 * The record is kept and marked, never deleted: it is what the hire's quantities moved on, and a number
 * that changed for no readable reason is worse than a number that was wrong. The totals are RECOMPUTED
 * from the notes that remain rather than decremented, so the result is always the sum of what is still
 * on file — arithmetic on a number that has already drifted just moves the drift.
 *
 * What unwinding means depends on which way the kit went:
 *   in     — the units go back to outstanding; a hire whose total falls to zero returns to awaiting
 *            delivery, because nothing ever arrived.
 *   out    — the units are OUT again; a hire that had closed reopens, because it demonstrably did not
 *            go back.
 *   damage — no equipment to unwind. The note moved none; reversing it withdraws the claim and the
 *            damaged tally it added.
 */
export async function reverseRentalReceipt(
  id: string,
  input: ReverseRentalReceiptInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const existing = await findByIdOrCode(id);
  if (!existing) throw notFound("Hire record not found.");
  assertWarehouseAccess(actor, existing.warehouseId);
  if (existing.reversedAt) throw conflict("That record has already been reversed.");

  const direction = (existing.direction ?? "in") as ReceiptDirection;
  const po = await poRepo.findById(existing.purchaseOrderId);
  if (!po) throw conflict("The purchase order for this record no longer exists.");
  // A TERMINAL order takes no more movements, and a reversal is a movement — it is the one that
  // creates quantity rather than consuming it.
  //
  // Reversing a return on a closed order put the hire back to `on_hire` while the order stayed
  // closed: the deadline badges started chasing it again, `Return hire` refused it (a closed order is
  // outside the holding window), and there was no way out left at all. It also produced the exact
  // state closePurchaseOrder refuses to create, from the other direction.
  //
  // Refused rather than reopened: "a receipt must never reopen or mutate a closed or cancelled order"
  // is this module's rule, and a closed order's money is settled. A wrong record left standing in the
  // trail of a finished order is a smaller problem than a live hire nobody can close.
  if (po.status === "closed" || po.status === "cancelled") {
    throw conflict(
      `This purchase order is ${po.status} — its hire records can no longer be reversed.`,
    );
  }

  // ── WHAT A REVERSAL MEANS FOR CUSTODY, WHICH IS NOT ONE THING ────────────────────────────────
  //
  // Withdrawing a note undoes a CLAIM. Whether it also undoes a quarantine depends entirely on where
  // that quarantine came from, and the two cases are opposites:
  //
  //   • an exit this note CREATED (a warehouse damage report) — the report itself is withdrawn, so
  //     the units were never damaged of record and must return to the issuable pool.
  //   • an exit this note SETTLED (damage an engineer reported from a job, or a declared loss) — the
  //     damage still happened and the tester is still broken. Only the charge is withdrawn, so the row
  //     goes back to UNSETTLED and onto the worklist. Putting a broken unit back on the shelf because
  //     a credit note was raised is exactly the confusion the two-column state model exists to prevent.
  //
  // BOTH MOVES ARE COMPARE-AND-SET, AND BOTH ARE CHECKED. `moveSettlementStateTx` and
  // `moveCustodyStateTx` return whether they matched; ignoring that return is what makes a state
  // machine drift, because the failure looks exactly like success — the note gets stamped reversed,
  // the record it was supposed to release keeps its old state, and no total, log or screen disagrees
  // with any other. Throwing aborts the whole transaction, so the note stays live and the operator is
  // told what changed underneath them, which is the only outcome that leaves the two in step.
  const unwindCustody = async (tx: Prisma.TransactionClient): Promise<void> => {
    for (const exit of await custodyExitRepo.findByReceiptTx(tx, existing.id)) {
      const released = await custodyExitRepo.moveSettlementStateTx(
        tx,
        exit.id,
        custodyExitRepo.SETTLE_SETTLED,
        custodyExitRepo.SETTLE_UNSETTLED,
        { settledByReceiptId: null, settledAt: null },
      );
      if (!released) {
        throw conflict(
          `${exit.itemName}: the record this note settled is no longer settled against it — reload and check it before reversing again.`,
        );
      }
    }
    for (const exit of await custodyExitRepo.findBySourceTx(tx, existing.id)) {
      if (exit.kind !== "damage") continue;
      // Takes the record back whether the units are still here or already back with the provider —
      // see withdrawDamageExitTx. A wrong report is usually found when they dispute the invoice, which
      // is after they have collected.
      const withdrawn = await custodyExitRepo.withdrawDamageExitTx(tx, exit.id);
      if (!withdrawn) {
        throw conflict(
          `${exit.itemName}: this report has already been withdrawn — there is nothing left to take back.`,
        );
      }
      await custodyExitRepo.recomputeCountersTx(tx, exit.purchaseOrderRentalLineId);
    }
  };

  const reversed = await receiptRepo.reverseReceipt(
    existing.id,
    { reversedAt: new Date(), reversedBy: actor?.email ?? null, reversalReason: input.reason },
    // The recompute, handed over as work rather than as a result. Everything it reads — the live note
    // totals AND the hire lines it compares them against — is then read through the same transaction
    // that writes the answer, so a movement committed a moment ago cannot be silently overwritten.
    // The guards inside it (already returned, already partly back) throw from in there too, which
    // aborts the transaction: exactly what should happen when the reversal is no longer legitimate.
    async (tx) => {
      const updates = await buildReversalUpdates(direction, existing, tx);
      await unwindCustody(tx);
      return updates;
    },
    // AFTER the counters land, because the shelf is what this reads. Reversing a collection puts units
    // back on it, and the damage records that went out with them have to come back too — otherwise a
    // corrected collection leaves the equipment here and its damage still filed as gone.
    //
    // Only the two legs that move the shelf. A damage report and a loss settlement change no quantity,
    // so there is nothing for this to re-partition and their own paths already recompute the counters.
    direction === "in" || direction === "out"
      ? async (tx) => {
          for (const l of existing.lines) {
            await custodyExitRepo.reconcileDamageCustodyTx(tx, l.purchaseOrderRentalLineId);
          }
        }
      : undefined,
  );

  // Only an arrival can change how much of the ORDER has been received. Same rule as the create
  // path: the reversal has committed, so a failure here is logged rather than thrown back.
  if (direction === "in") {
    try {
      // `allowDowngrade`: this is the one operation that takes received quantity AWAY, so the order's
      // status has to be able to follow it back. Without it a reversed delivery left the order saying
      // `fully_received` with nothing received — and an order outside the receiving window shows no
      // Receive button and appears on no warehouse queue, so the units just given back went nowhere.
      await recomputeRentalReceiptStatus(existing.purchaseOrderId, actor, { allowDowngrade: true });
    } catch (e) {
      console.error(`PO ${po.code} recompute after reversing ${existing.code} failed:`, e instanceof Error ? e.message : e);
    }
  }
  emitHireUpdated(po.id, po.code);

  audit.record({
    actor,
    action: REVERSAL_AUDIT_ACTION[direction],
    targetType: "purchase_order",
    targetId: existing.purchaseOrderId,
    targetLabel: po.code,
    metadata: {
      receipt: existing.code,
      reason: input.reason,
      changes: existing.lines.map((l) => ({
        label: `${l.itemName}: ${existing.code} reversed — ${reversalLabel(direction, l.receivedQuantity)}`,
      })),
    },
  });
  return toPublic(reversed);
}

/**
 * Record what the supplier is charging for damage — on a note that already exists.
 *
 * THE ONE VALUE ON A NOTE THAT DOES NOT NEED A REVERSAL TO CHANGE, and the reason is precise rather
 * than convenient: every quantity on a note feeds a running total on the hire line, so editing one
 * would leave a stored figure disagreeing with the records it summarises — which is why the module
 * reverses instead of editing. A charge feeds nothing. Correcting it can make no total wrong.
 *
 * It exists because of when money arrives. The damage is found on a Tuesday and written down that
 * day; the supplier's quote comes the following week, and their invoice after that. A charge that
 * could only be entered with the report would be a guess, and a guessed zero is indistinguishable
 * from a settled one — so the report is written when the damage is found, and the money lands here.
 *
 * `rentals.hire.settle`, not the bare floor permission: agreeing what we owe a supplier is a commercial
 * act, and the person with the scanner should not need — or be given — that authority to do their job.
 */
export async function recordDamageCharge(
  idOrCode: string,
  input: RecordDamageChargeInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const existing = OBJECT_ID_RE.test(idOrCode)
    ? await receiptRepo.findById(idOrCode)
    : await receiptRepo.findByCode(idOrCode);
  if (!existing) throw notFound("Hire movement not found.");
  assertWarehouseAccess(actor, existing.warehouseId);

  const direction = (existing.direction ?? "in") as ReceiptDirection;
  // Damage recorded ON ARRIVAL is the supplier's own fault, already evidenced against them on their
  // own delivery note. A charge against it would be us booking a payment for their mistake — and it
  // is a mistake somebody would only make by opening the wrong note.
  if (direction === "in") {
    throw badRequest(
      "This is a delivery note — damage recorded on arrival is the supplier's own and cannot be charged to us. Record the charge on the damage report or the return.",
    );
  }
  // A reversed note withdrew its claim. Money against a withdrawn claim would be counted by every
  // total that reads live rows only, and matched by nothing.
  if (existing.reversedAt) {
    throw conflict(`${existing.code} has been reversed — its claim was withdrawn, so it carries no charge.`);
  }

  const byLine = new Map(existing.lines.map((l) => [l.purchaseOrderRentalLineId, l]));
  const updates: { purchaseOrderRentalLineId: string; damageChargePence: number | null }[] = [];
  for (const l of input.lines ?? []) {
    const line = byLine.get(l.purchaseOrderRentalLineId);
    // Named rather than ignored: a silent no-op leaves somebody looking at a figure they typed and a
    // note that does not carry it, with nothing on screen saying which line was dropped.
    if (!line) throw badRequest(`${existing.code} has no line for one of the items sent.`);
    // A charge against a line nobody said was damaged has no claim behind it, and is far more likely
    // to be a figure typed on the wrong row than a real one. Clearing is always allowed.
    if (l.damageCharge != null && line.damagedQuantity <= 0) {
      throw badRequest(`${line.itemName} has no damage recorded on this note, so it cannot carry a charge.`);
    }
    updates.push({ purchaseOrderRentalLineId: l.purchaseOrderRentalLineId, damageChargePence: toPence(l.damageCharge) });
  }

  const saved = await receiptRepo.updateDamageCharges(existing.id, input.damageChargeRef, updates);
  emitHireUpdated(saved.purchaseOrderId, saved.poCode ?? "");

  audit.record({
    actor,
    action: "rental_damage.charge_recorded",
    targetType: "purchase_order",
    targetId: existing.purchaseOrderId,
    targetLabel: existing.poCode ?? existing.code,
    metadata: {
      receipt: existing.code,
      reference: input.damageChargeRef,
      // BOTH figures per line, because this is money and it can be edited: without the old one the
      // trail says what it is now and gives no way to see that it moved.
      changes: updates.map((u) => {
        const line = byLine.get(u.purchaseOrderRentalLineId)!;
        const before = line.damageChargePence;
        const money = (p: number | null) => (p == null ? "nothing recorded" : `£${(p / 100).toFixed(2)}`);
        return { label: `${line.itemName}: damage charge ${money(before)} → ${money(u.damageChargePence)}` };
      }),
    },
  });
  return toPublic(saved);
}

/**
 * Put ONE custody exit to the provider and record what they are charging — in a single act.
 *
 * ── Why this is not the report form ────────────────────────────────────────────────────────────
 *
 * Damage found at the warehouse is REPORTED on a form, and the note that form creates then carries a
 * charge, entered afterwards through a small dialog. Damage found on a job has already been reported —
 * by the engineer, with a photograph and their own words, on the day it happened. Sending that person
 * to the report form asked them to describe, date and count something somebody else had already
 * recorded, from memory, with the real account one click away and unread.
 *
 * The missing half is only the money. So this raises the provider's document FROM the record that
 * already exists, and the same dialog the warehouse leg uses collects the figure. Nothing is retyped
 * and nothing is reported twice.
 *
 * ── What it writes ─────────────────────────────────────────────────────────────────────────────
 *
 * A note of the matching direction — `damage` (HDM) or `loss` (HLS) — carrying the exit's own quantity,
 * words and date, and then the exit is settled against it. NO QUANTITY MOVES: the units moved when the
 * damage came back or the loss was declared, and a charge moves no equipment.
 *
 * The DAMAGE leg still advances the hire's provider-facing `damagedQuantity`, exactly as the report
 * form does — that figure is what the supplier bills against, and it is a different number from the
 * custody count that keeps the unit out of the issuable pool.
 *
 * Uncapped, and safely so: every writer of that tally leaves `damagedQuantity + open damage exits ≤
 * received` true, so an exit that still stands open has room reserved for it by construction. The two
 * notes that could have taken it both refuse to — a warehouse report CONSUMES open exits
 * (`damageCapFiguresByLines`) and a collection note NETS them out of its cap
 * (openDamageQtyByLines). Capping here as well would be unreachable, and reaching it would strand the
 * exit on the worklist with no document able to clear it.
 */
export async function chargeCustodyExit(
  exitId: string,
  input: ChargeCustodyExitInput,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const exit = await custodyExitRepo.findById(exitId);
  if (!exit) throw notFound("That record no longer exists.");
  assertWarehouseAccess(actor, exit.warehouseId);
  if (exit.settlementState !== custodyExitRepo.SETTLE_UNSETTLED) {
    throw conflict("This record has already been settled with the provider.");
  }
  // A withdrawn report never happened and a recovered loss is back on the shelf. Money against either
  // would be counted by every total that reads live records, and matched by nothing.
  if (exit.custodyState === custodyExitRepo.CUSTODY_WITHDRAWN || exit.custodyState === custodyExitRepo.CUSTODY_RECOVERED) {
    throw conflict("This record has been withdrawn — there is nothing to charge against it.");
  }

  const isLoss = exit.kind === "loss";
  const po = await loadOrderForNote(exit.purchaseOrderId, isLoss ? "settled on" : "reported on", HOLDING_PO_STATUSES, actor);
  const hire = po.rentalItems.find((r) => r.id === exit.purchaseOrderRentalLineId);
  if (!hire) throw conflict("That hire is no longer on this order.");

  const chargePence = toPence(input.charge ?? undefined);
  const actorLabel = actor?.email ?? null;

  const receipt = await receiptRepo.createWithCode(
    {
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      warehouseId: po.warehouseId,
      direction: isLoss ? "loss" : "damage",
      // The day it was FOUND, not today. A supplier charge is argued from when the fault happened, and
      // stamping the invoice date onto it quietly rewrites that.
      deliveryDate: exit.declaredAt,
      carrier: null,
      deliveryNoteRef: null,
      damageChargeRef: input.chargeRef?.trim() || null,
      condition: isLoss ? "lost" : "damaged",
      // The engineer's own words. This is the sentence a supplier's charge is argued against, and it
      // is worth more than anything retyped from memory a week later.
      conditionNotes: exit.reason,
      notes: exit.notes,
      receivedBy: null,
      createdBy: actorLabel,
    },
    [
      {
        purchaseOrderRentalLineId: hire.id,
        itemName: hire.itemName,
        baseUnit: hire.baseUnit,
        orderedQuantity: hire.quantity,
        previouslyReceived: hire.receivedQuantity ?? 0,
        // "The units this note is about" — both columns on a damage note, and `damagedQuantity` zero on
        // a loss, whose units were never damaged and must never reach the figure the provider bills
        // damage on.
        receivedQuantity: exit.qty,
        damagedQuantity: isLoss ? 0 : exit.qty,
        assetTags: [],
        notes: exit.notes,
        sortOrder: 0,
        damageChargePence: chargePence,
      },
    ],
    // The provider-facing damaged total, advanced exactly as the report form advances it. Guarded on
    // the value read, so a note landing in the gap invalidates this write rather than overwriting it.
    isLoss
      ? []
      : [
          {
            id: hire.id,
            expect: { damagedQuantity: hire.damagedQuantity ?? 0 },
            data: { damagedQuantity: (hire.damagedQuantity ?? 0) + exit.qty },
          },
        ],
    async (tx, receiptId) => {
      const settledAt = new Date();
      const moved = await custodyExitRepo.moveSettlementStateTx(
        tx,
        exit.id,
        custodyExitRepo.SETTLE_UNSETTLED,
        custodyExitRepo.SETTLE_SETTLED,
        { settledByReceiptId: receiptId, settledAt },
      );
      // Somebody settled it in the window. Aborting takes the note with it, which is right: a document
      // raised for a claim that is already answered is a second bill.
      if (!moved) throw conflict("This record was settled by someone else a moment ago. Refresh and check.");
    },
  );

  emitHireUpdated(po.id, po.code);
  audit.record({
    actor,
    action: isLoss ? "rental_loss.settled" : "rental_damage.charged",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: {
      receipt: receipt.code,
      changes: [
        {
          label:
            `${hire.itemName}: ${exit.qty} ${isLoss ? "lost" : "damaged"}` +
            (exit.jobNumber ? ` on ${exit.jobNumber}` : "") +
            (chargePence != null ? ` · charged £${(chargePence / 100).toFixed(2)}` : " · no charge recorded") +
            ` · ${receipt.code}`,
        },
      ],
    },
  });
  return toPublic(receipt);
}

/** One action per direction, so the trail reads as what was withdrawn rather than "a receipt". */
const REVERSAL_AUDIT_ACTION: Record<ReceiptDirection, string> = {
  in: "rental_receipt.reversed",
  out: "rental_return.reversed",
  damage: "rental_damage.reversed",
  loss: "rental_loss.reversed",
};

const reversalLabel = (direction: ReceiptDirection, quantity: number): string => {
  if (direction === "out") return `${quantity} back on hire`;
  if (direction === "damage") return `${quantity} no longer reported damaged`;
  // The units stay LOST — only the money is withdrawn. Saying anything about quantity here would
  // suggest the equipment came back, which is the one thing a credit note never does.
  if (direction === "loss") return `charge withdrawn for ${quantity}`;
  return `${quantity} taken back off the hire`;
};

/**
 * Why a delivery of `qty` units can no longer be unwound on this hire, or null if it still can.
 *
 * NAMES THE CLAIM rather than refusing flatly. "This delivery can no longer be reversed" tells the
 * receiving bay nothing about what to do next; "1 declared lost, 2 reported damaged" tells them both
 * why and which record to deal with first. The count comes with it because a hire with several
 * deliveries can usually still reverse the smaller one, and a bare refusal hides that.
 */
function deliveryReversalBlocker(
  hire: {
    itemName: string;
    hireStatus: string;
    receivedQuantity: number;
    returnedQuantity: number;
    issuedQuantity: number;
    lostQuantity: number;
    fieldDamageQty: number;
    shortClosedAt: Date | null;
  },
  qty: number,
  /**
   * What the LIVE return notes still say for this line, which is not always what the column says.
   *
   * The counter and the notes cannot disagree in healthy data — the return path writes one from the
   * other — so this is not a second opinion, it is a floor. `Math.max` of the two means neither a
   * stale column nor a note the column has not caught up with can open this gate, and the module's
   * own rule ("recomputed from the notes rather than decremented") keeps its say.
   */
  returnedLive: number,
): string | null {
  // A FINISHED hire, stated rather than inferred. The arithmetic below would catch the ordinary way a
  // hire ends, because a full return leaves `returned === received` and nothing untouched. It would
  // NOT catch a hire closed short with everything already back: that path sets `hireStatus` from
  // `stillHeld === 0` and never touches `returnedQuantity` (see closeHireShort). Reading the status
  // directly costs one comparison and does not depend on two columns agreeing.
  if (hire.hireStatus === "returned") {
    return `${hire.itemName} has already been returned — this delivery can no longer be reversed.`;
  }
  if (hire.hireStatus === "cancelled") {
    return `${hire.itemName} was cancelled — nothing was ever delivered against it.`;
  }
  // A hire CLOSED SHORT is the quietest way this reversal does damage, and the one the arithmetic
  // below cannot see. The recompute owns `receivedQuantity`, `fullyReceived` and the status; it knows
  // nothing about `cancelledQuantity`, so it would put the line back on the intake queue while the
  // shortfall it cannot reach stays recorded beside it — `received + cancelled = ordered`, the
  // invariant that column exists for, silently broken. Worse, the line could then never take a
  // delivery again: `createRentalReceipt` refuses anything carrying `shortClosedAt`. Refused whole,
  // because reopening a short close is a decision somebody makes deliberately, not a side effect of
  // correcting a note.
  if (hire.shortClosedAt) {
    return (
      `${hire.itemName} was closed short — the outstanding units are recorded as not arriving, ` +
      `and reversing this delivery would leave that shortfall describing a hire that no longer exists.`
    );
  }

  const returned = Math.max(hire.returnedQuantity, returnedLive);
  const untouched = hireUntouched({ ...hire, returnedQuantity: returned });
  if (untouched >= qty) return null;

  // Clamped the same way `hireIssuable` clamps it, so the breakdown can never describe more damaged
  // units than there is shelf to stand them on.
  const shelf = hireAtWarehouse({ ...hire, returnedQuantity: returned });
  // Noun phrases, no verbs: they are joined into one list and a mix of "has"/"are" would have to
  // agree with each count separately for the sentence to survive two claims at once.
  const damagedHere = Math.min(shelf, hire.fieldDamageQty);
  const claims = [
    returned > 0 ? `${returned} already back with the supplier` : "",
    hire.issuedQuantity > 0 ? `${hire.issuedQuantity} out with an engineer` : "",
    hire.lostQuantity > 0 ? `${hire.lostQuantity} declared lost` : "",
    damagedHere > 0 ? `${damagedHere} reported damaged here` : "",
  ].filter(Boolean);

  const head = `${hire.itemName}: only ${untouched} of the ${qty} units on this record ${untouched === 1 ? "is" : "are"} still untouched here`;
  // The fallback is unreachable through the counters — every shortfall has a claim behind it — but a
  // legacy row with a received figure lower than its own note would otherwise produce a sentence
  // ending in a dash.
  if (claims.length === 0) return `${head}, so it can no longer be reversed.`;
  return (
    `${head} — ${claims.join(", ")}. ` +
    `A delivery can only be reversed while everything it delivered is still on the shelf — undo the later record first.`
  );
}

/** What each hire line this note touched becomes once the note no longer counts. */
async function buildReversalUpdates(
  direction: ReceiptDirection,
  existing: RentalReceiptWithRelations,
  // The transaction this recompute belongs to. Every read below goes through it — see reverseReceipt
  // for what a pre-read absolute total does when a concurrent note lands in the window.
  tx: Prisma.TransactionClient,
): Promise<HireUpdate[]> {
  // What the damaged tally becomes once THIS note stops counting — rebuilt from the notes that
  // remain, never decremented. Read across both sources (see damagedTotalsByLine): a report and a
  // collection note can each record damage, so a recompute filtered to one of them would wipe the
  // other's units while withdrawing a claim that had nothing to do with them.
  //
  // ONE query for the whole note, read before the per-line work rather than inside it: the totals are
  // keyed by line, so a note with six lines was firing six identical queries at the same transaction
  // client, concurrently, for one answer.
  const damagedLive = await receiptRepo.damagedTotalsByLine(existing.purchaseOrderId, tx);
  const damagedAfter = (lineId: string, thisNote: number) =>
    Math.max(0, (damagedLive.get(lineId) ?? 0) - thisNote);

  // A damage report moved no EQUIPMENT — but it did move the damaged tally, and a withdrawn claim
  // that leaves the warehouse's pane still counting it is the same drift as any other.
  if (direction === "damage") {
    return existing.lines.map((l) => ({
      id: l.purchaseOrderRentalLineId,
      data: { damagedQuantity: damagedAfter(l.purchaseOrderRentalLineId, l.damagedQuantity) },
    }));
  }

  // A LOSS SETTLEMENT moves no quantity at all — not even a tally. It is a charge raised against a
  // unit already declared gone, so withdrawing it withdraws the money and nothing else; the tester is
  // still lost, and `unwindCustody` putting its record back on the worklist is the whole of the undo.
  //
  // This branch is not a refinement, it closes a hole. `loss` used to fall past both checks below into
  // the ARRIVAL path, which reads `receivedTotalsByLine(po, "loss", "receivedQuantity")` — the totals
  // of the LOSS notes — and writes them to `receivedQuantity` as the line's absolute received figure.
  // Reversing one HLS note on a fully-received hire would have set `received` to 0 and put a live,
  // fully-delivered order back on the intake queue, with no error and nothing on screen to explain it.
  if (direction === "loss") return [];

  const remaining = await receiptRepo.receivedTotalsByLine(existing.purchaseOrderId, direction, "receivedQuantity", tx);
  const hireById = new Map((await receiptRepo.hireLinesForOrderTx(tx, existing.purchaseOrderId)).map((r) => [r.id, r]));

  if (direction === "out") {
    return existing.lines.map((l) => {
      // What the LIVE return notes still say, minus this one — computed from the set, not subtracted.
      const next = Math.max(0, (remaining.get(l.purchaseOrderRentalLineId) ?? 0) - l.receivedQuantity);
      const here = hireById.get(l.purchaseOrderRentalLineId)?.receivedQuantity ?? l.previouslyReceived;
      return {
        id: l.purchaseOrderRentalLineId,
        data: {
          returnedQuantity: next,
          fullyReturned: here > 0 && next >= here,
          // A collection note MOVES the damaged tally now, so reversing one has to give it back.
          // Left counted, the withdrawn note's units block the ones behind them from ever being
          // reported — the cap is against units never recorded damaged.
          damagedQuantity: damagedAfter(l.purchaseOrderRentalLineId, l.damagedQuantity),
          // Reopened: the kit is demonstrably still ours to give back. The stamps go with it — a
          // returned-on date left behind on a live hire is the kind of leftover nobody questions.
          ...(next < here ? { hireStatus: "on_hire", returnedAt: null, returnedBy: null } : {}),
        },
      };
    });
  }

  // An ARRIVAL. Reversing one asserts that its units NEVER CAME — so it is legitimate only while every
  // unit it delivered is still standing on our shelf, whole, and claimed by nobody.
  //
  // This used to ask a narrower question — "has any of it gone back to the supplier?" — in three
  // status-shaped checks. That is one of the four ways a delivered unit stops being untouched, and it
  // let the other three straight through: a unit in an engineer's van, a unit declared lost, and a
  // unit reported damaged in our custody all left the delivery reversible. Reversing then drove
  // `received` below what the surviving records account for, and every screen clamps the result with
  // `Math.max(0, …)` — so the arithmetic broke and the pane that would have shown it went blank.
  //
  // `hireUntouched` is the whole test, and it is the SAME function the issue guard uses (see its note
  // on why one number answers both questions). The short close is the one blocker it cannot express,
  // so it keeps its own check below.
  const returnedByLine = await receiptRepo.receivedTotalsByLine(existing.purchaseOrderId, "out", "receivedQuantity", tx);
  for (const l of existing.lines) {
    const hire = hireById.get(l.purchaseOrderRentalLineId);
    if (!hire) continue;
    const blocker = deliveryReversalBlocker(
      hire,
      l.receivedQuantity,
      returnedByLine.get(l.purchaseOrderRentalLineId) ?? 0,
    );
    if (blocker) throw conflict(blocker);
  }

  return existing.lines.map((l) => {
    const next = Math.max(0, (remaining.get(l.purchaseOrderRentalLineId) ?? 0) - l.receivedQuantity);
    const ordered = hireById.get(l.purchaseOrderRentalLineId)?.quantity ?? l.orderedQuantity;
    return {
      id: l.purchaseOrderRentalLineId,
      data: {
        receivedQuantity: next,
        // Back on the queue: the units this delivery accounted for are outstanding again.
        fullyReceived: next >= ordered,
        ...(next === 0 ? { hireStatus: "awaiting_delivery", receivedAt: null, receivedBy: null } : {}),
      },
    };
  });
}

// ── Condition evidence ──────────────────────────────────────────────────────────────────────────
//
// The photographs taken as the kit came off the van. They are the whole reason this record exists in
// a form a person can point at: a hire ends in a handover BACK, and the argument at that handover is
// always about which side broke it. `conditionNotes` is our word for it; this is the picture.

/** A delivery carries evidence, not a document library — enough to show the state it arrived in. */
const PHOTO_MAX_COUNT = 12;
const PHOTO_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export async function assertCanAttach(receiptId: string, fileSizeBytes: number, actor?: AuditActor): Promise<void> {
  const r = await findByIdOrCode(receiptId);
  if (!r) throw notFound("Hire delivery not found.");
  assertWarehouseAccess(actor, r.warehouseId);
  // A REVERSED note is a record of something that did not happen. Adding evidence to it would be
  // filing a photograph of an arrival the same record says never counted.
  if (r.reversedAt) throw conflict("That record has been reversed — its evidence can no longer be changed.");
  if (r.attachments.length >= PHOTO_MAX_COUNT) {
    throw badRequest(`A hire delivery can carry at most ${PHOTO_MAX_COUNT} photos.`);
  }
  const totalBytes = r.attachments.reduce((sum, a) => sum + a.fileSizeBytes, 0);
  if (totalBytes + fileSizeBytes > PHOTO_MAX_TOTAL_BYTES) {
    throw badRequest("Total photos on a hire delivery can't exceed 40 MB.");
  }
}

/** One already-stored asset, recorded against this delivery. */
export interface AttachAssetInput {
  label?: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  publicId: string;
  resourceType: string;
}

export async function attachUploadedAsset(
  receiptId: string,
  input: AttachAssetInput,
  actor?: AuditActor,
  tx?: Prisma.TransactionClient,
): Promise<PublicRentalReceipt> {
  await assertCanAttach(receiptId, input.fileSizeBytes, actor);
  await receiptRepo.addAttachment(
    {
      rentalReceiptId: receiptId,
      label: input.label?.trim() || null,
      fileName: input.fileName.trim(),
      fileType: input.fileType,
      fileSizeBytes: input.fileSizeBytes,
      url: input.url,
      publicId: input.publicId,
      resourceType: input.resourceType,
      uploadedBy: actor?.email ?? null,
    },
    tx,
  );
  // Non-transactional path only — the direct-upload finalize fires the audit after its commit, so an
  // aborted transaction cannot leave the trail asserting a photo that does not exist.
  if (!tx) {
    const dto = await getRentalReceipt(receiptId, actor);
    recordAttachmentAudit(dto, actor);
    return dto;
  }
  return getRentalReceipt(receiptId, actor);
}

export function recordAttachmentAudit(receipt: { id: string; code: string; purchaseOrderId: string }, actor?: AuditActor): void {
  // Filed against the PURCHASE ORDER, like every other event on this hire: the order is where anyone
  // looking into a delivery starts, and a trail split across two target types is a trail nobody reads.
  audit.record({
    actor,
    action: "rental_receipt.photo_added",
    targetType: "purchase_order",
    targetId: receipt.purchaseOrderId,
    targetLabel: receipt.code,
  });
}

/**
 * Remove a photo, and release the Cloudinary asset behind it.
 *
 * `releaseAsset` counts references across every attachment table first — the delete only happens when
 * nothing else points at the file.
 */
export async function removePhoto(
  receiptId: string,
  attachmentId: string,
  actor?: AuditActor,
): Promise<PublicRentalReceipt> {
  const r = await findByIdOrCode(receiptId);
  if (!r) throw notFound("Hire delivery not found.");
  assertWarehouseAccess(actor, r.warehouseId);
  if (r.reversedAt) throw conflict("That record has been reversed — its evidence can no longer be changed.");
  const att = await receiptRepo.findAttachment(attachmentId);
  // Against the resolved ROW's id, never the raw param: `receiptId` may be a code, and comparing an
  // attachment's rentalReceiptId to a code rejects a photo that does belong to this movement.
  if (!att || att.rentalReceiptId !== r.id) throw notFound("Photo not found.");
  await receiptRepo.deleteAttachment(attachmentId);
  audit.record({
    actor,
    action: "rental_receipt.photo_removed",
    targetType: "purchase_order",
    targetId: r.purchaseOrderId,
    targetLabel: r.code,
  });
  await attachmentService.releaseAsset(att, `rental_receipt ${r.code}`);
  return getRentalReceipt(receiptId, actor);
}
