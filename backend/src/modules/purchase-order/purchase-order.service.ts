import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { daysBetween, toCalendarDay } from "../../utils/calendar-day.js";
import { parseFilterDate } from "../../utils/filter-date.js";
import { computeNotifyOnDate, isTerminalHireStatus } from "./rentalHire.predicate.js";
import { emitHireUpdated } from "./rentalHire.realtime.js";
import { resolveDeliveryLocation, resolveReturnLocation, type ReturnContext } from "./rentalReturn.js";
import { extensionChargePence, type RatePeriod } from "../../utils/rental-pricing.js";
import * as poRepo from "./purchase-order.repository.js";
import type { PoLineRow, PurchaseOrderWithRelations } from "./purchase-order.repository.js";
import * as poEmail from "./purchase-order.email.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as documentService from "#modules/document/document.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
// The hire's movement notes, for the physical window on an on-hire row. The REPOSITORY, deliberately:
// rental-receipt.service imports this file, so reaching for its service would make the cycle.
import * as receiptRepo from "#modules/rental-receipt/rental-receipt.repository.js";
import { getCloudinaryCreds, getCompanyTimezone, getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { publicLateHireDelivery } from "../../utils/hire-delivery.js";
import { PO_ATTACHMENT_MAX_COUNT, PO_ATTACHMENT_MAX_TOTAL_BYTES } from "./purchase-order.validation.js";
import { startOfDayIn } from "../../utils/filter-date.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { emitAttentionChanged, emitToRoom, PURCHASE_ORDER_WATCHERS_ROOM } from "../../lib/realtime.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { diffProcurementChanges } from "../../utils/procurement-diff.js";
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrdersSplitInput,
  POLineInput,
  PoAttachmentInput,
  PoSupplierAcceptInput,
  UpdatePurchaseOrderInput,
  CloseHireShortInput,
  ExtendHireInput,
} from "./purchase-order.validation.js";
import { incotermLabel } from "./purchase-order.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// The archived document-of-record attachment written at send time (system-owned, undeletable).
export const ISSUED_PO_ATTACHMENT_LABEL = "Issued PO — as sent";

// ── Status state machine (forward-only; backend-enforced). The one sanctioned reverse edge is
// pending_approval → draft (Reject for rework). draft → approved is a guarded FAST PATH for
// PRF-born POs only (commercial-equality check in approvePurchaseOrder — finance already
// reviewed those numbers on the PRF). The received states are reachable only via the Goods In
// seam, never a PO endpoint. ────────────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"], // → draft = Reject (rework)
  approved: ["pm_review", "sent", "cancelled"], // pm_review = Route to PM; sent = direct issue
  pm_review: ["sent", "cancelled"], // sent = the assigned PM issues it (guarded)
  sent: ["supplier_accepted", "partially_received", "fully_received", "cancelled"],
  supplier_accepted: ["partially_received", "fully_received", "cancelled"],
  partially_received: ["fully_received", "closed"],
  fully_received: ["closed"],
  closed: [],
  cancelled: [],
};
const humanStatus = (s: string) => s.replace(/_/g, " ");

/**
 * The receipt statuses in order, oldest first — how `recomputeRentalReceiptStatus` tells a downgrade
 * from an advance. Anything outside this list (draft, approvals, terminal states) is handled by the
 * guards around it and never reaches the comparison.
 */
