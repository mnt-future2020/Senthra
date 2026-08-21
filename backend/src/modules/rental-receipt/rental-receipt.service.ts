import type { Prisma } from "@prisma/client";

import * as receiptRepo from "./rental-receipt.repository.js";
import type { RentalReceiptWithRelations } from "./rental-receipt.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { parseFilterDate } from "../../utils/filter-date.js";
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
import type {
  CreateRentalReceiptInput,
  CreateRentalReturnInput,
  RecordDamageChargeInput,
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

    const here = hire.receivedQuantity ?? 0;
    const already = hire.returnedQuantity ?? 0;
    const stillOut = here - already;
    if (stillOut <= 0) throw conflict(`${hire.itemName}: all ${here} received units have already gone back.`);
    if (l.returnedQuantity > stillOut) {
      throw conflict(
        `${hire.itemName}: only ${stillOut} still out (received ${here}, already returned ${already}).`,
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
    const alreadyDamaged = hire.damagedQuantity ?? 0;
    const damageable = Math.min(l.returnedQuantity, here - alreadyDamaged);
    if (damaged > damageable) {
      throw conflict(
        `${hire.itemName}: only ${damageable} of the ${l.returnedQuantity} going back ` +
          `${damageable === 1 ? "is" : "are"} not already reported damaged. ` +
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
  const lines: receiptRepo.NewReceiptLine[] = [];
  const hireUpdates: HireUpdate[] = [];

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
    const held = (hire.receivedQuantity ?? 0) - (hire.returnedQuantity ?? 0);
    if (held <= 0) throw conflict(`${hire.itemName}: nothing from this line is still with us.`);
    const alreadyDamaged = hire.damagedQuantity ?? 0;
    // Two ceilings, and the lower wins: only kit HELD can be broken here, and only units never
    // recorded damaged are left to record. The second is netted against what was RECEIVED, not what
    // is held — a unit that went back damaged is off the site but still on the record, and netting it
    // against the holding would quietly refuse an undamaged unit standing behind it.
    const reportable = Math.min(held, (hire.receivedQuantity ?? 0) - alreadyDamaged);
    if (reportable <= 0) {
      throw conflict(
        `${hire.itemName}: all ${held} unit${held === 1 ? "" : "s"} with us ${held === 1 ? "is" : "are"} already reported damaged.`,
      );
    }
    if (l.damagedQuantity > reportable) {
      throw conflict(
        `${hire.itemName}: only ${reportable} of the ${held} with us ${reportable === 1 ? "is" : "are"} not already reported damaged.`,
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
      changes: lines.map((l) => ({
        label: `${l.itemName}: ${l.damagedQuantity} damaged in service · ${receipt.code}`,
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

  const reversed = await receiptRepo.reverseReceipt(
    existing.id,
    { reversedAt: new Date(), reversedBy: actor?.email ?? null, reversalReason: input.reason },
    // The recompute, handed over as work rather than as a result. Everything it reads — the live note
    // totals AND the hire lines it compares them against — is then read through the same transaction
    // that writes the answer, so a movement committed a moment ago cannot be silently overwritten.
    // The guards inside it (already returned, already partly back) throw from in there too, which
    // aborts the transaction: exactly what should happen when the reversal is no longer legitimate.
    (tx) => buildReversalUpdates(direction, existing, tx),
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

/** One action per direction, so the trail reads as what was withdrawn rather than "a receipt". */
const REVERSAL_AUDIT_ACTION: Record<ReceiptDirection, string> = {
  in: "rental_receipt.reversed",
  out: "rental_return.reversed",
  damage: "rental_damage.reversed",
};

const reversalLabel = (direction: ReceiptDirection, quantity: number): string => {
  if (direction === "out") return `${quantity} back on hire`;
  if (direction === "damage") return `${quantity} no longer reported damaged`;
  return `${quantity} taken back off the hire`;
};

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

  // An ARRIVAL. Kit that has gone BACK cannot have its arrival unwound — it was demonstrably here.
  //
  // TWO questions, because the two ways a hire gives kit back leave different traces.
  //
  // The status catches a hire already CLOSED by a full return. The live return NOTES catch a PARTIAL
  // return, which leaves the line at `on_hire` and
  // therefore slipped straight past a status-only guard: reverse the delivery afterwards and the line
  // has returned more than it ever received. `held` then goes NEGATIVE, every screen clamps it to zero
  // with Math.max, and the warehouse pane — which lists `held > 0` — drops the one row that proves the
  // arithmetic broke.
  const closed = [...hireById.values()].find(
    (r) => r.hireStatus === "returned" && existing.lines.some((l) => l.purchaseOrderRentalLineId === r.id),
  );
  if (closed) {
    throw conflict(`${closed.itemName} has already been returned — this delivery can no longer be reversed.`);
  }
  // A hire CLOSED SHORT is the third way this reversal can do damage, and the quietest. The recompute
  // below owns `receivedQuantity`, `fullyReceived` and the status; it knows nothing about
  // `cancelledQuantity`, so it would put the line back on the intake queue while the shortfall it
  // cannot reach stays recorded beside it — `received + cancelled = ordered`, the invariant that
  // column exists for, silently broken. Worse, the line could then never take a delivery again:
  // `createRentalReceipt` refuses anything carrying `shortClosedAt`. Refused whole, for the same
  // reason a delivery is — reopening a short close is a decision somebody makes deliberately, not a
  // side effect of correcting a note.
  const shortClosed = [...hireById.values()].find(
    (r) => r.shortClosedAt && existing.lines.some((l) => l.purchaseOrderRentalLineId === r.id),
  );
  if (shortClosed) {
    throw conflict(
      `${shortClosed.itemName} was closed short — the outstanding units are recorded as not arriving, ` +
        `and reversing this delivery would leave that shortfall describing a hire that no longer exists.`,
    );
  }
  const returnedByLine = await receiptRepo.receivedTotalsByLine(existing.purchaseOrderId, "out", "receivedQuantity", tx);
  const partlyBack = existing.lines.find((l) => (returnedByLine.get(l.purchaseOrderRentalLineId) ?? 0) > 0);
  if (partlyBack) {
    throw conflict(
      `${partlyBack.itemName} has already been returned in part — this delivery can no longer be reversed. ` +
        `Reverse the return first.`,
    );
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