const RECEIPT_PROGRESS = ["sent", "supplier_accepted", "partially_received", "fully_received"];
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${humanStatus(from)} purchase order to ${humanStatus(to)}.`);
  }
}

// Statuses at which the supplier's acknowledgement may be RECORDED. This is deliberately NOT a
// transition list: acceptance is a business event, not a workflow gate. A supplier can acknowledge
// late — after the truck has already turned up — and losing that record (the ack reference, the
// date they committed to) just because goods arrived first is an audit hole. From `sent` the
// status also advances to `supplier_accepted`; from the received states the data is recorded with
// NO status change, because moving a partially-received order back would rewrite history.
// Terminal states are excluded, matching assertAttachmentsEditable.
export const ACCEPTANCE_RECORDABLE = new Set(["sent", "supplier_accepted", "partially_received", "fully_received"]);

// ── DTO ────────────────────────────────────────────────────────────────────────────────────
export interface PublicPoSupplier {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTerms: string | null;
  currency: string | null;
  leadTimeDays: number | null;
}
export interface PublicPoWarehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
}
/** A committed hire on the order — the row the deadline badge counts and the sweep emails about. */
export interface PublicPoRentalLine {
  id: string;
  rentalItemId: string;
  itemName: string;
  baseUnit: string | null;
  quantity: number;
  hireStartDate: string;
  hireEndDate: string;
  hireDays: number;
  notifyDaysBefore: number;
  notifyOnDate: string;
  deliveryAddress: string | null;
  ratePeriod: string;
  ratePence: number | null;
  priceOverridden: boolean;
  returnMode: string;
  returnAddress: string | null;
  /** BOTH legs, resolved once server-side — see rentalReturn.ts. */
  deliveryLocation: { label: string; address: string | null };
  returnLocation: { label: string; address: string | null };
  unitPricePence: number;
  unitPrice: number;
  vatRate: number;
  lineTotalPence: number;
  lineTotal: number;
  notes: string | null;
  hireStatus: string;
  /** How many units have actually turned up, summed from this line's hire deliveries. */
  receivedQuantity: number;
  /** Nothing more is expected — every unit arrived, or the rest was closed short. */
  fullyReceived: boolean;
  /** Ordered units recorded as never arriving, and why. `received + cancelled = ordered`. */
  cancelledQuantity: number;
  shortClosedAt: string | null;
  shortClosedBy: string | null;
  shortCloseReason: string | null;
  /** How many have gone BACK, and whether everything we hold has. The return form caps on these. */
  returnedQuantity: number;
  fullyReturned: boolean;
  /** Units reported damaged while in our hands — clamped by every reader to what is still held. */
  damagedQuantity: number;
  /** Stamped when the warehouse confirmed the kit arrived; null while awaiting delivery. */
  receivedAt: string | null;
  receivedBy: string | null;
  /** Cumulative extension charges, NOT included in this order's totals. */
  extensionChargePence: number;
  extensionCharge: number;
  /**
   * The BREAKDOWN of that total, oldest first — one entry per extension.
   *
   * The total alone says £725 and nothing else: not how many times, not when, not how much each. Both
   * are kept because they answer different questions, and the sum is the one every deadline screen
   * needs at a glance.
   */
  extensions: {
    id: string;
    previousEndDate: string;
    newEndDate: string;
    addedDays: number;
    charge: number;
    /** What the hire's own rate priced it at. Null on the `total` basis, which has no rate. */
    calculatedCharge: number | null;
    priceOverridden: boolean;
    agreedBy: string | null;
    agreedAt: string;
  }[];
  /** What the total holds that no entry explains — extensions agreed before they were recorded. */
  unexplainedExtensionCharge: number;
  returnedAt: string | null;
  returnedBy: string | null;
  rentalItem: { id: string; code: string; name: string; status: string } | null;
}

export interface PublicPoItem {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  unitPricePence: number;
  unitPrice: number;
  vatRate: number;
  lineTotalPence: number;
  lineTotal: number;
  receivedQuantity: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string } | null;
}
export interface PublicPoAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}
export interface PublicPurchaseOrder {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string | null;
  supplier: PublicPoSupplier | null;
  warehouseId: string;
  warehouse: PublicPoWarehouse | null;
  // Procurement chain: the source PRF (when generated from one), the optional job, and the
  // GRNs received against this PO.
  purchaseRequestId: string | null;
  purchaseRequest: { id: string; code: string; status: string } | null;
  jobId: string | null;
  job: { id: string; jobNumber: string; name: string; status: string } | null;
  projectRef: string | null;
  goodsReceipts: { id: string; code: string; status: string; receivedDate: string | null }[];
  status: string;
  priority: string;
  // PM routing.
  pmUserId: string | null;
  pmName: string | null;
  pmEmail: string | null;
  pmAssignedAt: string | null;
  // Supplier acceptance.
  supplierAcceptedAt: string | null;
  supplierAcceptedBy: string | null;
  supplierAckReference: string | null;
  confirmedDeliveryDate: string | null;
  supplierAcceptNotes: string | null;
  referenceNumber: string | null;
  description: string | null;
  orderDate: string;
  expectedDeliveryDate: string | null;
  // Set when the delivery date — the supplier's confirmed date, else the expected one — falls AFTER
  // one of this order's hires has already started —
  // days billed with nothing on site, and the date the supplier reads on the PDF. Derived here so
  // the request screen, the order screen and any export read one answer. A warning, never a block.
  lateHireDelivery: { earliestHireStart: string; daysLate: number } | null;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  deliveryTerms: string | null; // Incoterm code
  deliveryTermsLabel: string | null; // resolved human label
  paymentTerms: string | null;
  internalNotes: string | null;
  supplierNotes: string | null;
  items: PublicPoItem[];
  rentalItems: PublicPoRentalLine[];
  attachments: PublicPoAttachment[];
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rejectionReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedPurchaseOrders {
  purchaseOrders: PublicPurchaseOrder[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const pounds = (p: number | null | undefined): number => (p == null ? 0 : p / 100);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The address parts of any warehouse-shaped row, joined. The on-hire list selects a narrower
 *  warehouse than the detail include, and both need the same block. */
function addressBlock(
  w: { addressLine1: string | null; addressLine2: string | null; city: string | null; county: string | null; postcode: string | null; country: string | null } | null | undefined,
): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((x) => x?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function warehouseAddress(w: PurchaseOrderWithRelations["warehouse"]): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The facts BOTH legs of a hire's round trip are resolved from — see rentalReturn.ts.
 *
 * Built once per line so the outbound and return chains are handed the same facts. `deliveryAddress`
 * here is the LINE's own; the order's "deliver to a different address" override is a separate step in
 * the chain, and a line with neither falls through to the warehouse.
 */
function poReturnCtx(
  po: PurchaseOrderWithRelations,
  r: PurchaseOrderWithRelations["rentalItems"][number],
): ReturnContext {
  return {
    returnMode: r.returnMode,
    returnAddress: r.returnAddress,
    deliveryAddress: r.deliveryAddress,
    orderDeliveryAddress: po.deliveryAddress,
    warehouseName: po.warehouse?.name ?? null,
    warehouseAddress: warehouseAddress(po.warehouse),
  };
}

function toPublic(po: PurchaseOrderWithRelations): PublicPurchaseOrder {
  const s = po.supplier;
  const paymentTerms = s ? (s.paymentTerms === "Custom" ? s.customPaymentTerms : s.paymentTerms) : null;
  return {
    id: po.id,
    code: po.code,
    supplierId: po.supplierId,
    supplierName: po.supplierName,
    supplier: s
      ? {
          id: s.id,
          code: s.code,
          name: s.name,
          contactPerson: s.contactPerson,
          contactEmail: s.contactEmail,
          contactPhone: s.contactPhone,
          paymentTerms: paymentTerms ?? null,
          currency: s.currency ?? "GBP",
          leadTimeDays: s.leadTimeDays,
        }
      : null,
    warehouseId: po.warehouseId,
    warehouse: po.warehouse
      ? { id: po.warehouse.id, code: po.warehouse.code, name: po.warehouse.name, address: warehouseAddress(po.warehouse) }
      : null,
    purchaseRequestId: po.purchaseRequestId,
    purchaseRequest: po.purchaseRequest
      ? { id: po.purchaseRequest.id, code: po.purchaseRequest.code, status: po.purchaseRequest.status }
      : null,
    jobId: po.jobId,
    job: po.job ? { id: po.job.id, jobNumber: po.job.jobNumber, name: po.job.name, status: po.job.status } : null,
    projectRef: po.projectRef,
    goodsReceipts: po.goodsReceipts.map((g) => ({ id: g.id, code: g.code, status: g.status, receivedDate: iso(g.receivedDate) })),
    status: po.status ?? "draft",
    priority: po.priority ?? "normal",
    pmUserId: po.pmUserId,
    pmName: po.pmName,
    pmEmail: po.pmEmail,
    pmAssignedAt: iso(po.pmAssignedAt),
    supplierAcceptedAt: iso(po.supplierAcceptedAt),
    supplierAcceptedBy: po.supplierAcceptedBy,
    supplierAckReference: po.supplierAckReference,
    confirmedDeliveryDate: iso(po.confirmedDeliveryDate),
    supplierAcceptNotes: po.supplierAcceptNotes,
    referenceNumber: po.referenceNumber,
    description: po.description,
    orderDate: po.orderDate.toISOString(),
    expectedDeliveryDate: iso(po.expectedDeliveryDate),
    // The supplier's CONFIRMED date wins once given: it is the date the kit actually turns up, and
    // the warehouse worklist already plans against it in preference to the estimate.
    lateHireDelivery: publicLateHireDelivery(po.confirmedDeliveryDate ?? po.expectedDeliveryDate, po.rentalItems),
    currency: po.currency ?? "GBP",
    subtotalPence: po.subtotalPence,
    vatPence: po.vatPence,
    grandTotalPence: po.grandTotalPence,
    subtotal: pounds(po.subtotalPence),
    vatTotal: pounds(po.vatPence),
    grandTotal: pounds(po.grandTotalPence),
    deliveryAddress: po.deliveryAddress,
    deliveryInstructions: po.deliveryInstructions,
    deliveryTerms: po.deliveryTerms,
    deliveryTermsLabel: po.deliveryTerms ? incotermLabel(po.deliveryTerms) : null,
    paymentTerms: po.paymentTerms,
    internalNotes: po.internalNotes,
    supplierNotes: po.supplierNotes,
    items: po.items.map((i) => ({
      id: i.id,
      irmItemId: i.irmItemId,
      itemName: i.itemName,
      sku: i.sku,
      baseUnit: i.baseUnit,
      quantity: i.quantity,
      unitPricePence: i.unitPricePence,
      unitPrice: pounds(i.unitPricePence),
      vatRate: i.vatRate,
      lineTotalPence: i.lineTotalPence,
      lineTotal: pounds(i.lineTotalPence),
      receivedQuantity: i.receivedQuantity,
      notes: i.notes,
      irmItem: i.irmItem ? { id: i.irmItem.id, code: i.irmItem.code, name: i.irmItem.name, status: i.irmItem.status } : null,
    })),
    rentalItems: po.rentalItems.map((r) => ({
      id: r.id,
      rentalItemId: r.rentalItemId,
      itemName: r.itemName,
      baseUnit: r.baseUnit,
      quantity: r.quantity,
      hireStartDate: r.hireStartDate.toISOString(),
      hireEndDate: r.hireEndDate.toISOString(),
      hireDays: daysBetween(r.hireStartDate, r.hireEndDate),
      notifyDaysBefore: r.notifyDaysBefore,
      notifyOnDate: r.notifyOnDate.toISOString(),
      deliveryAddress: r.deliveryAddress,
      ratePeriod: r.ratePeriod,
      ratePence: r.ratePence,
      priceOverridden: r.priceOverridden,
      returnMode: r.returnMode,
      returnAddress: r.returnAddress,
      // BOTH legs, resolved here rather than on the client: the order document prints the same answer
      // from the same function, so a screen and a PDF can never name two different places. The
      // outbound one matters most on THIS record — an order carrying a "deliver to a different
      // address" override sends a line with no address of its own somewhere the row used to call
      // "Delivery warehouse".
      deliveryLocation: resolveDeliveryLocation(poReturnCtx(po, r)),
      returnLocation: resolveReturnLocation(poReturnCtx(po, r)),
      unitPricePence: r.unitPricePence,
      unitPrice: pounds(r.unitPricePence),
      vatRate: r.vatRate,
      lineTotalPence: r.lineTotalPence,
      lineTotal: pounds(r.lineTotalPence),
      notes: r.notes,
      hireStatus: r.hireStatus,
      receivedQuantity: r.receivedQuantity ?? 0,
      fullyReceived: r.fullyReceived ?? false,
      cancelledQuantity: r.cancelledQuantity ?? 0,
      shortClosedAt: iso(r.shortClosedAt),
      shortClosedBy: r.shortClosedBy,
      shortCloseReason: r.shortCloseReason,
      returnedQuantity: r.returnedQuantity ?? 0,
      fullyReturned: r.fullyReturned ?? false,
      damagedQuantity: r.damagedQuantity ?? 0,
      receivedAt: iso(r.receivedAt),
      receivedBy: r.receivedBy,
      extensionChargePence: r.extensionChargePence,
      extensionCharge: pounds(r.extensionChargePence),
      extensions: (r.extensions ?? []).map((e) => ({
        id: e.id,
        previousEndDate: e.previousEndDate.toISOString(),
        newEndDate: e.newEndDate.toISOString(),
        addedDays: e.addedDays,
        charge: pounds(e.chargePence),
        calculatedCharge: e.calculatedChargePence == null ? null : pounds(e.calculatedChargePence),
        priceOverridden: e.priceOverridden,
        agreedBy: e.createdBy,
        agreedAt: e.createdAt.toISOString(),
      })),
      // What the running total holds that no breakdown row explains — extensions agreed before this
      // was recorded per event. Stated rather than hidden: a breakdown that silently adds up to less
      // than the total beside it is read as the total being wrong. See the HireExtension model for
      // why the old ones are not reconstructed from the audit log.
      unexplainedExtensionCharge: pounds(
        Math.max(0, r.extensionChargePence - (r.extensions ?? []).reduce((sum, e) => sum + e.chargePence, 0)),
      ),
      returnedAt: r.returnedAt?.toISOString() ?? null,
      returnedBy: r.returnedBy,
      rentalItem: r.rentalItem
        ? { id: r.rentalItem.id, code: r.rentalItem.code, name: r.rentalItem.name, status: r.rentalItem.status }
        : null,
    })),
    attachments: po.attachments.map((a) => ({
      id: a.id,
      label: a.label,
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url: a.url,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    createdBy: po.createdBy,
    submittedBy: po.submittedBy,
    submittedAt: iso(po.submittedAt),
    approvedBy: po.approvedBy,
    approvedAt: iso(po.approvedAt),
    sentAt: iso(po.sentAt),
    closedAt: iso(po.closedAt),
    cancelledAt: iso(po.cancelledAt),
    cancelReason: po.cancelReason,
    rejectionReason: po.rejectionReason,
    updatedBy: po.updatedBy,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
  };
}

/** Pence → "£2,145.00", for an audit label a human reads. */
function poundsLabel(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

// ── Financials (server-authoritative, integer pence) ─────────────────────────────────────────
function computeTotals(lines: { quantity: number; unitPricePence: number; vatRate: number }[]): poRepo.PoTotals {
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPricePence; // ex-VAT
    subtotal += lineTotal;
    vat += Math.round((lineTotal * l.vatRate) / 100);
  }
  return { subtotalPence: subtotal, vatPence: vat, grandTotalPence: subtotal + vat };
}

// Validate each line's IRM item is ACTIVE, snapshot its name/sku/unit, and compute the line total.
async function buildLineRows(items: POLineInput[]): Promise<PoLineRow[]> {
  // One batched active-item validation for the whole set (not N sequential lookups).
  const itemsById = await irmService.requireActiveIrmItems(items.map((l) => l.irmItemId));
  const rows: PoLineRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const item = itemsById.get(line.irmItemId)!; // guaranteed present + active by requireActiveIrmItems
    const vatRate = line.vatRate ?? item.vatRatePercent ?? 0;
    rows.push({
      irmItemId: line.irmItemId,
      itemName: item.name,
      sku: item.sku ?? null,
      baseUnit: item.baseUnit ?? null,
      quantity: line.quantity,
      unitPricePence: line.unitPricePence,
      vatRate,
      lineTotalPence: line.quantity * line.unitPricePence,
      sortOrder: i,
      notes: trimToNull(line.notes),
    });
  }
  return rows;
}

// Validate an optional job link (must exist and not be soft-deleted). Returns the id or null.
// null/undefined/"" all resolve to null (no link / cleared).
async function resolveJobId(jobId: string | null | undefined): Promise<string | null> {
  if (!jobId) return null;
  const job = await jobRepo.findById(jobId);
  if (!job) throw badRequest("Selected job no longer exists.");
  return jobId;
}

// The supplier's default payment-term TEXT ("Custom" → its free-text customPaymentTerms). Used to
// pre-fill a PO's editable paymentTerms when the caller doesn't supply one.
function supplierDefaultPaymentTerms(s: { paymentTerms: string | null; customPaymentTerms?: string | null }): string | null {
  if (!s.paymentTerms) return null;
  return s.paymentTerms === "Custom" ? (s.customPaymentTerms ?? null) : s.paymentTerms;
}

export interface ListPurchaseOrdersParams {
  search?: string;
  status?: string;
  statuses?: string[];
  priority?: string;
  supplier?: string;
  warehouse?: string;
  pm?: string; // assigned PM user id — the "Awaiting my action" worklist
  job?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

// May this actor act on a pm_review PO that isn't assigned to them? Used by the send guard (an
// override, e.g. the PM is away) and by the "awaiting_send" list/badge scoping, so both answer the
// question the same way.
function canOverridePm(actor?: AuditActor): boolean {
  return Boolean(actor?.permissions?.includes("*") || actor?.permissions?.includes("purchase_orders.assign_pm"));
}

export async function listPurchaseOrders(params: ListPurchaseOrdersParams = {}, actor?: AuditActor): Promise<PagedPurchaseOrders> {
  const filters = {
    search: params.search,
    status: params.status,
    statuses: params.statuses,
    priority: params.priority,
    supplierId: params.supplier,
    warehouseId: params.warehouse,
    pmUserId: params.pm,
    jobId: params.job,
    // Unrestricted actor → undefined → no filter (unchanged). Scoped actor → their warehouse ids.
    warehouseIds: warehouseScopeFilter(actor),
    // "Overdue" is derived, not stored — the service owns settings, so the company-timezone day
    // boundary is resolved here and handed down (same contract as the jobs list).
    overdueBefore: params.status === "overdue" ? startOfDayIn(await getCompanyTimezone(), new Date()) : undefined,
    // "awaiting_send" is likewise derived, and its pm_review half is PERSONAL: only the assigned PM
    // may send (see sendPurchaseOrder), so a caller without the override sees only their own. The
    // same rule the attention badge counts by, resolved here so the badge and this list agree.
    pmScopeUserId:
      params.status === "awaiting_send" && !canOverridePm(actor) ? (actor?.id ?? undefined) : undefined,
  };
  const total = await poRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await poRepo.findMany(filters, skip, pageSize, params.sort);
  return { purchaseOrders: rows.map(toPublic), total, page, pageSize, totalPages };
}

/**
 * The SAME filtered list as a CSV, minus paging — "everything matching what I'm looking at".
 *
 * Built by calling the list's own filter assembly rather than a second query: the export is the
 * report the client reconciles spend against, and an export whose filters drift from the screen it
 * was taken from is worse than none. That includes the warehouse scope and the personal
 * "awaiting_send" narrowing, both of which live in listPurchaseOrders — so this delegates to it
 * with one oversized page rather than re-deriving them.
 */
export async function exportPurchaseOrdersCsv(
  params: ListPurchaseOrdersParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  const { purchaseOrders } = await listPurchaseOrders({ ...params, ...EXPORT_PAGING }, actor);
  const rows = purchaseOrders.slice(0, EXPORT_MAX);

  // Company timezone + configured date format, like every generated artifact; the column names the
  // zone so a reader is never left guessing which one the dates are in.
  const regional = await getRegionalSettings();
  const csv = toCsv(
    [
      "PO Number", "Status", "Priority", "Supplier", "Warehouse",
      "Purchase Request", "Job", "Project Ref", "Supplier Reference",
      `Order Date (${regional.timezone})`, `Expected Delivery (${regional.timezone})`, `Confirmed Delivery (${regional.timezone})`,
      "Assigned PM", "Currency", "Subtotal", "VAT", "Grand Total",
    ],
    rows.map((po) => [
      po.code,
      po.status,
      po.priority,
      po.supplier?.name ?? po.supplierName,
      po.warehouse?.name,
      po.purchaseRequest?.code,
      po.job?.jobNumber,
      po.projectRef,
      po.referenceNumber,
      formatDate(po.orderDate, regional.dateFormat, regional.timezone),
      formatDate(po.expectedDeliveryDate, regional.dateFormat, regional.timezone),
      formatDate(po.confirmedDeliveryDate, regional.dateFormat, regional.timezone),
      po.pmName,
      po.currency,
      // Money as a plain decimal, never the pence integer: this file is opened in a spreadsheet and
      // summed, and 222 in a column headed "Subtotal" is a £2.20 order reported as £222.
      po.subtotal.toFixed(2),
      po.vatTotal.toFixed(2),
      po.grandTotal.toFixed(2),
    ]),
  );

  // Audit the deliberate extraction, as the inventory and audit exports do — a download of the
  // company's spend is an event worth being able to point at later, unlike a page view.
  audit.record({ actor, action: "purchase_order.exported", targetType: "purchase_order", targetLabel: `${rows.length} rows` });
  return { csv, capped: purchaseOrders.length > EXPORT_MAX };
}

/**
 * The same filtered orders, ONE ROW PER LINE — the spend report.
 *
 * The header export answers "what did PO-0044 cost". This answers the questions a company actually
 * opens Excel for: what did we spend on THIS ITEM this year, across every order; how has its unit
 * price moved; which supplier charges what. None of those can be pivoted out of a header row,
 * because the item never appears in one.
 *
 * Every header field is repeated on each line ON PURPOSE. A pivot table needs the supplier and the
 * date on the same row as the item — a "tidy" file with the header written once is a file you have
 * to fill down by hand before it is usable.
 *
 * No extra memory risk over the header export: the list projection already loads `items` (see
 * withRelations), so this flattens rows that were fetched either way.
 */
export async function exportPurchaseOrderLinesCsv(
  params: ListPurchaseOrdersParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  const { purchaseOrders } = await listPurchaseOrders({ ...params, ...EXPORT_PAGING }, actor);
  const orders = purchaseOrders.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  // Header cells shared by both kinds of line, so an IRM row and a hire row line up column-for-column.
  const headerCells = (po: PublicPurchaseOrder) => [
    po.code,
    po.status,
    po.supplier?.name ?? po.supplierName,
    po.warehouse?.name,
    formatDate(po.orderDate, regional.dateFormat, regional.timezone),
    formatDate(po.expectedDeliveryDate, regional.dateFormat, regional.timezone),
    po.purchaseRequest?.code,
    po.job?.jobNumber,
  ];
  // BOTH kinds. A hire carries real spend, so an export of `items` alone under-reports the order's
  // value — and a hire-only order exported as nothing at all.
  const all = orders.flatMap((po) => [
    ...po.items.map((i) => [
      ...headerCells(po),
      "Item",
      // The item's catalogue CODE as well as its name: the name is a snapshot taken at order time,
      // so grouping by name alone splits an item that was renamed into two products.
      i.irmItem?.code,
      i.itemName,
      i.sku,
      i.baseUnit,
      i.quantity,
      "",
      "",
      "",
      i.unitPrice.toFixed(2),
      i.vatRate,
      i.lineTotal.toFixed(2),
      // What actually turned up against this line — the difference is the outstanding quantity, and
      // is why a spend file has to carry it rather than leaving it to a second lookup.
      i.receivedQuantity,
      po.currency,
    ]),
    ...po.rentalItems.map((r) => [
      ...headerCells(po),
      "Rental",
      r.rentalItem?.code,
      r.itemName,
      "",
      r.baseUnit,
      r.quantity,
      // UTC: a hire date is a calendar day stored as UTC midnight.
      formatDate(r.hireStartDate, regional.dateFormat, "UTC"),
      formatDate(r.hireEndDate, regional.dateFormat, "UTC"),
      r.hireStatus,
      r.unitPrice.toFixed(2),
      r.vatRate,
      r.lineTotal.toFixed(2),
      // A hire is never "received" — it goes back instead, which `Hire Status` carries.
      "",
      po.currency,
    ]),
  ]);
  // Capped on LINES, not orders: one order can carry hundreds, so an order-count ceiling would let
  // the real row count run far past it.
  const rows = all.slice(0, EXPORT_MAX);

  const csv = toCsv(
    [
      "PO Number", "Status", "Supplier", "Warehouse",
      `Order Date (${regional.timezone})`, `Expected Delivery (${regional.timezone})`,
      "Purchase Request", "Job",
      "Line Type", "Item Code", "Item", "SKU", "Unit", "Quantity",
      "Hire From", "Hire Until", "Hire Status",
      "Unit Price", "VAT %", "Line Total", "Received Qty", "Currency",
    ],
    rows,
  );

  audit.record({ actor, action: "purchase_order.exported", targetType: "purchase_order", targetLabel: `${rows.length} lines` });
  return { csv, capped: purchaseOrders.length > EXPORT_MAX || all.length > EXPORT_MAX };
}

export async function getPurchaseOrder(idOrCode: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = OBJECT_ID_RE.test(idOrCode) ? await poRepo.findById(idOrCode) : await poRepo.findByCode(idOrCode);
  if (!po) throw notFound("Purchase order not found.");
  // Assert only when the PO has a delivery warehouse; a null warehouseId (header not yet assigned)
  // is never blocked. Unrestricted actors are a no-op.
  if (po.warehouseId) assertWarehouseAccess(actor, po.warehouseId);
  return toPublic(po);
}

// Item-scoped PO history for the IRM item detail "Purchase Orders" tab. Read-only, compact rows
// (one per matching line). Sorted newest-first here since the Mongo connector can't orderBy a relation.
export interface ItemPurchaseRow {
  id: string;
  code: string;
  status: string;
  priority: string;
  supplierName: string | null;
  warehouseName: string | null;
  orderedQty: number;
  receivedQty: number;
  createdAt: string;
}
export async function listPurchaseOrdersForItem(irmItemId: string): Promise<ItemPurchaseRow[]> {
  const lines = await poRepo.findLinesByIrmItem(irmItemId);
  return lines
    .map((l) => ({
      id: l.purchaseOrder.id,
      code: l.purchaseOrder.code,
      status: l.purchaseOrder.status,
      priority: l.purchaseOrder.priority,
      supplierName: l.purchaseOrder.supplierName ?? null,
      warehouseName: l.purchaseOrder.warehouse?.name ?? null,
      orderedQty: l.quantity,
      receivedQty: l.receivedQuantity,
      createdAt: l.purchaseOrder.createdAt.toISOString(),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// Load the raw PO (with relations) for the Document Platform — the PO PDF (supplier email +
// staff download) builds from this. Throws 404 when missing/soft-deleted.
export async function loadPurchaseOrderEntity(idOrCode: string, actor?: AuditActor): Promise<PurchaseOrderWithRelations> {
  const po = OBJECT_ID_RE.test(idOrCode) ? await poRepo.findById(idOrCode) : await poRepo.findByCode(idOrCode);
  if (!po) throw notFound("Purchase order not found.");
  if (po.warehouseId) assertWarehouseAccess(actor, po.warehouseId);
  return po;
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  // A scoped actor may only create POs delivering to a warehouse in their set (no-op if unrestricted
  // or if no warehouse provided).
  if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
  const supplier = await supplierService.requireActiveSupplier(input.supplierId);
  await warehouseService.requireActiveWarehouse(input.warehouseId);
  const jobId = await resolveJobId(input.jobId);
  const lineRows = await buildLineRows(input.items);
  const totals = computeTotals(lineRows);
  const actorLabel = actor?.email ?? null;

  const created = await poRepo.createWithCode(
    {
      supplierId: input.supplierId,
      supplierName: supplier.name,
      warehouseId: input.warehouseId,
      jobId,
      projectRef: trimToNull(input.projectRef),
      status: "draft",
      priority: input.priority ?? "normal",
      referenceNumber: trimToNull(input.referenceNumber),
      description: trimToNull(input.description),
      orderDate: new Date(input.orderDate),
      expectedDeliveryDate: new Date(input.expectedDeliveryDate),
      currency: "GBP",
      ...totals,
      deliveryAddress: trimToNull(input.deliveryAddress),
      deliveryInstructions: trimToNull(input.deliveryInstructions),
      deliveryTerms: input.deliveryTerms ?? null,
      // Default the agreed payment term to the supplier's standing default when none supplied.
      paymentTerms: trimToNull(input.paymentTerms) ?? supplierDefaultPaymentTerms(supplier),
      internalNotes: trimToNull(input.internalNotes),
      supplierNotes: trimToNull(input.supplierNotes),
      createdBy: actorLabel,
      updatedBy: actorLabel,
    },
    lineRows,
  );
  audit.record({ actor, action: "purchase_order.created", targetType: "purchase_order", targetId: created.id, targetLabel: created.code });
  emitPoUpdated(created);
  return toPublic(created);
}

// Multi-warehouse "purchase request": one operation whose lines each carry their own destination
// warehouse. The lines are GROUPED by warehouse and ONE single-warehouse PO is created per group —
// a PO never spans warehouses. Every group is validated UP FRONT (supplier once; per-warehouse
// access + active; every IRM line active) BEFORE any write, and the creation itself is a single
// all-or-nothing transaction (gap-safe numbering), so the whole request either yields all POs or
// none — never a partial set. Each resulting PO is fully independent (own code, warehouse, audit,
// lifecycle) and receivable in Goods In exactly like a normally-created PO.
export async function createPurchaseOrdersBySplit(
  input: CreatePurchaseOrdersSplitInput,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder[]> {
  const supplier = await supplierService.requireActiveSupplier(input.supplierId);
  const splitJobId = await resolveJobId(input.jobId);
  const actorLabel = actor?.email ?? null;

  // Group lines by destination warehouse, preserving first-appearance order (predictable PO sequence).
  const order: string[] = [];
  const byWarehouse = new Map<string, typeof input.items>();
  for (const line of input.items) {
    let bucket = byWarehouse.get(line.warehouseId);
    if (!bucket) {
      bucket = [];
      byWarehouse.set(line.warehouseId, bucket);
      order.push(line.warehouseId);
    }
    bucket.push(line);
  }

  // Pre-validate EVERY group and build its header + lines BEFORE any write, so an invalid group
  // (inaccessible / inactive warehouse, inactive item) fails the whole request with zero side effects.
  const groups: { header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">; lines: PoLineRow[] }[] = [];
  for (const warehouseId of order) {
    assertWarehouseAccess(actor, warehouseId); // scoped actor: 403 on an unassigned warehouse
    await warehouseService.requireActiveWarehouse(warehouseId);
    const lineRows = await buildLineRows(byWarehouse.get(warehouseId) ?? []);
    const totals = computeTotals(lineRows);
    groups.push({
      header: {
        supplierId: input.supplierId,
        supplierName: supplier.name,
        warehouseId,
        jobId: splitJobId,
        projectRef: trimToNull(input.projectRef),
        status: "draft",
        priority: input.priority ?? "normal",
        referenceNumber: trimToNull(input.referenceNumber),
        description: trimToNull(input.description),
        orderDate: new Date(input.orderDate),
        expectedDeliveryDate: new Date(input.expectedDeliveryDate),
        currency: "GBP",
        ...totals,
        deliveryAddress: trimToNull(input.deliveryAddress),
        deliveryInstructions: trimToNull(input.deliveryInstructions),
        deliveryTerms: input.deliveryTerms ?? null,
        paymentTerms: trimToNull(input.paymentTerms) ?? supplierDefaultPaymentTerms(supplier),
        internalNotes: trimToNull(input.internalNotes),
        supplierNotes: trimToNull(input.supplierNotes),
        createdBy: actorLabel,
        updatedBy: actorLabel,
      },
      lines: lineRows,
    });
  }

  const created = await poRepo.createManyWithCodes(groups);

  // One audit row + one realtime signal per resulting PO — each is an independent purchase order.
  for (const po of created) {
    audit.record({ actor, action: "purchase_order.created", targetType: "purchase_order", targetId: po.id, targetLabel: po.code });
    emitPoUpdated(po);
  }
  return created.map(toPublic);
}

export async function updatePurchaseOrder(id: string, input: UpdatePurchaseOrderInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const existing = await poRepo.findById(id);
  if (!existing) throw notFound("Purchase order not found.");
  // A scoped actor may only edit POs whose (current) delivery warehouse is in their set; null = not blocked.
  if (existing.warehouseId) assertWarehouseAccess(actor, existing.warehouseId);
  // EDITABLE ONLY IN DRAFT — supplier/warehouse/quantities/prices/header all lock once submitted.
  if (existing.status !== "draft") {
    throw conflict("Only draft purchase orders can be edited. Reject it back to draft first.");
  }

  const headerPatch: Prisma.PurchaseOrderUncheckedUpdateInput = { updatedBy: actor?.email ?? null };

  // Supplier / warehouse: validate + re-snapshot only when changed.
  if (input.supplierId !== undefined && input.supplierId !== existing.supplierId) {
    const s = await supplierService.requireActiveSupplier(input.supplierId);
    headerPatch.supplierId = input.supplierId;
    headerPatch.supplierName = s.name;
  }
  if (input.warehouseId !== undefined && input.warehouseId !== existing.warehouseId) {
    // Can't move a PO to a warehouse outside the scoped actor's set either (no-op if unrestricted).
    if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
    await warehouseService.requireActiveWarehouse(input.warehouseId);
    headerPatch.warehouseId = input.warehouseId;
  }
  if (input.jobId !== undefined) headerPatch.jobId = await resolveJobId(input.jobId);
  if (input.projectRef !== undefined) headerPatch.projectRef = trimToNull(input.projectRef);
  if (input.priority !== undefined) headerPatch.priority = input.priority;
  if (input.referenceNumber !== undefined) headerPatch.referenceNumber = trimToNull(input.referenceNumber);
  if (input.description !== undefined) headerPatch.description = trimToNull(input.description);
  if (input.orderDate !== undefined) headerPatch.orderDate = new Date(input.orderDate);
  if (input.expectedDeliveryDate !== undefined) headerPatch.expectedDeliveryDate = new Date(input.expectedDeliveryDate);
  if (input.deliveryAddress !== undefined) headerPatch.deliveryAddress = trimToNull(input.deliveryAddress);
  if (input.deliveryInstructions !== undefined) headerPatch.deliveryInstructions = trimToNull(input.deliveryInstructions);
  if (input.deliveryTerms !== undefined) headerPatch.deliveryTerms = input.deliveryTerms ?? null;
  if (input.paymentTerms !== undefined) headerPatch.paymentTerms = trimToNull(input.paymentTerms);
  if (input.internalNotes !== undefined) headerPatch.internalNotes = trimToNull(input.internalNotes);
  if (input.supplierNotes !== undefined) headerPatch.supplierNotes = trimToNull(input.supplierNotes);

  let result: PurchaseOrderWithRelations;
  if (input.items !== undefined) {
    const lineRows = await buildLineRows(input.items);
    // A line of SOME kind must remain. The schema can no longer enforce this on `items` alone —
    // a hire-only order legitimately has none — so the check lives where the rental lines are visible.
    if (lineRows.length === 0 && existing.rentalItems.length === 0) {
      throw badRequest("Add at least one item or rental line.");
    }
    // The rental lines are NOT replaced here — this endpoint only edits IRM lines — but they still
    // carry money, so the header roll-up has to include them. Computing from `lineRows` alone made
    // a draft edit silently drop the hire value back out of the totals that conversion had just
    // put in, leaving a hire-only order reading £0 with its lines still on screen.
    const totals = computeTotals([...lineRows, ...existing.rentalItems]);
    result = await poRepo.replaceItemsAndTotals(id, lineRows, totals, headerPatch);
  } else {
    result = await poRepo.update(id, headerPatch);
  }
  // Field-level change audit (Zoho/SAP-style): capture the before→after of the commercially-meaningful
  // fields — supplier, warehouse, and each line's qty/price/VAT — so a pre-issue edit is traceable.
  // `result` carries the fully-resolved post-update values; lines only diffed when the update sent them.
  const withKeys = <T extends { irmItemId: string }>(lines: T[]) => lines.map((l) => ({ ...l, lineKey: l.irmItemId }));
  const changes = diffProcurementChanges({ ...existing, items: withKeys(existing.items) }, {
    supplierId: result.supplierId,
    supplierName: result.supplierName,
    warehouseId: result.warehouseId,
    items: input.items !== undefined ? withKeys(result.items) : undefined,
  });
  audit.record({
    actor,
    action: "purchase_order.updated",
    targetType: "purchase_order",
    targetId: id,
    targetLabel: result.code,
    metadata: changes.length ? { changes } : undefined,
  });
  emitPoUpdated(result);
  return toPublic(result);
}

// ── Workflow actions (each transition-guarded + stamped + audited) ───────────────────────────
// Load a PO for a write/workflow action and enforce warehouse-access scoping in one place. The
// assertion is a no-op for unrestricted actors and is skipped when the PO has no delivery warehouse
// yet (null warehouseId) — only a set warehouse outside the scoped actor's set is blocked (403).
async function loadOrThrow(id: string, actor?: AuditActor): Promise<PurchaseOrderWithRelations> {
  const po = await poRepo.findById(id);
  if (!po) throw notFound("Purchase order not found.");
  if (po.warehouseId) assertWarehouseAccess(actor, po.warehouseId);
  return po;
}
function recordStatus(actor: AuditActor | undefined, id: string, code: string, action: string): void {
  audit.record({ actor, action, targetType: "purchase_order", targetId: id, targetLabel: code });
}

// Fan a PO's change out to every procurement watcher so their list/detail live-refreshes. A PO
// passes through several hands (raiser → finance approver → PM → warehouse), so a screen left open
// on one desk goes stale the moment someone else acts on it — that is exactly how a user ends up
// clicking "Send to supplier" on an order another session already sent.
//
// The payload is a scope-agnostic REFETCH SIGNAL, not the order itself: each client re-pulls
// through its own warehouse-scoped REST call, so the shared room can never leak an order outside a
// watcher's scope. Emitting is fire-and-forget and MUST NOT affect the caller — a realtime failure
// can never roll back a committed transition (emitToRoom is already a no-op when realtime is
// uninitialised, e.g. in unit tests).
function emitPoUpdated(po: { id: string; code: string; status: string }): void {
  emitToRoom(PURCHASE_ORDER_WATCHERS_ROOM, "purchase_order:updated", {
    id: po.id,
    code: po.code,
    status: po.status,
  });
  // Every PO transition moves at least one attention queue (approve → send → acknowledge → receive →
  // close), so the global badges refresh on the same signal the PO surfaces already use.
  emitAttentionChanged("purchase_orders");
}

export async function submitPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "pending_approval");
  // A line of EITHER kind — an order converted from a hire-only request has no IRM lines at all,
  // and checking `items` alone would strand it in draft forever.
  if (po.items.length === 0 && po.rentalItems.length === 0) {
    throw badRequest("Add at least one item or rental line before submitting.");
  }
  // Same reason as approve: this is the last point where the PO is still an editable draft.
  if (!po.expectedDeliveryDate) throw conflict("Set an expected delivery date before submitting this purchase order.");
  const updated = await poRepo.update(id, { status: "pending_approval", submittedBy: actor?.email ?? null, submittedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.submitted");
  emitPoUpdated(updated);
  // Fire-and-forget: notify approvers a PO awaits their decision. NEVER blocks or rolls back.
  void poEmail.notifyApproversPoSubmitted(updated, actor?.email ?? null).catch((e) =>
    console.error(`PO ${updated.code} approval notification failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

// ── PRF fast-path: commercial equality ────────────────────────────────────────────────────────
// A PRF-born PO may go draft → approved WITHOUT a second finance review ONLY while it still
// commercially matches the approved PRF. INVARIANT: this comparison must cover EVERY input that
// feeds computeTotals — today supplier, warehouse, currency and the line multiset
// {irmItemId, quantity, unitPricePence, vatRate}. If a commercial field is ever added (discount,
// delivery charge, …) it MUST be added here in the same change, or it becomes a silent bypass.
// Exported (pure) for unit testing.
export function commerciallyMatchesPrf(
  po: { supplierId: string; warehouseId: string; currency: string | null; items: { irmItemId: string; quantity: number; unitPricePence: number; vatRate: number }[] },
  prf: { supplierId: string; warehouseId: string; currency: string | null; items: { irmItemId: string; quantity: number; unitPricePence: number; vatRate: number }[] },
): boolean {
  if (po.supplierId !== prf.supplierId) return false;
  if (po.warehouseId !== prf.warehouseId) return false;
  if ((po.currency ?? "GBP") !== (prf.currency ?? "GBP")) return false;
  if (po.items.length !== prf.items.length) return false;
  // Items are unique per irmItemId on both documents (DB-enforced), so a keyed map is a
  // faithful multiset comparison.
  const prfByItem = new Map(prf.items.map((l) => [l.irmItemId, l]));
  for (const line of po.items) {
    const ref = prfByItem.get(line.irmItemId);
    if (!ref) return false;
    if (line.quantity !== ref.quantity || line.unitPricePence !== ref.unitPricePence || line.vatRate !== ref.vatRate) return false;
  }
  return true;
}

// Result of an approve on a PRF-born draft: either it was approved via the fast path, or it had
// commercially diverged from its PRF and was instead routed into the normal review queue (so the
// user is never stuck on a draft with no forward action).
export interface ApproveResult {
  purchaseOrder: PublicPurchaseOrder;
  divertedToReview: boolean; // true = diverged → moved to pending_approval instead of approved
}

export async function approvePurchaseOrder(id: string, actor?: AuditActor): Promise<ApproveResult> {
  const po = await loadOrThrow(id, actor);
  // Catch a missing delivery date HERE, while the order is still an editable draft and the Edit
  // button is on screen (updatePurchaseOrder accepts the date, but only in draft). Past this point
  // the PO locks and there is no reverse edge back to draft, so an order that slipped through
  // dateless could be neither sent nor fixed — only cancelled. Send re-checks as a backstop.
  if (!po.expectedDeliveryDate) {
    throw conflict("Set an expected delivery date before approving this purchase order.");
  }
  if (po.status === "draft" && po.purchaseRequestId) {
    // FAST PATH — finance already approved these numbers on the PRF; skip pending_approval as long
    // as the PO still commercially matches it. If it has DIVERGED (a draft edit changed supplier /
    // warehouse / items / quantities / prices), the numbers finance signed off no longer hold — so
    // it must be re-reviewed. Rather than dead-end the draft (the actor may hold `approve` but not
    // `submit`, leaving no forward button), route it into the normal review queue automatically.
    const prf = await prfRepo.findById(po.purchaseRequestId);
    if (!prf) throw conflict("The source purchase request no longer exists — submit this order for approval instead.");
    if (!commerciallyMatchesPrf(po, prf)) {
      const submitted = await poRepo.update(id, { status: "pending_approval", submittedBy: actor?.email ?? null, submittedAt: new Date() });
      recordStatus(actor, id, submitted.code, "purchase_order.submitted");
      emitPoUpdated(submitted);
      // Fire-and-forget: notify approvers, same as a normal submit.
      void poEmail.notifyApproversPoSubmitted(submitted, actor?.email ?? null).catch((e) =>
        console.error(`PO ${submitted.code} approval notification failed:`, e instanceof Error ? e.message : e),
      );
      return { purchaseOrder: toPublic(submitted), divertedToReview: true };
    }
    const updated = await poRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
    audit.record({
      actor,
      action: "purchase_order.approved",
      targetType: "purchase_order",
      targetId: id,
      targetLabel: updated.code,
      metadata: { fastPath: true, purchaseRequestId: po.purchaseRequestId },
    });
    emitPoUpdated(updated);
    return { purchaseOrder: toPublic(updated), divertedToReview: false };
  }
  assertTransition(po.status, "approved");
  const updated = await poRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.approved");
  emitPoUpdated(updated);
  return { purchaseOrder: toPublic(updated), divertedToReview: false };
}

// ── PM routing (approved → pm_review; re-assign while in pm_review) ──────────────────────────
// The PM must be an active staff user whose role can actually send a PO. `resolvePmCandidates`
// is the single seam encapsulating the suggestion priority — today the linked job's creator;
// when Job later gains planner/PM user fields they slot in HERE, nothing else changes.
export interface PmCandidate {
  id: string;
  name: string;
  email: string;
}
export async function resolvePmCandidates(jobId?: string): Promise<{ candidates: PmCandidate[]; suggestedUserId: string | null }> {
  const users = await userRepo.findActiveWithRole();
  const candidates = users
    .filter((u) => {
      const perms = u.role?.permissions ?? [];
      return perms.includes("purchase_orders.send") || perms.includes("*");
    })
    .map((u) => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(" "), email: u.email }));
  let suggestedUserId: string | null = null;
  if (jobId && OBJECT_ID_RE.test(jobId)) {
    const job = await jobRepo.findById(jobId);
    const creatorId = job?.createdByUserId ?? null;
    if (creatorId && candidates.some((c) => c.id === creatorId)) suggestedUserId = creatorId;
  }
  return { candidates, suggestedUserId };
}

export async function assignPmPurchaseOrder(id: string, pmUserId: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  const reassign = po.status === "pm_review";
  if (!reassign) assertTransition(po.status, "pm_review");

  const pm = (await userRepo.findActiveWithRole()).find((u) => u.id === pmUserId);
  if (!pm) throw badRequest("Selected project manager is not an active staff user.");
  const pmPerms = pm.role?.permissions ?? [];
  if (!pmPerms.includes("purchase_orders.send") && !pmPerms.includes("*")) {
    throw badRequest("Selected user can't send purchase orders — pick a user whose role has the Send permission.");
  }

  const updated = await poRepo.update(id, {
    status: "pm_review",
    pmUserId: pm.id,
    pmName: [pm.firstName, pm.lastName].filter(Boolean).join(" "),
    pmEmail: pm.email,
    pmAssignedAt: new Date(),
    pmAssignedBy: actor?.email ?? null,
  });
  audit.record({
    actor,
    action: reassign ? "purchase_order.pm_reassigned" : "purchase_order.pm_assigned",
    targetType: "purchase_order",
    targetId: id,
    targetLabel: updated.code,
    metadata: { pmEmail: pm.email, previousPmEmail: reassign ? po.pmEmail : undefined },
  });
  emitPoUpdated(updated);
  // Fire-and-forget: tell the PM a PO awaits their review + send. NEVER blocks or rolls back.
  void poEmail.notifyPmAssigned(updated).catch((e) =>
    console.error(`PO ${updated.code} PM notification failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function rejectPurchaseOrder(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "draft"); // reject = back to draft for rework
  const updated = await poRepo.update(id, { status: "draft", rejectionReason: reason.trim() });
  recordStatus(actor, id, updated.code, "purchase_order.rejected");
  emitPoUpdated(updated);
  return toPublic(updated);
}

// Archive the exact issued document at send time as a system attachment — the document of
// record. The on-demand PDF endpoint keeps reflecting live data; THIS copy is what the supplier
// received, immune to later supplier-detail/branding changes. Fire-and-forget from send: an
// archive failure must never fail or roll back the send (matches the email convention).
async function archiveIssuedPdf(po: PurchaseOrderWithRelations, actor?: AuditActor): Promise<void> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    console.info(`PO ${po.code}: Cloudinary not configured — issued-PDF archive skipped.`);
    return;
  }
  const pdf = await documentService.generatePurchaseOrderPdf(po, actor?.email ?? po.sentBy);
  const dataUri = `data:application/pdf;base64,${pdf.buffer.toString("base64")}`;
  const asset = await uploadFileToCloudinary(dataUri, randomUUID(), creds);
  await poRepo.addAttachment({
    purchaseOrderId: po.id,
    label: ISSUED_PO_ATTACHMENT_LABEL,
    fileName: pdf.filename,
    fileType: "pdf",
    fileSizeBytes: pdf.buffer.length,
    url: asset.url,
    // Recorded like any other attachment even though this row can never be removed — the guard in
    // removeAttachment is what protects it, not the absence of an identity.
    publicId: asset.publicId,
    resourceType: asset.resourceType,
    uploadedBy: "system",
  });
  audit.record({
    actor,
    action: "purchase_order.attachment_added",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: { issuedPdfArchive: true },
  });
}

export async function sendPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "sent");
  // A dateless PO must never reach a supplier: the delivery date is on the issued document, and
  // the receiving warehouse schedules against it. Drafts may legitimately lack one (the PRF-born
  // ones do when the supplier has no lead time on file), so this is the gate — not create/submit.
  if (!po.expectedDeliveryDate) {
    throw conflict("Set an expected delivery date before sending this purchase order to the supplier.");
  }
  // In pm_review only the ASSIGNED PM may send (that's the whole point of the stage). A holder
  // of assign_pm may override — e.g. the PM is away — and the override is visible in the audit
  // trail because sentBy won't match pmEmail.
  if (po.status === "pm_review") {
    const isAssignedPm = Boolean(actor?.id && po.pmUserId && actor.id === po.pmUserId);
    if (!isAssignedPm && !canOverridePm(actor)) {
      throw forbidden(`Only the assigned project manager (${po.pmName ?? po.pmEmail ?? "unassigned"}) can send this purchase order.`);
    }
  }
  // sentBy is the issuer — the signer printed on the PO document (deterministic for email + download).
  const updated = await poRepo.update(id, { status: "sent", sentAt: new Date(), sentBy: actor?.email ?? null });
  recordStatus(actor, id, updated.code, "purchase_order.sent");
  // The catch-up for a hire received while the order was still a draft: the quantities were recorded
  // then, but the status could not legally move until now. Fire-and-forget in the same sense as the
  // rest of this block — the send itself has already committed.
  await recomputeRentalReceiptStatus(id, actor);
  emitPoUpdated(updated);
  // Fire-and-forget: email the supplier the issued PO with its PDF. NEVER blocks or rolls back.
  void poEmail.notifySupplierPoSent(updated, actor).catch((e) =>
    console.error(`PO ${updated.code} supplier email failed:`, e instanceof Error ? e.message : e),
  );
  // Fire-and-forget: archive the exact issued PDF (document of record). NEVER blocks or rolls back.
  void archiveIssuedPdf(updated, actor).catch((e) =>
    console.error(`PO ${updated.code} issued-PDF archive failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

// ── Supplier acceptance (a recorded EVENT, not a workflow gate) ───────────────────────────────
// Recorded manually by staff when the supplier confirms by email/phone. The confirmed delivery
// date is REQUIRED: accepting an order means committing to a date, and this is the date the
// warehouse plans against (it takes precedence over expectedDeliveryDate in the incoming-stock
// worklist). A supplier who later moves it is handled by updateConfirmedDeliveryDate, which
// audits {previousDate, newDate, reason}.
//
// Receiving is NEVER blocked on acknowledgement (see requireReceivablePurchaseOrder), so goods
// routinely arrive before the paperwork. The acknowledgement is therefore recordable at any
// non-terminal issued status — but it only ADVANCES the status from `sent`. Recording it on an
// already-receiving order keeps the receipt status as the source of truth rather than rewinding
// the lifecycle. Re-recording on an accepted order corrects the details (e.g. a mistyped ack
// reference) and is audited like any other.
export async function recordSupplierAcceptance(
  id: string,
  input: PoSupplierAcceptInput,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  if (!ACCEPTANCE_RECORDABLE.has(po.status)) {
    throw conflict(`Supplier acceptance can't be recorded on a ${humanStatus(po.status)} purchase order.`);
  }
  // Only the awaiting-acknowledgement state moves; every other recordable status stays put.
  const advances = po.status === "sent";
  // The confirmed date is REQUIRED while the delivery is still ahead, and optional once it is behind.
  //
  // Accepting an order that has not arrived is a commitment to a date, and that date is what the
  // warehouse plans against — so it is asked for and refused if missing. Once the goods are in there
  // is nothing left to plan: the real arrival is on the receipt, and insisting on a "confirmed
  // delivery date" would push somebody to type the date it actually turned up, filing an arrival
  // under a field that means "what the supplier promised". A late acknowledgement is about the
  // reference and the notes.
  const AWAITING_DELIVERY = po.status === "sent" || po.status === "supplier_accepted";
  if (AWAITING_DELIVERY && !input.confirmedDeliveryDate) {
    throw badRequest("Enter the delivery date the supplier confirmed.");
  }
  const confirmed = input.confirmedDeliveryDate ? new Date(input.confirmedDeliveryDate) : null;
  const updated = await poRepo.update(id, {
    ...(advances ? { status: "supplier_accepted" } : {}),
    supplierAcceptedAt: input.acceptedDate ? new Date(input.acceptedDate) : new Date(),
    supplierAcceptedBy: actor?.email ?? null,
    supplierAckReference: trimToNull(input.supplierAckReference),
    // Left ALONE when none is given, rather than nulled: a late acknowledgement must not erase the
    // date the supplier committed to earlier in the order's life.
    ...(confirmed ? { confirmedDeliveryDate: confirmed } : {}),
    supplierAcceptNotes: trimToNull(input.notes),
  });
  audit.record({
    actor,
    action: "purchase_order.supplier_accepted",
    targetType: "purchase_order",
    targetId: id,
    targetLabel: updated.code,
    metadata: {
      supplierAckReference: trimToNull(input.supplierAckReference) ?? undefined,
      confirmedDeliveryDate: confirmed?.toISOString(),
      // Makes a LATE acknowledgement self-evident in the ledger: the status it was recorded
      // against, and whether that status moved as a result.
      statusAtAcceptance: po.status,
      statusChanged: advances,
    },
  });
  emitPoUpdated(updated);
  return toPublic(updated);
}

// Revise a confirmed delivery date the supplier has already given, at any point before the order
// closes. The audit metadata carries {previousDate, newDate, reason} — the audit ledger IS the
// revision history (Friday → Monday → Wednesday stays fully traceable for disputes); no separate
// history table.
export async function updateConfirmedDeliveryDate(
  id: string,
  confirmedDeliveryDate: string,
  reason: string | undefined,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  // Revisable right up to closure — a supplier can move the date after part of the order has
  // already landed, and the warehouse plans against this field, so it must stay correctable.
  if (po.status === "closed" || po.status === "cancelled") {
    throw conflict(`The confirmed delivery date can't be changed on a ${humanStatus(po.status)} purchase order.`);
  }
  // This endpoint REVISES an existing promise; recordSupplierAcceptance is the only way to create
  // one. That keeps a single entry point and keeps the audit's `previousDate` meaningful.
  if (!po.confirmedDeliveryDate) {
    throw conflict("Record the supplier's acceptance before revising the confirmed delivery date.");
  }
  const next = new Date(confirmedDeliveryDate);
  // Same invariant poSupplierAcceptSchema enforces at capture: a supplier can't promise delivery
  // BEFORE they acknowledged the order. Enforced here too, or a revision could smuggle in a date
  // the original capture would have rejected — which lands as a phantom "overdue" in the
  // warehouse worklist. Date-only comparison, matching the schema's refine.
  if (po.supplierAcceptedAt) {
    const dayStart = (d: Date) => Date.parse(d.toISOString().slice(0, 10));
    if (dayStart(next) < dayStart(po.supplierAcceptedAt)) {
      throw conflict("The confirmed delivery date can't be before the date the supplier accepted the order.");
    }
  }
  const updated = await poRepo.update(id, { confirmedDeliveryDate: next });
  audit.record({
    actor,
    action: "purchase_order.delivery_date_updated",
    targetType: "purchase_order",
    targetId: id,
    targetLabel: updated.code,
    metadata: {
      previousDate: po.confirmedDeliveryDate ? po.confirmedDeliveryDate.toISOString() : null,
      newDate: next.toISOString(),
      reason: reason?.trim() || undefined,
    },
  });
  emitPoUpdated(updated);
  return toPublic(updated);
}

export async function cancelPurchaseOrder(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "cancelled");
  // Hired kit we are STILL HOLDING blocks a cancellation, the same way it blocks a close — and for a
  // sharper reason. Cancelling is a one-way door with no way back through it: every hire predicate
  // excludes a cancelled order (rentalHire.predicate's LIVE_ORDER), and the return and damage paths
  // only accept an order in the receiving window, so the handover could never be recorded at all. The
  // supplier's equipment would sit in the yard on no list, on no badge and on no report.
  //
  // Asked on the QUANTITIES rather than on `hireStatus`, because the status cannot answer this: a
  // part-delivered line whose delivered units have all gone back is still `on_hire`, and it holds
  // nothing. What matters is whether any of the supplier's kit is physically here.
  //
  // Hires that never arrived are deliberately NOT blocked: cancelling the order is the right way to
  // end those, and they leave every queue with it.
  const held = po.rentalItems.filter((r) => (r.receivedQuantity ?? 0) > (r.returnedQuantity ?? 0));
  if (held.length > 0) {
    const line = held[0]!;
    throw conflict(
      `${(line.receivedQuantity ?? 0) - (line.returnedQuantity ?? 0)} ${line.itemName} are still on hire here. ` +
        `Record the return before cancelling this purchase order.`,
    );
  }
  const updated = await poRepo.update(id, { status: "cancelled", cancelledAt: new Date(), cancelReason: trimToNull(reason) });
  recordStatus(actor, id, updated.code, "purchase_order.cancelled");
  emitPoUpdated(updated);
  // Fire-and-forget: notify the supplier ONLY if the PO had already been issued to them.
  void poEmail.notifySupplierPoCancelled(updated).catch((e) =>
    console.error(`PO ${updated.code} cancellation email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function closePurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "closed");
  // An order whose hired equipment is still in our hands is not finished — the supplier is still
  // billing for it and it still has to go back. Closing would also be a one-way door: the return and
  // damage paths refuse a closed order, so the handover could never be recorded and the deadline
  // badges would keep counting a hire nobody could clear.
  const stillOut = po.rentalItems.filter((r) => !isTerminalHireStatus(r.hireStatus));
  if (stillOut.length > 0) {
    throw conflict(
      `${stillOut[0]!.itemName} is still on hire. Record its return before closing this purchase order.`,
    );
  }
  const updated = await poRepo.update(id, { status: "closed", closedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.closed");
  emitPoUpdated(updated);
  return toPublic(updated);
}

export async function deletePurchaseOrder(id: string, actor?: AuditActor): Promise<void> {
  const po = await loadOrThrow(id, actor);
  if (po.status !== "draft") throw conflict("Only draft purchase orders can be deleted.");
  await poRepo.softDelete(id);
  audit.record({ actor, action: "purchase_order.deleted", targetType: "purchase_order", targetId: id, targetLabel: po.code });

  // Give the REQUEST back if this order came from one.
  //
  // Deleting a draft PO means "this order should not have been raised" — but the request behind it
  // was legitimately approved, and `converted` is a terminal status (ALLOWED_TRANSITIONS.converted
  // is empty). Without this the request was stranded: no PO, no Generate PO, no Reopen, and a
  // "View PO-0051" button pointing at a record the loader refuses. The only way forward was to
  // duplicate it as a revision, which burns a PRF number and detaches the work from its approval.
  //
  // Returning it to `approved` puts it back exactly where it was the moment before the conversion,
  // so the ordinary Generate PO path is available again. Both the delete and this move are audited,
  // so the round trip is legible afterwards — the history is added to, not rewritten.
  //
  // Only draft POs can be deleted, so this can never rewind a request whose order was already sent.
  if (po.purchaseRequestId && (await prfRepo.revertConversion(po.purchaseRequestId, actor?.email ?? null))) {
    audit.record({
      actor,
      action: "purchase_request.conversion_reverted",
      targetType: "purchase_request",
      targetId: po.purchaseRequestId,
      targetLabel: po.purchaseRequest?.code,
      metadata: { purchaseOrderCode: po.code, reason: "The purchase order generated from it was deleted." },
    });
    // The request is countable again under "Approved — generate PO".
    emitAttentionChanged("purchase_requests");
  }

  // Same refetch signal as a status change: a watcher's list re-pulls and the row simply disappears.
  // `deleted` is not a real PO status — it is only a hint; clients act on the refetch, not the value.
  emitPoUpdated({ id, code: po.code, status: "deleted" });
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────
// A PO is immutable once it reaches a terminal state — attachments can't be changed on a
// closed or cancelled order (consistent with the draft-only edit lock on the header/lines).
/**
 * The archived issued-PO document — the record of exactly what the supplier received.
 *
 * ONE predicate, because two places depend on it and they must agree: the count cap excludes this row
 * so a full cap can never starve the archive, and removeAttachment refuses to delete it. If those two
 * drifted, the cap would reserve a slot for something the guard no longer protected.
 *
 * Both halves are required. The label alone is reserved but user-supplied labels are checked against
 * it on the way in, and `uploadedBy === "system"` is what only the archive writer can set.
 */
function isIssuedPoArchive(a: { label: string | null; uploadedBy: string | null }): boolean {
  return a.label === ISSUED_PO_ATTACHMENT_LABEL && a.uploadedBy === "system";
}

function assertAttachmentsEditable(status: string): void {
  if (status === "closed" || status === "cancelled") {
    throw conflict("Attachments can't be changed on a closed or cancelled purchase order.");
  }
}

/**
 * May this order take one more document of this size?
 *
 * Needed twice once the browser uploads straight to Cloudinary: before the file is sent, and again at
 * attachment time — the order can gain documents, or close, while a file is in flight.
 *
 * `label` is checked here too because the reserved archive label must be refused before an upload, not
 * after it.
 */
export async function assertCanAttach(poId: string, fileSizeBytes: number, label?: string | null, actor?: AuditActor): Promise<void> {
  const po = await loadOrThrow(poId, actor);
  assertAttachmentsEditable(po.status);
  if (label?.trim() === ISSUED_PO_ATTACHMENT_LABEL) {
    throw badRequest(`"${ISSUED_PO_ATTACHMENT_LABEL}" is a reserved label.`);
  }
  // USER documents only — the system's issued-PO archive keeps its own slot, or a buyer who filled the
  // cap would silently leave the order with no document of record.
  const userAttachments = po.attachments.filter((a) => !isIssuedPoArchive(a));
  if (userAttachments.length >= PO_ATTACHMENT_MAX_COUNT) {
    throw badRequest(`A purchase order can have at most ${PO_ATTACHMENT_MAX_COUNT} documents.`);
  }
  const totalBytes = userAttachments.reduce((sum, a) => sum + a.fileSizeBytes, 0);
  if (totalBytes + fileSizeBytes > PO_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw badRequest("Total documents on a purchase order can't exceed 80 MB.");
  }
}

/** One already-stored asset, recorded against this order. */
export interface AttachAssetInput {
  label?: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  publicId: string;
  resourceType: string;
}

/**
 * Record an asset that is ALREADY in storage — the single place a PO attachment row is written.
 *
 * Both entry points end here: the older path that uploads through this server, and the direct-upload
 * finalize. `tx` is passed by the latter, which commits this row and the removal of its pending-upload
 * ledger entry together.
 */
export async function attachUploadedAsset(
  poId: string,
  input: AttachAssetInput,
  actor?: AuditActor,
  tx?: Prisma.TransactionClient,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  await assertCanAttach(poId, input.fileSizeBytes, input.label, actor);
  await poRepo.addAttachment(
    {
      purchaseOrderId: poId,
      label: trimToNull(input.label),
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
  // Non-transactional path only — see recordAttachmentAudit.
  if (!tx) recordAttachmentAudit(po, actor);
  return getPurchaseOrder(poId, actor);
}

/**
 * The attachment-added audit event, in one place.
 *
 * `audit.record` is fire-and-forget and writes on the default client, so it does NOT roll back with a
 * caller's `tx`: fired inside the direct-upload transaction, an abort after the write would leave an
 * entry for an attachment that was never committed. The transactional caller fires this after its
 * commit instead, and the event stays defined once.
 */
export function recordAttachmentAudit(po: { id: string; code: string }, actor?: AuditActor): void {
  audit.record({ actor, action: "purchase_order.attachment_added", targetType: "purchase_order", targetId: po.id, targetLabel: po.code });
}

export async function addAttachment(poId: string, input: PoAttachmentInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  // Before the upload, so a rejected attachment never reaches Cloudinary as an orphan.
  await assertCanAttach(poId, input.fileSizeBytes, input.label, actor);
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("File uploads aren't configured. Add Cloudinary credentials in Settings first.");
  const asset = await uploadFileToCloudinary(input.data, randomUUID(), creds);
  return attachUploadedAsset(
    poId,
    {
      label: input.label,
      fileName: input.fileName,
      fileType: input.fileType,
      fileSizeBytes: input.fileSizeBytes,
      url: asset.url,
      publicId: asset.publicId,
      resourceType: asset.resourceType,
    },
    actor,
  );
}

export async function removeAttachment(poId: string, attachmentId: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  assertAttachmentsEditable(po.status);
  const att = await poRepo.findAttachment(attachmentId);
  if (!att || att.purchaseOrderId !== poId) throw notFound("Attachment not found.");
  // The archived issued document is immutable — it IS the record of what the supplier received.
  if (isIssuedPoArchive(att)) {
    throw conflict("The archived issued PO document can't be removed.");
  }
  await poRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "purchase_order.attachment_removed", targetType: "purchase_order", targetId: poId, targetLabel: po.code });
  // The PO side is where the shared-asset case actually bites: a PO converted from a PRF holds
  // COPIES of that PRF's attachment identities, and the PRF (now `converted`) still displays them.
  // releaseAsset counts the surviving references, so removing the copy here leaves the file alone.
  await attachmentService.releaseAsset(att, `purchase_order ${po.code}`);
  return getPurchaseOrder(poId, actor);
}

// ── Seams for the FUTURE Goods In module (NOT wired to any PO endpoint) ───────────────────────
// Assert a PO can receive stock; Goods In calls this before recording a receipt.
export async function requireReceivablePurchaseOrder(id: string): Promise<PurchaseOrderWithRelations> {
  if (!id || !OBJECT_ID_RE.test(id)) throw badRequest("Select a purchase order.");
  const po = await poRepo.findById(id);
  if (!po) throw badRequest("Selected purchase order no longer exists.");
  // Goods can arrive whether or not the supplier's acceptance was recorded — a missing
  // acknowledgement must never block the warehouse.
  if (po.status !== "sent" && po.status !== "supplier_accepted" && po.status !== "partially_received") {
    throw conflict("This purchase order can't receive stock in its current status.");
  }
  return po;
}
// Pure helper Goods In calls AFTER writing line receivedQuantity to derive the new status. In
// THIS module every line's receivedQuantity is 0, so it returns "sent" unchanged.
//
// Takes LINES, not a purchase order, and knows nothing about what kind of line they are — which is
// what lets hire lines join the same arithmetic without Goods In ever hearing about them. Goods In
// keeps passing its own items; `recomputeRentalReceiptStatus` below loads BOTH kinds itself.
export function recomputeReceiptStatus(
  items: {
    quantity: number;
    /** What physically TURNED UP. Answers "has anything arrived". */
    receivedQuantity: number;
    /**
     * What is no longer OUTSTANDING — arrived, or formally written off. Defaults to `receivedQuantity`,
     * which is the whole story for goods; only a hire can settle a unit without receiving it.
     *
     * TWO figures because the status asks two questions, and folding them into one broke the second:
     * counting written-off units as received made "has anything arrived" true with an empty yard, so a
     * hire-only order whose kit never came reported itself FULLY RECEIVED — and `ALLOWED_TRANSITIONS`
     * has no path from there, or from `partially_received`, back to `cancelled`. Closing a hire short
     * permanently removed the buyer's ability to cancel the order, which is the honest exit when
     * nothing ever turned up.
     */
    settledQuantity?: number;
  }[],
): "sent" | "partially_received" | "fully_received" {
  // NOTHING has physically turned up. The order has not entered the receiving flow at all, whatever
  // its lines have settled — and it must stay cancellable, which no received status is. Asked FIRST,
  // because a write-off settles every unit on a line without a single one arriving, and that alone
  // would otherwise read as "fully received" on an order with an empty yard.
  const anyReceived = items.some((i) => i.receivedQuantity > 0);
  if (!anyReceived) return "sent";
  const nothingOutstanding =
    items.length > 0 && items.every((i) => (i.settledQuantity ?? i.receivedQuantity) >= i.quantity);
  return nothingOutstanding ? "fully_received" : "partially_received";
}

/**
 * Re-derive an order's received status after a HIRE delivery, and advance it if it moved.
 *
 * Called by the rental-receipt module, which owns hire deliveries. It lives here because the answer
 * depends on BOTH kinds of line: a hire-only order used to be stuck in `sent` forever, because the
 * only path to `fully_received` counted `items` and `items.length > 0` is false when every line is a
 * hire. Now the same arithmetic sees both.
 *
 * The direction of the dependency matters. Hire lines are loaded HERE and handed to the shared pure
 * helper; the rental module never reaches into Goods In, and Goods In never learns that hire lines
 * exist — which is what modules/__tests__/rental.boundary.test.ts enforces at build time.
 *
 * Forward-only, exactly like the goods path: `sent → partially_received → fully_received`, and never
 * back down. A reversed note can lower the quantities, but an order that was fully received is a
 * fact somebody acted on — reopening it silently is the bug that path already guards against for
 * `closed` and `cancelled`.
 */
export async function recomputeRentalReceiptStatus(
  purchaseOrderId: string,
  actor?: AuditActor,
  // Set ONLY by a reversal. Every other caller adds quantity, so its recompute can only move the
  // status forwards; a reversal is the one operation that takes quantity away, and without this the
  // order is left claiming `fully_received` for kit it no longer has any record of receiving — which
  // then drops it out of the receiving window, so the units it just gave back appear on no queue and
  // the Receive button is gone.
  opts: { allowDowngrade?: boolean } = {},
): Promise<void> {
  const po = await poRepo.findById(purchaseOrderId);
  if (!po) return;
  // Terminal states are immutable: a receipt must never reopen or mutate a closed or cancelled order.
  if (po.status === "closed" || po.status === "cancelled") return;

  const lines = [
    ...po.items.map((l) => ({ quantity: l.quantity, receivedQuantity: l.receivedQuantity })),
    // A hire's WRITTEN-OFF units are no longer OUTSTANDING — that is precisely what closing short
    // decided — but they never ARRIVED, and the status asks both questions. So they go in
    // `settledQuantity` and stay out of `receivedQuantity`.
    //
    // Outstanding, because counting `receivedQuantity` alone left a short-closed order stuck at
    // `partially_received` for good: closable, but never `fully_received`, so never in "Received —
    // ready to close", the chip that is the canonical worklist for closing orders.
    //
    // Not arrived, because the reverse mistake is worse: an order whose hire never came would report
    // itself received, and no received status has a path back to `cancelled`.
    ...po.rentalItems.map((l) => ({
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity ?? 0,
      settledQuantity: (l.receivedQuantity ?? 0) + (l.cancelledQuantity ?? 0),
    })),
  ];
  const computed = recomputeReceiptStatus(lines);

  // NOTHING received any more. `recomputeReceiptStatus` calls that "sent", but an order the supplier
  // acknowledged does not un-acknowledge itself — it goes back to where it stood before the first
  // delivery landed, which is `supplier_accepted` when there is an acceptance on file.
  const preReceipt = po.supplierAcceptedAt ? "supplier_accepted" : "sent";
  const next = computed === "sent" ? preReceipt : computed;
  if (next === po.status) return;

  // A DOWNGRADE — only a reversal may ask for one, and only back into the receiving window. It
  // deliberately skips the transition check below: `ALLOWED_TRANSITIONS` is forward-only by design,
  // and this is the one legitimate way back.
  const isDowngrade = RECEIPT_PROGRESS.indexOf(next) < RECEIPT_PROGRESS.indexOf(po.status);
  if (isDowngrade) {
    if (!opts.allowDowngrade) return;
    await poRepo.update(po.id, { status: next });
    // Its own action, not `purchase_order.sent`: the order was not re-sent, its receipts were undone.
    audit.record({
      actor,
      action: "purchase_order.receipt_reverted",
      targetType: "purchase_order",
      targetId: po.id,
      targetLabel: po.code,
      metadata: { from: po.status, to: next },
    });
    emitPoUpdated({ id: po.id, code: po.code, status: next });
    return;
  }

  // Forwards. `sent`/`supplier_accepted` mean "nothing received yet", which is not a transition — it
  // is the absence of one.
  if (next !== "partially_received" && next !== "fully_received") return;
  // And only from a status the state machine can legally leave for it.
  //
  // A hire CAN be received against a draft order — paperwork lags reality, and a PRF-born order sits
  // in draft while its committed kit turns up. What must not follow is the order jumping to
  // `partially_received`: `ALLOWED_TRANSITIONS` has no path from there back to `sent`, so the order
  // could never be issued, the supplier would never receive it, and the only move left would be to
  // close it. This write bypasses `assertTransition` by design (it is derived, not commanded), which
  // is exactly why it has to ask the same question the transition would.
  //
  // Nothing is lost by waiting: `sendPurchaseOrder` re-runs this once the order is issued, so the
  // status catches up with the quantities already recorded.
  if (!ALLOWED_TRANSITIONS[po.status]?.includes(next)) return;

  await poRepo.update(po.id, { status: next });
  recordStatus(actor, po.id, po.code, `purchase_order.${next}`);
  emitPoUpdated({ id: po.id, code: po.code, status: next });
}

// ADDITIVE Goods In seam — called INSIDE the GRN completion transaction. Bumps each PO line's
// receivedQuantity by the physically-received delta, recomputes the received status from ALL
// lines, and advances the PO (sent → partially_received / fully_received) emitting the reserved
// audit verb. Forward-only: receivedQuantity only grows, so recompute never downgrades. No
// existing PO behaviour/field changes — this is the writer the seams above were built for.
/**
 * Returns the status change this receipt caused, or null — so the CALLER can record it after the
 * transaction commits.
 *
 * The audit write used to happen here, inside the transaction. `audit.record` is fire-and-forget and
 * commits on its own, so a later failure in the same transaction (a serial clash on the inventory
 * write, a Mongo write conflict) rolled everything back and left the trail permanently asserting
 * `purchase_order.fully_received` for an order that received nothing. An audit trail that can be
 * wrong about the one thing it exists to record is worse than no entry at all.
 */
export interface ReceiptStatusChange {
  code: string;
  status: "partially_received" | "fully_received";
}

export async function applyGoodsReceipt(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  deltas: { purchaseOrderItemId: string; receivedDelta: number }[],
  // No `actor`: this no longer writes anything the actor is stamped on. The status entry moved out to
  // `recordReceiptStatusChange`, which the caller runs once the transaction has committed.
): Promise<ReceiptStatusChange | null> {
  // Terminal-state guard: `closed` and `cancelled` are immutable — a receipt must NEVER reopen or
  // mutate such a PO (the bug this closes: completing a stale draft GRN silently un-closed the PO,
  // left a stale closedAt, and still wrote inventory). Loaded + checked BEFORE any write, so
  // throwing rolls back the whole GRN completion transaction — PO, inventory and GRN all unchanged.
  const header = await poRepo.headerForReceiptTx(tx, purchaseOrderId);
  if (!header) throw conflict("The purchase order for this receipt no longer exists.");
  if (header.status === "closed" || header.status === "cancelled") {
    throw conflict(`This purchase order is ${header.status} and can no longer receive stock.`);
  }

  // Concurrency backstop: re-validate each delta against the LIVE remaining inside the tx, so
  // two receipts can't over-receive the same PO line. (Throwing here rolls back the whole GRN
  // completion transaction — inventory included.)
  const before = await poRepo.lineReceiptTotalsTx(tx, purchaseOrderId);
  const liveById = new Map(before.map((l) => [l.id, l]));
  for (const d of deltas) {
    const l = liveById.get(d.purchaseOrderItemId);
    if (!l) throw conflict("A received line no longer exists on the purchase order.");
    const remaining = l.quantity - l.receivedQuantity;
    if (d.receivedDelta > remaining) {
      throw conflict(
        `Can't receive ${d.receivedDelta} on ${header.code} — only ${remaining} remaining (ordered ${l.quantity}, already received ${l.receivedQuantity}).`,
      );
    }
  }
  for (const d of deltas) {
    if (d.receivedDelta > 0) await poRepo.incrementLineReceivedTx(tx, d.purchaseOrderItemId, d.receivedDelta);
  }
  const lines = await poRepo.lineReceiptTotalsTx(tx, purchaseOrderId);
  const next = recomputeReceiptStatus(lines);
  if (next !== header.status && (next === "partially_received" || next === "fully_received")) {
    await poRepo.setStatusTx(tx, purchaseOrderId, next);
    // NOTE: emitted from inside the transaction, deliberately, unlike the audit entry. If it later
    // rolls back, watchers have been told to refetch a change that never landed — harmless, because
    // the payload is only a refetch SIGNAL: each client re-pulls the committed truth over REST and
    // simply sees the unchanged order. An audit entry has no such recovery, which is why it is
    // handed back to the caller instead.
    emitPoUpdated({ id: purchaseOrderId, code: header.code, status: next });
    return { code: header.code, status: next };
  }
  return null;
}

/** Record the status change `applyGoodsReceipt` reported — call it AFTER the transaction commits. */
export function recordReceiptStatusChange(
  purchaseOrderId: string,
  change: ReceiptStatusChange | null,
  actor?: AuditActor,
): void {
  if (!change) return;
  recordStatus(actor, purchaseOrderId, change.code, `purchase_order.${change.status}`);
}

// ── Supplier procurement summary (the supplier detail "Procurement" tab) ─────────────────────
// Counts + spend only. Deliberately NO placeholder metrics: average lead time / on-time % /
// late deliveries are fully computable later from timestamps that already exist
// (sentAt, confirmedDeliveryDate, GRN received dates) — a pure read-side follow-up.
export interface SupplierProcurementSummary {
  purchaseOrders: {
    total: number;
    byStatus: Record<string, number>;
    outstanding: number; // issued, not yet fully received
    open: number; // any non-terminal, not-yet-fully-received order
    cancelled: number;
    spendPence: number; // fully_received + closed orders only
    spend: number;
  };
  purchaseRequests: { total: number };
}
export async function getSupplierProcurementSummary(supplierId: string): Promise<SupplierProcurementSummary> {
  if (!supplierId || !OBJECT_ID_RE.test(supplierId)) throw badRequest("Select a supplier.");
  const [byStatus, spendPence, prfTotal] = await Promise.all([
    poRepo.statusCountsForSupplier(supplierId),
    poRepo.spendPenceForSupplier(supplierId),
    prfRepo.countBySupplier(supplierId),
  ]);
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (byStatus[k] ?? 0), 0);
  return {
    purchaseOrders: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      outstanding: sum(["sent", "supplier_accepted", "partially_received"]),
      open: sum(["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted", "partially_received"]),
      cancelled: byStatus["cancelled"] ?? 0,
      spendPence,
      spend: spendPence / 100,
    },
    purchaseRequests: { total: prfTotal },
  };
}

// READ seam for Warehouse Inventory: total still-to-arrive quantity for an item at a warehouse,
// summed across open POs (sent / partially_received). Pure read; no PO behaviour change.
export async function incomingForItemWarehouse(irmItemId: string, warehouseId: string): Promise<number> {
  const lines = await poRepo.incomingLinesForItemWarehouse(irmItemId, warehouseId);
  return lines.reduce((sum, l) => sum + Math.max(0, l.quantity - l.receivedQuantity), 0);
}

// Bulk sibling for the Reorder workbench: outstanding open-PO quantity for EVERY item × warehouse in
// one query, keyed "irmItemId|warehouseId". Pure read; the single-pair seam above stays untouched.
export async function incomingByItemWarehouse(): Promise<Map<string, number>> {
  const lines = await poRepo.openIncomingLines();
  const map = new Map<string, number>();
  for (const l of lines) {
    const remaining = Math.max(0, l.quantity - l.receivedQuantity);
    if (remaining === 0) continue;
    const key = `${l.irmItemId}|${l.purchaseOrder.warehouseId}`;
    map.set(key, (map.get(key) ?? 0) + remaining);
  }
  return map;
}

// ── Rental hires ──────────────────────────────────────────────────────────────────────────────
//
// The two actions a live hire supports. Everything else about a rental line is fixed at
// conversion: it was reviewed and committed to the supplier, so quantities and prices are not
// editable here any more than an IRM line's are.

/** The line, checked to belong to THIS order — an id alone would let one PO act on another's. */
async function loadRentalLine(poId: string, lineId: string) {
  const line = await poRepo.findRentalLine(lineId);
  if (!line || line.purchaseOrderId !== poId) throw notFound("Rental line not found on this purchase order.");
  return line;
}

/**
 * Close a hire SHORT — the outstanding units are never arriving.
 *
 * The supplier cannot supply them, the site no longer needs them, the job was descoped. Without this
 * there was no exit at all for such a line, and two permanent dead-ends followed from that:
 *
 *   • Nothing ever delivered. Return and mark-returned both refuse a hire that was never received, so
 *     the line sat on the warehouse's intake queue and the "not yet received" badge forever — and its
 *     order could never close, because the close guard demands every hire be finished.
 *   • Part delivered, the delivered units handed back. `createRentalReturn` correctly leaves that line
 *     `on_hire` (its undelivered units are still owed), and mark-returned refuses a line with
 *     collection records. Same dead-end, reached the other way.
 *
 * Deliberately NOT a quantity edit. `quantity` is what the supplier was sent and agreed to, and
 * rewriting a committed order's figures is what a PO amendment is for; the shortfall is recorded
 * BESIDE the order in `cancelledQuantity`, exactly as an extension's charge is. The two then add up:
 * received + cancelled = ordered.
 *
 * Where it leaves the hire depends on what actually happened to it, because those are different facts
 * and the finance register tells them apart:
 *   • nothing ever arrived  → `cancelled`. The hire never happened, so it is not hire spend.
 *   • something arrived and is all back → `returned`. It happened; the shortfall is the cancelled qty.
 *   • something arrived and is still here → stays `on_hire`. The kit still has to go back, and the
 *     normal return path closes it — which now works, because `fullyReceived` is true from here.
 *
 * Mirrors customer.service.ts `closeAssignmentShort`, down to the required reason: this write is the
 * only record that the shortfall was a decision rather than an oversight.
 */
export async function closeHireShort(
  poId: string,
  lineId: string,
  input: CloseHireShortInput,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  const line = await loadRentalLine(po.id, lineId);
  if (isTerminalHireStatus(line.hireStatus)) throw conflict("That hire is already finished.");
  // Nothing outstanding means nothing to close short — the hire either ran as ordered or is already
  // being closed by the return path. Refusing keeps `cancelledQuantity` meaning what it says instead
  // of letting a no-op stamp a reason onto a line that was never short.
  const outstanding = line.quantity - (line.receivedQuantity ?? 0);
  if (outstanding <= 0) {
    throw conflict(
      `All ${line.quantity} ${line.itemName} have been delivered — there is nothing outstanding to close short.`,
    );
  }

  const received = line.receivedQuantity ?? 0;
  const returned = line.returnedQuantity ?? 0;
  const stillHeld = received - returned;
  const now = new Date();
  const actorEmail = actor?.email ?? null;

  // GUARDED on the quantity the shortfall was computed from. A delivery landing between the read
  // above and this write would leave `cancelledQuantity` describing a line that no longer exists —
  // `received + cancelled` would stop adding up to `ordered`, silently. Same contract the hire-note
  // writes use; whoever loses the race gets an instruction rather than a wrong number.
  // BOTH quantities, because both decide this write. `receivedQuantity` gives the shortfall;
  // `returnedQuantity` chooses the outcome — a return landing in the window turns "still holding kit,
  // stay on hire" into "everything is back, close it", and pinning only the first lets the stale
  // branch win. That leaves the line `on_hire` with received === returned and `fullyReceived` true:
  // the return path refuses it (nothing still out), mark-returned refuses it (collection records),
  // and the board hides Close short (`fullyReceived`) — the exact dead-end this endpoint removes.
  const applied = await poRepo.updateRentalLineIf(lineId, { receivedQuantity: received, returnedQuantity: returned }, {
    cancelledQuantity: outstanding,
    shortClosedAt: now,
    shortClosedBy: actorEmail,
    shortCloseReason: input.reason,
    // Nothing more is expected — which is the question the receiving queue actually asks. See the
    // field's note in schema.prisma.
    fullyReceived: true,
    ...(received === 0
      ? // Never arrived: terminal, and NOT "returned" — there is nothing to have returned, and the
        // finished-hire register would otherwise report a hire that never happened as hire spend.
        { hireStatus: "cancelled", returnedAt: now, returnedBy: actorEmail, fullyReturned: true }
      : stillHeld === 0
        ? // Everything that arrived is already back, and nothing more is coming: the hire is over.
          // `createRentalReturn` could not close it before because `fullyReceived` was false.
          { hireStatus: "returned", returnedAt: now, returnedBy: actorEmail, fullyReturned: true }
        : // Kit still in our hands. It has to go back, and the return path closes the line when it
          // does — no state change here beyond taking the undelivered units off the intake queue.
          {}),
  });
  if (!applied) {
    throw conflict(
      "Someone recorded another movement on this hire a moment ago. Reload and check what is outstanding before closing it short.",
    );
  }

  // The order's own status moves with it: those units are no longer outstanding, so an order whose
  // only shortfall was this one is now fully accounted for. Without this the status catches up only
  // when some UNRELATED movement happens to run the recompute — or never, which is the ordinary case
  // for the last hire on an order.
  await recomputeRentalReceiptStatus(po.id, actor);
  emitHireUpdated(po.id, po.code);
  audit.record({
    actor,
    action: "purchase_order.rental_closed_short",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    // The shortfall and the reason are the two things anyone asking "where did the rest go?" needs,
    // and `changes[]` is what the order's own Audit Trail tab renders.
    metadata: {
      item: line.itemName,
      cancelledQuantity: outstanding,
      reason: input.reason,
      changes: [
        {
          label:
            `${line.itemName}: ${outstanding} of ${line.quantity} closed short ` +
            `(${received} received${stillHeld > 0 ? `, ${stillHeld} still to come back` : ""}) — ${input.reason}`,
        },
      ],
    },
  });
  return getPurchaseOrder(po.id, actor);
}

/**
 * Extend a hire by moving its end date.
 *
 * Not a new record and not a new status — the same line, later. The write recomputes `notifyOnDate`
 * and clears the whole notification state, so the NEW deadline earns its own reminder rather than
 * inheriting "already told them" from the old one.
 */
export async function extendHire(
  poId: string,
  lineId: string,
  input: ExtendHireInput,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  const line = await loadRentalLine(po.id, lineId);
  if (line.hireStatus === "returned") throw conflict("That hire has been returned and can no longer be extended.");
  // A hire nothing ever arrived against has no period left to extend — extending it would re-arm a
  // reminder for equipment that is never coming.
  if (line.hireStatus === "cancelled") throw conflict("That hire was cancelled and can no longer be extended.");

  // A calendar day like every other hire date, so a time-of-day cannot shift the reminder by a
  // fraction of a day or slip past the "after the start date" check.
  const hireEndDate = toCalendarDay(input.hireEndDate);
  if (hireEndDate.getTime() <= line.hireStartDate.getTime()) {
    throw badRequest("The hire end date must be after the start date.");
  }
  // An extension moves the end date FORWARD. Every consumer of this write assumes that and none of
  // them survives the opposite: the register stores `addedDays` as a plain difference and renders it
  // as `+{addedDays}d` (a shortening reads "+-27d"), extensionChargePence clamps the difference to
  // zero so the move is silently free, and the reminder is re-armed for a deadline that may already
  // have passed. The Extend dialog sets `min={hireEndDate}` on the date input, but that is a hint to
  // the picker rather than a rule — a stale tab, devtools or any direct API call ignores it — so the
  // rule has to live here. Correcting an end date backwards is a different operation from extending,
  // and this codebase does not model it (see extensionChargePence: "shortening is not a credit note").
  if (hireEndDate.getTime() <= line.hireEndDate.getTime()) {
    throw badRequest("The new hire end date must be after the current end date.");
  }
  const notifyDaysBefore = input.notifyDaysBefore ?? line.notifyDaysBefore;

  // What the extension costs, on the rate the hire was struck at. The whole hire is repriced and the
  // old price subtracted — see extensionChargePence for why the added days are never priced alone.
  const calculatedChargePence = extensionChargePence(
    line.ratePeriod as RatePeriod,
    line.ratePence,
    line.hireStartDate,
    line.hireEndDate,
    hireEndDate,
  );
  // The AGREED figure wins when one is sent: a supplier may price the extra days differently, and on
  // the `total` basis there is no rate to calculate from at all. Per unit, like every other price
  // here, so the quantity multiplies it exactly as it does the hire itself.
  const agreedChargePence = input.additionalChargePence ?? calculatedChargePence ?? 0;

  // The LINE total for this one extension — what is added to the running total, and therefore what
  // the breakdown row has to carry for the two to add up.
  const lineChargePence = agreedChargePence * line.quantity;

  // The line and the record of what moved it, in one transaction. Recording each extension as a fact
  // of its own is the only way "how much extension did we agree in July" can be answered: the running
  // total below is a SUM, and a sum carries no dates — three extensions of £275, £300 and £150 read
  // as £725 and nothing more.
  await poRepo.extendRentalLine(
    lineId,
    {
      hireEndDate,
      notifyDaysBefore,
      notifyOnDate: computeNotifyOnDate(line.hireStartDate, hireEndDate, notifyDaysBefore),
      // Accumulated BESIDE the committed money, never inside it — the order's totals stay the amount
      // the supplier agreed to. See the field's note in schema.prisma.
      extensionChargePence: line.extensionChargePence + lineChargePence,
      deadlineNotifiedAt: null,
      deadlineNotifyClaimToken: null,
      deadlineNotifyClaimExpires: null,
      deadlineNotifyAttempts: 0,
    },
    {
      purchaseOrderRentalLineId: line.id,
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierName: po.supplierName,
      itemName: line.itemName,
      previousEndDate: line.hireEndDate,
      newEndDate: hireEndDate,
      addedDays: daysBetween(line.hireEndDate, hireEndDate),
      chargePence: lineChargePence,
      calculatedChargePence,
      priceOverridden: input.additionalChargePence != null && input.additionalChargePence !== calculatedChargePence,
      quantity: line.quantity,
      ratePeriod: line.ratePeriod,
      ratePence: line.ratePence,
      createdBy: actor?.email ?? null,
    },
    // The engineer holding this kit is working to the OLD date until this runs. In the same
    // transaction, so the deadline on the order and the deadline in the van can never disagree.
    (tx) => rentalCustodyRepo.refreshHoldingDeadlinesForHireTx(tx, line.id, hireEndDate).then(() => undefined),
  );
  emitHireUpdated(po.id, po.code);
  audit.record({
    actor,
    action: "purchase_order.rental_extended",
    targetType: "purchase_order",
    targetId: po.id,
    targetLabel: po.code,
    metadata: {
      item: line.itemName,
      from: line.hireEndDate.toISOString(),
      to: hireEndDate.toISOString(),
      // BOTH figures, so a negotiated extension shows what the rate said and what was agreed —
      // the same pairing the line's own price keeps.
      calculatedAdditionalChargePence: calculatedChargePence,
      agreedAdditionalChargePence: agreedChargePence,
      priceOverridden: input.additionalChargePence != null && input.additionalChargePence !== calculatedChargePence,
      ratePeriod: line.ratePeriod,
      ratePence: line.ratePence,
      quantity: line.quantity,
      // `changes[]` is what the purchase order's own Audit Trail tab renders (auditDisplay's
      // changeLabels). Without it this entry shows as a bare "Rental Extended" with the dates and
      // the money visible only in the global audit log's raw-JSON drawer — which is not where anyone
      // looking at this order would think to check.
      changes: [
        {
          label:
            `${line.itemName}: hire end ${line.hireEndDate.toISOString().slice(0, 10)} → ` +
            `${hireEndDate.toISOString().slice(0, 10)}` +
            (agreedChargePence > 0
              ? ` · additional ${poundsLabel(agreedChargePence * line.quantity)}` +
                (calculatedChargePence != null && calculatedChargePence !== agreedChargePence
                  ? ` (rate calculates ${poundsLabel(calculatedChargePence * line.quantity)})`
                  : "")
              : " · no additional charge"),
        },
      ],
    },
  });
  return getPurchaseOrder(po.id, actor);
}

export interface PublicOnHireLine {
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
  daysRemaining: number;
  notifyOnDate: string;
  /**
   * Which deadline window this hire is in, decided HERE.
   *
   * The client used to re-derive it, which meant a second implementation of the rule and a "today"
   * taken from the browser rather than the company timezone — so a row could be coloured for a
   * state the badge disagreed with. One answer, computed where the badges are computed.
   */
  window: "ok" | "expiring" | "overdue";
  deliveryAddress: string | null;
  /** The basis an extension prices from — the Extend dialog previews the charge from these. */
  ratePeriod: string;
  ratePence: number | null;
  priceOverridden: boolean;
  /** Cumulative extension charges on this hire. NOT part of the order's totals. */
  extensionCharge: number;
  /** Ordered vs actually arrived — a part delivery is ordinary, and the row has to show it. */
  receivedQuantity: number;
  fullyReceived: boolean;
  /** Ordered units recorded as never arriving, and why — the row shows "2 of 5 · 3 cancelled". */
  cancelledQuantity: number;
  shortCloseReason: string | null;
  /** What has gone back, and whether everything we hold has — the row's Return action caps on these. */
  returnedQuantity: number;
  fullyReturned: boolean;
  /** Reported damaged while with us. The warehouse's rental pane filters on it. */
  damagedQuantity: number;
  /**
   * What this hire COSTS: the agreed price for one unit and for the whole line, in pounds.
   *
   * The same numbers the order committed — carried onto the row rather than left on the purchase
   * order, because the unit a hire is reported in is the LINE (one item, one period, one price) and
   * a report that has to open every order to price its rows is not a report.
   *
   * `extensionCharge` above sits beside them and is deliberately NOT added in: it is money agreed
   * after the order was sent and is not part of its totals. A reader adding the two columns is doing
   * it knowingly; a single pre-summed column would hide which half is which.
   */
  unitPrice: number;
  lineTotal: number;
  /**
   * When the equipment actually MOVED, off its own movement notes — first delivery, last collection.
   *
   * Not `receivedAt` / `returnedAt`: those are stamped when somebody typed the record in, and the
   * note carries the day the kit changed hands. A supplier invoices from the second one.
   */
  deliveredOn: string | null;
  collectedOn: string | null;
  /**
   * Days actually held, on the same convention as `hireDays` — the collection day is not charged.
   * Null until the loop is closed at both ends; there is no honest number before that.
   *
   * Against `hireDays` this is the one comparison a hire is reviewed on: billed 70, held 62.
   */
  daysOnHire: number | null;
  /**
   * What the supplier is charging us for damage to this hire, in pounds, across its live damage
   * reports and returns.
   *
   * NULL, not 0, when no figure is on file — a hire with damaged units and no charge yet is waiting
   * on a quote, and calling that zero is how it stops being chased. Beside `lineTotal` and
   * `extensionCharge` rather than added into either: the three are committed money, money agreed
   * later, and money we owe for breaking something, and a report that folds them together can answer
   * none of the questions asked of them.
   */
  damageCharge: number | null;
  /** Where it GOES — the line's own address, the order's override, or the warehouse. */
  deliveryLocation: { label: string; address: string | null };
  /** Where it is collected from — resolved by the same function the order document prints. */
  returnLocation: { label: string; address: string | null };
  hireStatus: string;
}

/**
 * The hire's physical window, and the length of it, from its first and last movement.
 *
 * `daysOnHire` is measured the way `billableDays` measures a hire: the collection day is the day it
 * goes back and is not a day held. Null unless BOTH ends are known — a hire still out has no length
 * yet, and 0 would read as "held for no time" on a row that is currently out.
 */
function hireWindow(m: receiptRepo.HireMovementDates | undefined): {
  deliveredOn: string | null;
  collectedOn: string | null;
  daysOnHire: number | null;
  damageCharge: number | null;
} {
  const deliveredOn = m?.deliveredOn ?? null;
  const collectedOn = m?.collectedOn ?? null;
  return {
    deliveredOn: deliveredOn?.toISOString() ?? null,
    collectedOn: collectedOn?.toISOString() ?? null,
    // Clamped at 0: a collection dated before the delivery is bad data entry, not a negative hire.
    daysOnHire: deliveredOn && collectedOn ? Math.max(0, daysBetween(deliveredOn, collectedOn)) : null,
    // Null when nothing has been quoted — see the field's own note. `pounds()` would turn that into
    // 0, which is the one answer this number must never give.
    damageCharge: m?.damageChargePence == null ? null : pounds(m.damageChargePence),
  };
}

/** One context for both legs of an on-hire row — see poReturnCtx for the same job on a full order. */
function onHireCtx(r: {
  returnMode: string;
  returnAddress: string | null;
  deliveryAddress: string | null;
  // The narrow shape the on-hire query actually selects — `addressBlock`'s own parameter, so this
  // never drifts from what it can format.
  purchaseOrder: {
    deliveryAddress: string | null;
    warehouse: (Parameters<typeof addressBlock>[0] & { name: string }) | null | undefined;
  };
}): ReturnContext {
  return {
    returnMode: r.returnMode,
    returnAddress: r.returnAddress,
    deliveryAddress: r.deliveryAddress,
    orderDeliveryAddress: r.purchaseOrder.deliveryAddress,
    warehouseName: r.purchaseOrder.warehouse?.name ?? null,
    warehouseAddress: addressBlock(r.purchaseOrder.warehouse),
  };
}

/**
 * The live hires, for the rentals module's On hire tab.
 *
 * Its `status` filter resolves through the SAME predicates the attention badges count, so a badge
 * reading 3 opens exactly those 3 rows. Two copies of "expiring" is how a count and its list drift
 * apart — the failure the attention registry already documents for `?status=rework`.
 */
export async function listOnHire(
  params: {
    status?: string;
    page?: number;
    pageSize?: number;
    warehouseId?: string;
    rentalItemId?: string;
    search?: string;
    /**
     * Raises the 200-row page cap for a SERVER-INITIATED read — only the CSV export sets it.
     * Not reachable from the wire: the controller builds these params field by field out of
     * `req.query` and never copies this one, so a client cannot ask for an unbounded page.
     * See EXPORT_PAGING in utils/csv.ts, and `paginate`'s `maxPageSize` for the same argument.
     */
    maxPageSize?: number;
  },
  // Company-wide, deliberately: a hire is chased by the PM on the order, not by whoever holds the
  // warehouse it was delivered to. The actor is taken so the signature matches every other list
  // and a future scope rule has somewhere to land.
  _actor?: AuditActor,
): Promise<{ rows: PublicOnHireLine[]; total: number; page: number; pageSize: number }> {
  // Checked against the repository's own list rather than a hand-written chain: a status the filter
  // resolves but this line forgets is silently downgraded to "all", opening every live hire under a
  // badge that counted a handful.
  const status: poRepo.OnHireStatus = (poRepo.ON_HIRE_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as poRepo.OnHireStatus)
    : "all";
  const page = Math.max(1, params.page ?? 1);
  // 200 is the ceiling for anything a CLIENT can ask for; only a server-initiated read may lift it,
  // and only by passing maxPageSize. Without that escape hatch the CSV export asked for 50,000 rows,
  // was silently clamped to 200, and then measured its own `capped` flag against that clamped length
  // — reporting a 200-row file as the complete register. Same failure `paginate(maxPageSize)` exists
  // to prevent; this list cannot use `paginate` itself because the repository returns `total`
  // alongside the rows rather than counting first.
  const pageSize = Math.min(params.maxPageSize ?? 200, Math.max(1, params.pageSize ?? 20));
  const todayStart = startOfDayIn(await getCompanyTimezone(), new Date());

  const { rows, total } = await poRepo.listOnHire({
    status,
    todayStart,
    page,
    pageSize,
    warehouseId: params.warehouseId,
    // Ignored unless it looks like an id — a stray query string must narrow to nothing recognisable
    // rather than being handed to Prisma, which answers a malformed ObjectId with a 500.
    rentalItemId: /^[a-f0-9]{24}$/i.test(params.rentalItemId ?? "") ? params.rentalItemId : undefined,
    // A box holding only spaces is not a filter — it would narrow the list to nothing while the
    // screen showed an empty-looking search.
    search: params.search?.trim() ? params.search.trim() : undefined,
  });
  // The physical window of every row on this page, in ONE batched query — see movementDatesByHireLine
  // for why the notes are the source and the hire line's own timestamps are not. Read through the
  // rental-receipt REPOSITORY rather than its service: that module's service imports this one, and a
  // service-to-service edge here would close the cycle.
  const moved = await receiptRepo.movementDatesByHireLine(rows.map((r) => r.id));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      purchaseOrderId: r.purchaseOrder.id,
      purchaseOrderCode: r.purchaseOrder.code,
      supplierName: r.purchaseOrder.supplierName,
      rentalItemId: r.rentalItemId,
      rentalItemCode: r.rentalItem?.code ?? null,
      itemName: r.itemName,
      quantity: r.quantity,
      hireStartDate: r.hireStartDate.toISOString(),
      hireEndDate: r.hireEndDate.toISOString(),
      hireDays: daysBetween(r.hireStartDate, r.hireEndDate),
      // Negative once the hire has run out — the on-hire row's "3 days left" / "2 days over".
      daysRemaining: daysBetween(todayStart, r.hireEndDate),
      fullyReceived: r.fullyReceived ?? false,
      cancelledQuantity: r.cancelledQuantity ?? 0,
      shortCloseReason: r.shortCloseReason,
      returnedQuantity: r.returnedQuantity ?? 0,
      fullyReturned: r.fullyReturned ?? false,
      damagedQuantity: r.damagedQuantity ?? 0,
      notifyOnDate: r.notifyOnDate.toISOString(),
      window:
        r.hireEndDate.getTime() < todayStart.getTime()
          ? "overdue"
          : r.notifyOnDate.getTime() <= todayStart.getTime()
            ? "expiring"
            : "ok",
      deliveryAddress: r.deliveryAddress,
      ratePeriod: r.ratePeriod,
      ratePence: r.ratePence,
      priceOverridden: r.priceOverridden,
      // What extending this hire has added so far. Shown on the row that offers the Extend button,
      // so the running commitment is visible where it is created.
      extensionCharge: pounds(r.extensionChargePence),
      // Whoever books the hire back in needs BOTH ends of the trip — the same answers the supplier
      // reads on the order. `deliveryAddress` above is only the line's own text: a hire on an order
      // that overrides its delivery address showed an empty Delivery column while going somewhere
      // definite, so the resolved leg travels alongside it.
      receivedQuantity: r.receivedQuantity ?? 0,
      deliveryLocation: resolveDeliveryLocation(onHireCtx(r)),
      returnLocation: resolveReturnLocation(onHireCtx(r)),
      hireStatus: r.hireStatus,
      unitPrice: pounds(r.unitPricePence),
      lineTotal: pounds(r.lineTotalPence),
      ...hireWindow(moved.get(r.id)),
    })),
    total,
    page,
    pageSize,
  };
}

// ── The extension register ────────────────────────────────────────────────────────────────────
//
// Every extension agreed in a period, one row each. `extensionChargePence` on the hire line is the
// SUM of these and answers only "how much, in total, on this hire" — it carries no dates, so the
// question a finance period actually asks ("what extension did we agree in July") had no answer at
// all. The audit log holds each event, but an activity trail cannot be filtered, joined to a hire and
// totalled; that is what a register is.

export interface PublicHireExtension {
  id: string;
  purchaseOrderId: string;
  purchaseOrderCode: string | null;
  supplierName: string | null;
  itemName: string;
  previousEndDate: string;
  newEndDate: string;
  addedDays: number;
  /** The LINE charge for this one extension, in pounds — per unit x quantity. */
  charge: number;
  /** What the hire's own rate priced it at, when there was a rate. Null on the `total` basis. */
  calculatedCharge: number | null;
  priceOverridden: boolean;
  quantity: number;
  ratePeriod: string | null;
  ratePence: number | null;
  agreedBy: string | null;
  agreedAt: string;
}

export interface ListHireExtensionsParams {
  search?: string;
  purchaseOrder?: string;
  /** Inclusive calendar days on when the extension was AGREED. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  maxPageSize?: number;
}

function toPublicExtension(e: {
  id: string;
  purchaseOrderId: string;
  poCode: string | null;
  supplierName: string | null;
  itemName: string;
  previousEndDate: Date;
  newEndDate: Date;
  addedDays: number;
  chargePence: number;
  calculatedChargePence: number | null;
  priceOverridden: boolean;
  quantity: number;
  ratePeriod: string | null;
  ratePence: number | null;
  createdBy: string | null;
  createdAt: Date;
}): PublicHireExtension {
  return {
    id: e.id,
    purchaseOrderId: e.purchaseOrderId,
    purchaseOrderCode: e.poCode,
    supplierName: e.supplierName,
    itemName: e.itemName,
    previousEndDate: e.previousEndDate.toISOString(),
    newEndDate: e.newEndDate.toISOString(),
    addedDays: e.addedDays,
    charge: pounds(e.chargePence),
    calculatedCharge: e.calculatedChargePence == null ? null : pounds(e.calculatedChargePence),
    priceOverridden: e.priceOverridden,
    quantity: e.quantity,
    ratePeriod: e.ratePeriod,
    ratePence: e.ratePence,
    agreedBy: e.createdBy,
    agreedAt: e.createdAt.toISOString(),
  };
}

/**
 * Every extension, filtered as a period.
 *
 * Company-wide, exactly like the on-hire list beside it and for the same reason: a hire is chased —
 * and extended — by the PM on the order, not by whoever holds the warehouse it was delivered to.
 * The `actor` is taken so the signature matches every other list and a future scope rule has
 * somewhere to land.
 */
export async function listHireExtensions(
  params: ListHireExtensionsParams = {},
  _actor?: AuditActor,
): Promise<{ extensions: PublicHireExtension[]; total: number; page: number; pageSize: number; totalPages: number; totalCharge: number }> {
  const filters = {
    search: params.search,
    purchaseOrderId: params.purchaseOrder,
    // The SHARED widening rule (utils/filter-date), which every other date-range filter in the app
    // uses — including the audit log, whose `createdAt` is a timestamp exactly like `agreedAt` here.
    // The "end" edge widens to 23:59:59.999, which is what stops a To date from dropping every
    // extension agreed after midnight on the last day of the period — i.e. all of them.
    dateFrom: parseFilterDate(params.from, "start"),
    dateTo: parseFilterDate(params.to, "end"),
  };
  const total = await poRepo.countExtensions(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await poRepo.findManyExtensions(filters, skip, pageSize);
  return {
    extensions: rows.map(toPublicExtension),
    total,
    page,
    pageSize,
    totalPages,
    // What this PAGE adds up to. Deliberately the page and not the whole filtered set: a period total
    // is what the export is for, and a figure quietly summing rows the reader cannot see is the kind
    // of number that gets copied into a report.
    totalCharge: pounds(rows.reduce((sum, e) => sum + e.chargePence, 0)),
  };
}

/** The same filtered extensions as a file — the period report the running total cannot produce. */
export async function exportHireExtensionsCsv(
  params: ListHireExtensionsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for, so without
  // it an export stops at one page AND reports itself complete.
  const { extensions } = await listHireExtensions({ ...params, ...EXPORT_PAGING }, actor);
  const rows = extensions.slice(0, EXPORT_MAX);
  const regional = await getRegionalSettings();
  // The hire dates are calendar days stored as UTC midnight; `agreedAt` is a real timestamp and is
  // shown in the company timezone, which the column names so a reader is never left guessing.
  const day = (isoDate: string) => formatDate(new Date(isoDate), regional.dateFormat, "UTC");

  const csv = toCsv(
    [
      `Agreed (${regional.timezone})`, "Agreed By", "Purchase Order", "Supplier", "Item",
      "Quantity", "Previous End", "New End", "Days Added",
      "Rate", "Rate Basis", "Calculated Charge", "Agreed Charge", "Negotiated",
    ],
    rows.map((e) => [
      formatDate(new Date(e.agreedAt), regional.dateFormat, regional.timezone),
      e.agreedBy,
      e.purchaseOrderCode,
      e.supplierName,
      e.itemName,
      e.quantity,
      day(e.previousEndDate),
      day(e.newEndDate),
      e.addedDays,
      // Blank, not 0.00: a hire priced as a lump sum has no per-period rate, and a zero would average
      // into a rate report as a free extension.
      e.ratePence == null ? "" : (e.ratePence / 100).toFixed(2),
      e.ratePence == null ? "" : e.ratePeriod,
      // BOTH figures, so a negotiated extension shows what the rate said and what was actually
      // agreed — the same pairing the hire's own price keeps. The gap between them is the discount.
      e.calculatedCharge == null ? "" : e.calculatedCharge.toFixed(2),
      e.charge.toFixed(2),
      e.priceOverridden ? "yes" : "",
    ]),
  );

  audit.record({ actor, action: "rental_hire.exported", targetType: "purchase_order", targetLabel: `${rows.length} extensions` });
  return { csv, capped: extensions.length > EXPORT_MAX };
}

/**
 * The live hires, as a file.
 *
 * Same predicate the badges count and the tab lists, so a download taken from a filtered view holds
 * exactly the rows that view showed.
 */
export async function exportOnHireCsv(
  params: { status?: string; search?: string },
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  const regional = await getRegionalSettings();
  // EXPORT_PAGING, not a bare pageSize: listOnHire caps a page at 200 for anything a client asks for,
  // so without the maxPageSize this spreads, the export stopped at 200 rows AND reported itself
  // complete. The same object every other export in the repo hands to its list function.
  const { rows, total } = await listOnHire({ ...params, ...EXPORT_PAGING }, actor);
  // UTC on the hire dates: a calendar day stored as UTC midnight shifts a day in any zone behind it.
  const day = (iso: string) => formatDate(new Date(iso), regional.dateFormat, "UTC");
  const csv = toCsv(
    [
      "Purchase Order", "Supplier", "Item Code", "Item", "Quantity",
      "Hire From", "Hire Until", "Hire Days", "Days Remaining",
      `Reminder Due (${regional.timezone})`, "Delivery Address", "Collected From", "Hire Status",
      // ── What the hire COST and what actually happened ──────────────────────────────────────
      // The columns a period report is built from, and the reason the `returned` filter exists at
      // all: with the file above alone, "what did we spend on hire in July" could not be asked.
      // Appended rather than interleaved so an existing saved spreadsheet keeps its column order.
      "Rate", "Rate Basis", "Unit Price", "Line Total", "Extension Charge",
      "Delivered", "Collected", "Days On Hire",
      "Received Qty", "Returned Qty", "Damaged Qty", "Damage Charge",
      // `Cancelled Qty` and its reason close the same hole the on-hire row's badge does: a line
      // ordering 5, receiving 2 and sitting off the receiving queue reads as broken arithmetic until
      // the file says the other three were written off, and why. A period report reconciled against a
      // supplier's invoice needs that more than the screen does.
      //
      // APPENDED, not slotted in beside `Received Qty` where it reads better — same rule the block
      // above follows. A column inserted mid-file shifts every one after it, and the spreadsheets
      // this export feeds reference cells by position.
      "Cancelled Qty", "Short Close Reason",
    ],
    rows.map((r) => [
      r.purchaseOrderCode,
      r.supplierName,
      r.rentalItemCode,
      r.itemName,
      r.quantity,
      day(r.hireStartDate),
      day(r.hireEndDate),
      r.hireDays,
      // BLANK on a hire that is already back. Both of these are computed against TODAY, and on a
      // finished hire that is a countdown to a deadline nobody is waiting for any more: a returned
      // row arriving as "Days Remaining -1" reads as overdue, which is the one thing it is not. The
      // live rows they exist for are unaffected.
      isTerminalHireStatus(r.hireStatus) ? "" : r.daysRemaining,
      isTerminalHireStatus(r.hireStatus) ? "" : day(r.notifyOnDate),
      // The RESOLVED outbound leg, matching the screen: the line's own text was empty on every hire
      // going to its delivery warehouse, which reads as "nowhere" in a spreadsheet.
      r.deliveryLocation.address?.replace(/\r?\n/g, ", ") ?? "",
      r.returnLocation.address?.replace(/\r?\n/g, ", ") ?? "",
      r.hireStatus,
      // Money as a plain decimal, never the pence integer — this file is summed in a spreadsheet.
      // A rate of nothing is BLANK, not 0.00: a hire priced as a total has no per-period rate, and
      // a zero there would average into a rate report as a free hire.
      r.ratePence == null ? "" : (r.ratePence / 100).toFixed(2),
      r.ratePence == null ? "" : r.ratePeriod,
      r.unitPrice.toFixed(2),
      r.lineTotal.toFixed(2),
      // Beside the line total, never folded into it: an extension is money agreed after the order
      // was sent, and it is not part of the order's committed value.
      r.extensionCharge.toFixed(2),
      // Blank while the hire is still out — an empty cell is a fact, 0 days is a claim.
      r.deliveredOn ? day(r.deliveredOn) : "",
      r.collectedOn ? day(r.collectedOn) : "",
      r.daysOnHire ?? "",
      // Billed against held: ordered vs arrived vs gone back, plus what came back broken.
      r.receivedQuantity,
      r.returnedQuantity,
      r.damagedQuantity,
      // Blank while nothing is quoted. A hire with damaged units and an empty cell here is the row
      // somebody has to chase — 0.00 would close that question without anyone deciding to.
      r.damageCharge == null ? "" : r.damageCharge.toFixed(2),
      // Written off, and why. `Quantity` minus `Received Qty` minus `Cancelled Qty` is zero on every
      // finished hire, which is the check a reconciler runs down the column. Newlines flattened like
      // every other free-text cell — a raw one would split the row in the spreadsheet.
      r.cancelledQuantity,
      r.shortCloseReason?.replace(/\r?\n/g, " ") ?? "",
    ]),
  );
  audit.record({ actor, action: "rental_hire.exported", targetType: "purchase_order", targetLabel: `${rows.length} hires` });
  return { csv, capped: total > rows.length };
}
