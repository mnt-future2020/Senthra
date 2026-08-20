import type { Prisma } from "@prisma/client";

import * as prfRepo from "./purchase-request.repository.js";
import type { PrfLineRow, PurchaseRequestWithRelations } from "./purchase-request.repository.js";
import * as prfEmail from "./purchase-request.email.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import { daysBetween } from "../../utils/calendar-day.js";
import { computeNotifyOnDate } from "#modules/purchase-order/rentalHire.predicate.js";
import { resolveDeliveryLocation, resolveReturnLocation, type ReturnContext } from "#modules/purchase-order/rentalReturn.js";
import { calculateUnitPricePence, type RatePeriod } from "../../utils/rental-pricing.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as rentalItemService from "#modules/rental-item/rental-item.service.js";
// Safe one-way edge: inventory.service reaches back only to purchase-request.REPOSITORY (never this
// service), so consuming its live reorder suggestions here cannot create an import cycle.
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { publicLateHireDelivery } from "../../utils/hire-delivery.js";
import { withTransaction } from "../../lib/prisma.js";
import {
  emitAttentionChanged,
  emitToRoom,
  PURCHASE_ORDER_WATCHERS_ROOM,
  PURCHASE_REQUEST_WATCHERS_ROOM,
} from "../../lib/realtime.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { diffProcurementChanges } from "../../utils/procurement-diff.js";
import type {
  CreatePurchaseRequestInput,
  GenerateReorderInput,
  PrfLineInput,
  PrfRentalLineInput,
  UpdatePurchaseRequestInput,
} from "./purchase-request.validation.js";
import { incotermLabel } from "#modules/purchase-order/purchase-order.validation.js";
import { PRF_ATTACHMENT_MAX_COUNT, PRF_ATTACHMENT_MAX_TOTAL_BYTES } from "./purchase-request.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Status state machine (forward-only; backend-enforced). Two sanctioned reverse edges:
// submitted → draft (Reject for rework) and approved → draft (Reopen for revision — the
// price-revision workflow; an approved PRF is NEVER edited in place). `converted` is terminal
// and READ-ONLY forever: re-procurement goes through cancel-the-PO + Duplicate-as-revision. ──
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = Reject (rework)
  approved: ["converted", "draft", "cancelled"], // → draft = Reopen (revision); → converted via Generate PO
  converted: [],
  cancelled: [],
};
const humanStatus = (s: string) => s.replace(/_/g, " ");
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${humanStatus(from)} purchase request to ${humanStatus(to)}.`);
  }
}

// ── DTO ────────────────────────────────────────────────────────────────────────────────────
export interface PublicPrfSupplier {
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
export interface PublicPrfWarehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
}
export interface PublicPrfJob {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
}
export interface PublicPrfItem {
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
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string } | null;
}
export interface PublicPrfRentalLine {
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
  ratePeriod: string;
  ratePence: number | null;
  priceOverridden: boolean;
  returnMode: string;
  returnAddress: string | null;
  /** BOTH legs of the round trip, resolved once here — see rentalReturn.ts. */
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
export interface PublicPrfAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}
export interface PublicPurchaseRequest {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string | null;
  supplier: PublicPrfSupplier | null;
  warehouseId: string;
  warehouse: PublicPrfWarehouse | null;
  jobId: string | null;
  job: PublicPrfJob | null;
  projectRef: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  quoteReference: string | null;
  quoteDate: string | null;
  quoteValidUntil: string | null;
  requiredByDate: string | null;
  // Set when the required-by date falls AFTER one of this request's hires has already started —
  // days billed with nothing on site. Derived here, like `hireDays`, so the request screen, the
  // order screen and any export read one answer. A warning, never a block: some hire companies
  // bill from the day the kit leaves their yard.
  lateHireDelivery: { earliestHireStart: string; daysLate: number } | null;
  justification: string | null;
  notes: string | null;
  deliveryTerms: string | null;
  deliveryTermsLabel: string | null;
  paymentTerms: string | null;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  items: PublicPrfItem[];
  rentalItems: PublicPrfRentalLine[];
  attachments: PublicPrfAttachment[];
  // The PO generated from this PRF (at most one), for the linked-PO badge + chain strip.
  purchaseOrder: { id: string; code: string; status: string } | null;
  revisionOfId: string | null;
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  reopenReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  convertedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedPurchaseRequests {
  purchaseRequests: PublicPurchaseRequest[];
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

function warehouseAddress(w: PurchaseRequestWithRelations["warehouse"]): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The facts BOTH legs of a hire's round trip are resolved from — see rentalReturn.ts.
 *
 * Built once per line so the outbound and return chains can never be handed different facts about the
 * same hire. `orderDeliveryAddress` is null by definition here: the "deliver to a different address"
 * override belongs to a purchase order, and a request has no order yet.
 */
function returnCtx(
  prf: PurchaseRequestWithRelations,
  r: PurchaseRequestWithRelations["rentalItems"][number],
): ReturnContext {
  return {
    returnMode: r.returnMode,
    returnAddress: r.returnAddress,
    deliveryAddress: r.deliveryAddress,
    orderDeliveryAddress: null,
    warehouseName: prf.warehouse?.name ?? null,
    warehouseAddress: warehouseAddress(prf.warehouse),
  };
}

function toPublic(prf: PurchaseRequestWithRelations): PublicPurchaseRequest {
  const s = prf.supplier;
  const paymentTerms = s ? (s.paymentTerms === "Custom" ? s.customPaymentTerms : s.paymentTerms) : null;
  const linkedPo = prf.purchaseOrders[0] ?? null;
  return {
    id: prf.id,
    code: prf.code,
    supplierId: prf.supplierId,
    supplierName: prf.supplierName,
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
    warehouseId: prf.warehouseId,
    warehouse: prf.warehouse
      ? { id: prf.warehouse.id, code: prf.warehouse.code, name: prf.warehouse.name, address: warehouseAddress(prf.warehouse) }
      : null,
    jobId: prf.jobId,
    job: prf.job ? { id: prf.job.id, jobNumber: prf.job.jobNumber, name: prf.job.name, status: prf.job.status } : null,
    projectRef: prf.projectRef,
    sourceType: prf.sourceType,
    sourceId: prf.sourceId,
    status: prf.status ?? "draft",
    quoteReference: prf.quoteReference,
    quoteDate: iso(prf.quoteDate),
    quoteValidUntil: iso(prf.quoteValidUntil),
    requiredByDate: iso(prf.requiredByDate),
    lateHireDelivery: publicLateHireDelivery(prf.requiredByDate, prf.rentalItems),
    justification: prf.justification,
    notes: prf.notes,
    deliveryTerms: prf.deliveryTerms,
    deliveryTermsLabel: prf.deliveryTerms ? incotermLabel(prf.deliveryTerms) : null,
    paymentTerms: prf.paymentTerms,
    currency: prf.currency ?? "GBP",
    subtotalPence: prf.subtotalPence,
    vatPence: prf.vatPence,
    grandTotalPence: prf.grandTotalPence,
    subtotal: pounds(prf.subtotalPence),
    vatTotal: pounds(prf.vatPence),
    grandTotal: pounds(prf.grandTotalPence),
    items: prf.items.map((i) => ({
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
      notes: i.notes,
      irmItem: i.irmItem ? { id: i.irmItem.id, code: i.irmItem.code, name: i.irmItem.name, status: i.irmItem.status } : null,
    })),
    // ONE context for both legs — see rentalReturn.ts. Built here rather than inline twice so the
    // outbound and return chains can never be handed different facts about the same line.
    rentalItems: prf.rentalItems.map((r) => ({
      id: r.id,
      rentalItemId: r.rentalItemId,
      itemName: r.itemName,
      baseUnit: r.baseUnit,
      quantity: r.quantity,
      hireStartDate: r.hireStartDate.toISOString(),
      hireEndDate: r.hireEndDate.toISOString(),
      // Derived here rather than on the client so the PRF screen, the PO screen and any export all
      // read one answer for "how long is this hire".
      hireDays: daysBetween(r.hireStartDate, r.hireEndDate),
      notifyDaysBefore: r.notifyDaysBefore,
      deliveryAddress: r.deliveryAddress,
      ratePeriod: r.ratePeriod,
      ratePence: r.ratePence,
      priceOverridden: r.priceOverridden,
      returnMode: r.returnMode,
      returnAddress: r.returnAddress,
      // BOTH legs of the round trip, resolved server-side so the request screen, the order document
      // and the on-hire list can never name three different places for one hire. A request has no
      // order-level override to fall back to — that only exists once a PO carries the line.
      deliveryLocation: resolveDeliveryLocation(returnCtx(prf, r)),
      returnLocation: resolveReturnLocation(returnCtx(prf, r)),
      unitPricePence: r.unitPricePence,
      unitPrice: pounds(r.unitPricePence),
      vatRate: r.vatRate,
      lineTotalPence: r.lineTotalPence,
      lineTotal: pounds(r.lineTotalPence),
      notes: r.notes,
      rentalItem: r.rentalItem
        ? { id: r.rentalItem.id, code: r.rentalItem.code, name: r.rentalItem.name, status: r.rentalItem.status }
        : null,
    })),
    attachments: prf.attachments.map((a) => ({
      id: a.id,
      label: a.label,
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url: a.url,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    purchaseOrder: linkedPo ? { id: linkedPo.id, code: linkedPo.code, status: linkedPo.status } : null,
    revisionOfId: prf.revisionOfId,
    createdBy: prf.createdBy,
    submittedBy: prf.submittedBy,
    submittedAt: iso(prf.submittedAt),
    approvedBy: prf.approvedBy,
    approvedAt: iso(prf.approvedAt),
    rejectionReason: prf.rejectionReason,
    reopenReason: prf.reopenReason,
    cancelledAt: iso(prf.cancelledAt),
    cancelReason: prf.cancelReason,
    convertedAt: iso(prf.convertedAt),
    updatedBy: prf.updatedBy,
    createdAt: prf.createdAt.toISOString(),
    updatedAt: prf.updatedAt.toISOString(),
  };
}

// ── Financials (server-authoritative, integer pence — identical maths to the PO module) ─────
export function computeTotals(lines: { quantity: number; unitPricePence: number; vatRate: number }[]): prfRepo.PrfTotals {
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPricePence; // ex-VAT
    subtotal += lineTotal;
    vat += Math.round((lineTotal * l.vatRate) / 100);
  }
  return { subtotalPence: subtotal, vatPence: vat, grandTotalPence: subtotal + vat };
}

/**
 * Validate each rental line's item is ACTIVE, snapshot its name/unit, and compute the line total.
 *
 * The dates arrive already normalised to UTC midnight by the validation layer, so nothing here has
 * to think about time-of-day — see utils/calendar-day.ts.
 */
async function buildRentalLineRows(lines: PrfRentalLineInput[]): Promise<prfRepo.PrfRentalLineRow[]> {
  if (lines.length === 0) return [];
  await rentalItemService.requireActiveRentalItems(lines.map((l) => l.rentalItemId));
  // One lookup for the whole set, so the snapshots come from the same read the guard validated.
  const items = await rentalItemService.getRentalItemsByIds(lines.map((l) => l.rentalItemId));
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

// Validate each line's IRM item is ACTIVE, snapshot its name/sku/unit, and compute the line total.
async function buildLineRows(items: PrfLineInput[]): Promise<PrfLineRow[]> {
  // One batched active-item validation for the whole set (not N sequential lookups).
  const itemsById = await irmService.requireActiveIrmItems(items.map((l) => l.irmItemId));
  const rows: PrfLineRow[] = [];
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
async function resolveJobId(jobId: string | null | undefined): Promise<string | null> {
  if (!jobId) return null;
  const job = await jobRepo.findById(jobId);
  if (!job) throw badRequest("Selected job no longer exists.");
  return jobId;
}

export interface ListPurchaseRequestsParams {
  search?: string;
  status?: string;
  statuses?: string[];
  supplier?: string;
  warehouse?: string;
  job?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export async function listPurchaseRequests(params: ListPurchaseRequestsParams = {}, actor?: AuditActor): Promise<PagedPurchaseRequests> {
  const filters = {
    search: params.search,
    status: params.status,
    statuses: params.statuses,
    supplierId: params.supplier,
    warehouseId: params.warehouse,
    jobId: params.job,
    warehouseIds: warehouseScopeFilter(actor),
  };
  const total = await prfRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await prfRepo.findMany(filters, skip, pageSize, params.sort);
  return { purchaseRequests: rows.map(toPublic), total, page, pageSize, totalPages };
}

/**
 * The SAME filtered list as a CSV, minus paging — "everything matching what I'm looking at".
 *
 * Delegates to listPurchaseRequests with one oversized page rather than re-deriving the filters:
 * the warehouse scope lives in there, and an export whose scope drifts from the list's is the one
 * bug in a report nobody spots — the file looks perfectly normal either way.
 */
export async function exportPurchaseRequestsCsv(
  params: ListPurchaseRequestsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  const { purchaseRequests } = await listPurchaseRequests({ ...params, ...EXPORT_PAGING }, actor);
  const rows = purchaseRequests.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const date = (v: string | null) => formatDate(v, regional.dateFormat, regional.timezone);
  const csv = toCsv(
    [
      "PRF Number", "Status", "Supplier", "Warehouse", "Job", "Project Ref",
      "Quote Reference", `Quote Date (${regional.timezone})`, `Required By (${regional.timezone})`,
      "Lines", "Currency", "Subtotal", "VAT", "Grand Total",
      "Purchase Order", "Submitted By", `Submitted (${regional.timezone})`, "Approved By", `Approved (${regional.timezone})`,
    ],
    rows.map((prf) => [
      prf.code,
      prf.status,
      prf.supplier?.name ?? prf.supplierName,
      prf.warehouse?.name,
      prf.job?.jobNumber,
      prf.projectRef,
      prf.quoteReference,
      date(prf.quoteDate),
      date(prf.requiredByDate),
      prf.items.length,
      prf.currency,
      // Decimals, never the pence integers — this file is summed in a spreadsheet, where 222 under
      // a "Subtotal" heading reports a £2.20 request as £222.
      prf.subtotal.toFixed(2),
      prf.vatTotal.toFixed(2),
      prf.grandTotal.toFixed(2),
      // The PO this request became, so a spend reconciliation can follow the pair across two files.
      prf.purchaseOrder?.code,
      prf.submittedBy,
      date(prf.submittedAt),
      prf.approvedBy,
      date(prf.approvedAt),
    ]),
  );

  // Audit the deliberate extraction, like the inventory and PO exports — a download of the
  // company's committed spend is an event worth being able to point at later.
  audit.record({ actor, action: "purchase_request.exported", targetType: "purchase_request", targetLabel: `${rows.length} rows` });
  return { csv, capped: purchaseRequests.length > EXPORT_MAX };
}

/**
 * The same filtered requests, ONE ROW PER LINE — what was ASKED for, item by item.
 *
 * Its value is the pair with the PO line export: both carry the item and the PO code, so the two
 * files join in a spreadsheet and answer "what did we request versus what did we actually order,
 * and at what price". Neither header export can be joined that way — the item is not in them.
 */
export async function exportPurchaseRequestLinesCsv(
  params: ListPurchaseRequestsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  const { purchaseRequests } = await listPurchaseRequests({ ...params, ...EXPORT_PAGING }, actor);
  const prfs = purchaseRequests.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const date = (v: string | null) => formatDate(v, regional.dateFormat, regional.timezone);
  // Header cells shared by both kinds of line, so an IRM row and a hire row line up column-for-column.
  const headerCells = (prf: PublicPurchaseRequest) => [
    prf.code,
    prf.status,
    prf.supplier?.name ?? prf.supplierName,
    prf.warehouse?.name,
    prf.job?.jobNumber,
    date(prf.requiredByDate),
    // The PO this request became — the join key to the PO line export.
    prf.purchaseOrder?.code,
  ];
  // BOTH kinds. Exporting `items` alone gave a hire-only request ZERO rows — it vanished from its
  // own export while still appearing in the list that offered the download.
  const all = prfs.flatMap((prf) => [
    ...prf.items.map((i) => [
      ...headerCells(prf),
      "Item",
      i.itemName,
      i.sku,
      i.baseUnit,
      i.quantity,
      "",
      "",
      i.unitPrice.toFixed(2),
      i.vatRate,
      i.lineTotal.toFixed(2),
      prf.currency,
    ]),
    ...prf.rentalItems.map((r) => [
      ...headerCells(prf),
      "Rental",
      r.itemName,
      "",
      r.baseUnit,
      r.quantity,
      // UTC: a hire date is a calendar day stored as UTC midnight.
      formatDate(r.hireStartDate, regional.dateFormat, "UTC"),
      formatDate(r.hireEndDate, regional.dateFormat, "UTC"),
      r.unitPrice.toFixed(2),
      r.vatRate,
      r.lineTotal.toFixed(2),
      prf.currency,
    ]),
  ]);
  // Capped on LINES, not requests: one request can carry hundreds.
  const rows = all.slice(0, EXPORT_MAX);

  const csv = toCsv(
    [
      "PRF Number", "Status", "Supplier", "Warehouse", "Job",
      `Required By (${regional.timezone})`, "Purchase Order",
      "Line Type", "Item", "SKU", "Unit", "Quantity",
      "Hire From", "Hire Until",
      "Unit Price", "VAT %", "Line Total", "Currency",
    ],
    rows,
  );

  audit.record({ actor, action: "purchase_request.exported", targetType: "purchase_request", targetLabel: `${rows.length} lines` });
  return { csv, capped: purchaseRequests.length > EXPORT_MAX || all.length > EXPORT_MAX };
}

export async function getPurchaseRequest(idOrCode: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = OBJECT_ID_RE.test(idOrCode) ? await prfRepo.findById(idOrCode) : await prfRepo.findByCode(idOrCode);
  if (!prf) throw notFound("Purchase request not found.");
  if (prf.warehouseId) assertWarehouseAccess(actor, prf.warehouseId);
  return toPublic(prf);
}

export async function createPurchaseRequest(input: CreatePurchaseRequestInput, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
  const supplier = await supplierService.requireActiveSupplier(input.supplierId);
  await warehouseService.requireActiveWarehouse(input.warehouseId);
  const jobId = await resolveJobId(input.jobId);
  const lineRows = await buildLineRows(input.items ?? []);
  const rentalRows = await buildRentalLineRows(input.rentalItems ?? []);
  // ONE roll-up over BOTH kinds of line. An IRM-only request totals exactly what it did before.
  const totals = computeTotals([...lineRows, ...rentalRows]);
  const actorLabel = actor?.email ?? null;

  const created = await prfRepo.createWithCode(
    {
      supplierId: input.supplierId,
      supplierName: supplier.name,
      warehouseId: input.warehouseId,
      jobId,
      projectRef: trimToNull(input.projectRef),
      status: "draft",
      quoteReference: trimToNull(input.quoteReference),
      quoteDate: input.quoteDate ? new Date(input.quoteDate) : null,
      quoteValidUntil: input.quoteValidUntil ? new Date(input.quoteValidUntil) : null,
      requiredByDate: new Date(input.requiredByDate), // required by the schema
      justification: trimToNull(input.justification),
      notes: trimToNull(input.notes),
      deliveryTerms: input.deliveryTerms ?? null,
      paymentTerms: trimToNull(input.paymentTerms),
      currency: "GBP",
      ...totals,
      createdBy: actorLabel,
      updatedBy: actorLabel,
    },
    lineRows,
    rentalRows,
  );
  audit.record({ actor, action: "purchase_request.created", targetType: "purchase_request", targetId: created.id, targetLabel: created.code });
  emitPrfUpdated(created);
  return toPublic(created);
}

export async function updatePurchaseRequest(id: string, input: UpdatePurchaseRequestInput, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const existing = await prfRepo.findById(id);
  if (!existing) throw notFound("Purchase request not found.");
  if (existing.warehouseId) assertWarehouseAccess(actor, existing.warehouseId);
  // EDITABLE ONLY IN DRAFT — supplier/warehouse/quantities/prices/header all lock once submitted.
  if (existing.status !== "draft") {
    throw conflict("Only draft purchase requests can be edited. Reject or reopen it back to draft first.");
  }

  const headerPatch: Prisma.PurchaseRequestUncheckedUpdateInput = { updatedBy: actor?.email ?? null };

  if (input.supplierId !== undefined && input.supplierId !== existing.supplierId) {
    const s = await supplierService.requireActiveSupplier(input.supplierId);
    headerPatch.supplierId = input.supplierId;
    headerPatch.supplierName = s.name;
  }
  if (input.warehouseId !== undefined && input.warehouseId !== existing.warehouseId) {
    if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
    await warehouseService.requireActiveWarehouse(input.warehouseId);
    headerPatch.warehouseId = input.warehouseId;
  }
  if (input.jobId !== undefined) headerPatch.jobId = await resolveJobId(input.jobId);
  if (input.projectRef !== undefined) headerPatch.projectRef = trimToNull(input.projectRef);
  if (input.quoteReference !== undefined) headerPatch.quoteReference = trimToNull(input.quoteReference);
  if (input.quoteDate !== undefined) headerPatch.quoteDate = input.quoteDate ? new Date(input.quoteDate) : null;
  if (input.quoteValidUntil !== undefined) headerPatch.quoteValidUntil = input.quoteValidUntil ? new Date(input.quoteValidUntil) : null;
  if (input.requiredByDate !== undefined) headerPatch.requiredByDate = new Date(input.requiredByDate);
  if (input.justification !== undefined) headerPatch.justification = trimToNull(input.justification);
  if (input.notes !== undefined) headerPatch.notes = trimToNull(input.notes);
  if (input.deliveryTerms !== undefined) headerPatch.deliveryTerms = input.deliveryTerms ?? null;
  if (input.paymentTerms !== undefined) headerPatch.paymentTerms = trimToNull(input.paymentTerms);

  let result: PurchaseRequestWithRelations;
  if (input.items !== undefined || input.rentalItems !== undefined) {
    // Either array being sent replaces BOTH, so the header totals are always computed over the
    // complete set. Whichever array the client omitted is re-derived from what is already stored —
    // replacing one kind of line while silently dropping the other is how a rental-only edit would
    // wipe a request's IRM lines.
    const lineRows =
      input.items !== undefined
        ? await buildLineRows(input.items)
        : existing.items.map((l, i) => ({
            irmItemId: l.irmItemId,
            itemName: l.itemName,
            sku: l.sku,
            baseUnit: l.baseUnit,
            quantity: l.quantity,
            unitPricePence: l.unitPricePence,
            vatRate: l.vatRate,
            lineTotalPence: l.lineTotalPence,
            sortOrder: i,
            notes: l.notes,
          }));
    const rentalRows =
      input.rentalItems !== undefined
        ? await buildRentalLineRows(input.rentalItems)
        : existing.rentalItems.map((l, i) => ({
            rentalItemId: l.rentalItemId,
            itemName: l.itemName,
            baseUnit: l.baseUnit,
            quantity: l.quantity,
            hireStartDate: l.hireStartDate,
            hireEndDate: l.hireEndDate,
            notifyDaysBefore: l.notifyDaysBefore,
            deliveryAddress: l.deliveryAddress,
            ratePeriod: l.ratePeriod,
            ratePence: l.ratePence,
            priceOverridden: l.priceOverridden,
            returnMode: l.returnMode,
            returnAddress: l.returnAddress,
            unitPricePence: l.unitPricePence,
            vatRate: l.vatRate,
            lineTotalPence: l.lineTotalPence,
            sortOrder: i,
            notes: l.notes,
          }));
    // A request must still have a line of SOME kind afterwards. This lives here rather than on the
    // schema because only the service can see both the incoming arrays AND the stored ones: sending
    // `items: []` alone is legitimate when the request has rental lines, and a schema refine would
    // either reject that or — as it did — let `{items: [], rentalItems: []}` wipe the request and
    // zero its totals, which the old `.min(1)` on `items` used to prevent.
    if (lineRows.length === 0 && rentalRows.length === 0) {
      throw badRequest("Add at least one item or rental line.");
    }
    const totals = computeTotals([...lineRows, ...rentalRows]);
    result = await prfRepo.replaceItemsAndTotals(id, lineRows, totals, headerPatch, rentalRows);
  } else {
    result = await prfRepo.update(id, headerPatch);
  }
  // Field-level change audit (Zoho/SAP-style): capture the before→after of the commercially-meaningful
  // fields — supplier, warehouse, and each line's qty/price/VAT — so a pre-approval edit is traceable.
  // `result` carries the fully-resolved post-update values; lines only diffed when the update sent them.
  // Rental lines are diffed alongside the IRM ones — a hire's quantity or price changing before
  // approval is exactly the kind of edit this trail exists to record, and leaving them out made
  // every rental change invisible. They are labelled "(hire)" so the entry reads unambiguously and
  // an IRM item sharing a name cannot be mistaken for one.
  const asDiffLines = (
    items: { irmItemId: string; itemName: string; quantity: number; unitPricePence: number; vatRate: number }[],
    rentals: {
      rentalItemId: string;
      itemName: string;
      hireStartDate: Date | string;
      hireEndDate: Date | string;
      deliveryAddress: string | null;
      quantity: number;
      unitPricePence: number;
      vatRate: number;
    }[],
  ) => [
    ...items.map((i) => ({ ...i, lineKey: i.irmItemId })),
    ...rentals.map((r) => ({
      ...r,
      itemName: `${r.itemName} (hire)`,
      // The same composite the compound unique index uses — a rental item may legitimately appear
      // twice with different periods, so its id alone would pair the wrong before with the wrong after.
      lineKey: [r.rentalItemId, String(r.hireStartDate), String(r.hireEndDate), r.deliveryAddress ?? ""].join("|"),
    })),
  ];

  const linesTouched = input.items !== undefined || input.rentalItems !== undefined;
  const changes = diffProcurementChanges(
    { ...existing, items: asDiffLines(existing.items, existing.rentalItems) },
    {
      supplierId: result.supplierId,
      supplierName: result.supplierName,
      warehouseId: result.warehouseId,
      items: linesTouched ? asDiffLines(result.items, result.rentalItems) : undefined,
    },
  );
  audit.record({
    actor,
    action: "purchase_request.updated",
    targetType: "purchase_request",
    targetId: id,
    targetLabel: result.code,
    metadata: changes.length ? { changes } : undefined,
  });
  emitPrfUpdated(result);
  return toPublic(result);
}

// ── Workflow actions (each transition-guarded + stamped + audited) ───────────────────────────
async function loadOrThrow(id: string, actor?: AuditActor): Promise<PurchaseRequestWithRelations> {
  const prf = await prfRepo.findById(id);
  if (!prf) throw notFound("Purchase request not found.");
  if (prf.warehouseId) assertWarehouseAccess(actor, prf.warehouseId);
  return prf;
}
function recordStatus(actor: AuditActor | undefined, id: string, code: string, action: string, metadata?: Record<string, unknown>): void {
  audit.record({ actor, action, targetType: "purchase_request", targetId: id, targetLabel: code, metadata });
}

// Fan a PRF's change out to every watcher so their list/detail live-refreshes. A request passes
// through several hands (raiser → finance approver → procurement, who converts it to a PO), so a
// screen left open on one desk goes stale the moment the next person acts — which is how a user
// ends up clicking "Approve" on a request finance already approved from another session.
//
// The payload is a scope-agnostic REFETCH SIGNAL, not the request itself: each client re-pulls
// through its own warehouse-scoped REST call, so the shared room can never leak a request outside a
// watcher's scope. Fire-and-forget — a realtime failure must never roll back a committed
// transition (emitToRoom already no-ops when realtime is uninitialised, e.g. in unit tests).
function emitPrfUpdated(prf: { id: string; code: string; status: string }): void {
  emitToRoom(PURCHASE_REQUEST_WATCHERS_ROOM, "purchase_request:updated", {
    id: prf.id,
    code: prf.code,
    status: prf.status,
  });
  emitAttentionChanged("purchase_requests");
}

export async function submitPurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "submitted");
  // A line of EITHER kind. A rental-only request is legitimate — checking `items` alone made every
  // hire-only request unsubmittable, which no create-time validation would have caught because the
  // request itself saved cleanly.
  if (prf.items.length === 0 && prf.rentalItems.length === 0) {
    throw badRequest("Add at least one item or rental line before submitting.");
  }
  const updated = await prfRepo.update(id, { status: "submitted", submittedBy: actor?.email ?? null, submittedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_request.submitted");
  emitPrfUpdated(updated);
  // Fire-and-forget: notify the finance reviewers a PRF awaits their decision. NEVER blocks.
  void prfEmail.notifyReviewersPrfSubmitted(updated, actor?.email ?? null).catch((e) =>
    console.error(`PRF ${updated.code} review notification failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function approvePurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "approved");
  const updated = await prfRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_request.approved");
  emitPrfUpdated(updated);
  void prfEmail.notifyRequesterPrfDecision(updated, "approved").catch((e) =>
    console.error(`PRF ${updated.code} approval email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function rejectPurchaseRequest(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "submitted") {
    throw conflict(`Only a submitted purchase request can be rejected (this one is ${humanStatus(prf.status)}).`);
  }
  // Clear any prior reopenReason so the detail page never shows a stale reason from an earlier cycle.
  const updated = await prfRepo.update(id, { status: "draft", rejectionReason: reason.trim(), reopenReason: null });
  recordStatus(actor, id, updated.code, "purchase_request.rejected", { reason: reason.trim() });
  emitPrfUpdated(updated);
  void prfEmail.notifyRequesterPrfDecision(updated, "rejected", reason).catch((e) =>
    console.error(`PRF ${updated.code} rejection email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

// Reopen-for-revision: the ONLY way an approved PRF changes (price-revision workflow). Clears the
// approval stamps and drops back to draft with the reason on record — the full review runs again.
export async function reopenPurchaseRequest(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "approved") {
    throw conflict(`Only a finance-approved purchase request can be reopened for revision (this one is ${humanStatus(prf.status)}).`);
  }
  const updated = await prfRepo.update(id, {
    status: "draft",
    approvedBy: null,
    approvedAt: null,
    reopenReason: reason.trim(),
    // Clear any prior rejectionReason so the two reason fields never show a contradictory pair.
    rejectionReason: null,
    updatedBy: actor?.email ?? null,
  });
  recordStatus(actor, id, updated.code, "purchase_request.reopened", { reason: reason.trim() });
  emitPrfUpdated(updated);
  return toPublic(updated);
}

export async function cancelPurchaseRequest(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "cancelled");
  const cancelReason = trimToNull(reason);
  const updated = await prfRepo.update(id, { status: "cancelled", cancelledAt: new Date(), cancelReason });
  // Carry the reason into the audit metadata (parity with reject + the PO cancel audit).
  recordStatus(actor, id, updated.code, "purchase_request.cancelled", { reason: cancelReason ?? undefined });
  emitPrfUpdated(updated);
  return toPublic(updated);
}

export async function deletePurchaseRequest(id: string, actor?: AuditActor): Promise<void> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "draft") throw conflict("Only draft purchase requests can be deleted.");
  await prfRepo.softDelete(id);
  audit.record({ actor, action: "purchase_request.deleted", targetType: "purchase_request", targetId: id, targetLabel: prf.code });
  // Same refetch signal as a status change: a watcher's list re-pulls and the row simply disappears.
  // `deleted` is not a real PRF status — it is only a hint; clients act on the refetch, not the value.
  emitPrfUpdated({ id, code: prf.code, status: "deleted" });
}

// ── Convert: generate the Purchase Order from a finance-approved PRF ─────────────────────────
// ONE PO per PRF, forever. The whole conversion is a single all-or-nothing transaction: the PRF's
// approved status is re-checked INSIDE the transaction (a concurrent second convert sees
// `converted` and fails), the PO code is allocated in-tx (rollback reclaims the number), the
// lines are copied VERBATIM from the reviewed PRF (finance approved THOSE snapshots + prices —
// nothing is re-snapshotted), the quotation attachments are copied onto the PO (same Cloudinary
// URLs), and the PRF flips to `converted` (read-only forever). The PO lands in `draft` so Finance
// can complete delivery address/terms; the commercial-equality fast-path in the PO service then
// lets it go draft → approved without a second review — unless it diverged.
// Mirrors `datesOk` in purchase-order.validation.ts, which guards every MANUAL PO path: expected
// delivery can't precede the order date. DATE-ONLY, matching that refine (and the confirmed-date
// rule in the PO service) — converting on the very day the goods are due is legitimate, so
// comparing raw timestamps would wrongly reject a same-day conversion because of the time of day.
const dayStart = (d: Date) => Date.parse(d.toISOString().slice(0, 10));
const datesOk = (orderDate: Date, expectedDeliveryDate: Date) =>
  dayStart(expectedDeliveryDate) >= dayStart(orderDate);

export interface ConvertResult {
  purchaseRequest: PublicPurchaseRequest;
  purchaseOrderId: string;
  purchaseOrderCode: string;
}

/**
 * The money a rental line is stored with.
 *
 * On a rate basis it is the arithmetic — computed here so the figure filed can never disagree with
 * the rate filed beside it. An OVERRIDDEN line keeps what was sent: a supplier-negotiated price is
 * a commercial fact, not a calculation, and the rate is still recorded so the difference is visible.
 */
function agreedUnitPricePence(line: {
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

export async function convertPurchaseRequest(id: string, actor?: AuditActor): Promise<ConvertResult> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "converted"); // clear pre-check (the tx re-checks authoritatively)
  // Fail before allocating a PO code (the tx re-checks authoritatively). See the notes there.
  if (!prf.requiredByDate) {
    throw conflict("This purchase request has no required-by date. Add one before converting it to a purchase order.");
  }
  if (!datesOk(new Date(), prf.requiredByDate)) {
    throw conflict(
      "This purchase request's required-by date has passed. Reopen it and set a new date before converting it to a purchase order.",
    );
  }
  const supplier = await supplierService.requireActiveSupplier(prf.supplierId);
  await warehouseService.requireActiveWarehouse(prf.warehouseId);
  // Every line's item must still be active — a PO must never be issued for a retired item.
  await irmService.requireActiveIrmItems(prf.items.map((l) => l.irmItemId));
  await rentalItemService.requireActiveRentalItems(prf.rentalItems.map((l) => l.rentalItemId));

  const actorLabel = actor?.email ?? null;
  const internalParts: string[] = [];
  if (prf.justification) internalParts.push(`PRF ${prf.code} justification: ${prf.justification}`);
  if (prf.notes) internalParts.push(`PRF ${prf.code} notes: ${prf.notes}`);

  let poId = "";
  let poCode = "";
  let attempt = 0;
  for (; attempt < 5; attempt++) {
    await poRepo.ensurePoCounter();
    try {
      await withTransaction(async (tx) => {
        const live = await prfRepo.findForConvertTx(tx, id);
        if (!live) throw notFound("Purchase request not found.");
        if (live.status !== "approved") {
          throw conflict(`This purchase request is ${humanStatus(live.status)} and can no longer be converted.`);
        }
        // The PO's expected delivery date is the date the REQUESTER asked for. Deliberately NOT
        // derived from the supplier's lead time: a computed date looks like a commitment nobody
        // made, and would sit on screen contradicting the date the supplier later confirms.
        //
        // Required on new PRFs, but nullable in the schema — anything raised before the field
        // existed still has none. Refuse rather than mint a dateless PO, which would be blocked at
        // approval with nothing explaining why. Editing the draft PRF to add the date clears this.
        const orderDate = new Date();
        const expectedDeliveryDate = live.requiredByDate;
        if (!expectedDeliveryDate) {
          throw conflict("This purchase request has no required-by date. Add one before converting it to a purchase order.");
        }
        // The required-by date was captured when the PRF was RAISED; approval is a human step, so
        // it can easily have gone stale by the time procurement converts. Every manual PO path
        // enforces expectedDeliveryDate >= orderDate (`datesOk` in purchase-order.validation.ts);
        // this path builds the row directly and would otherwise be the one way to mint a PO whose
        // delivery date precedes its own order date — which the submit/approve/send gates then
        // treat as trustworthy and the issued PDF prints. Refuse and make them re-date the PRF
        // rather than silently shipping a date the supplier can no longer meet.
        if (!datesOk(orderDate, expectedDeliveryDate)) {
          throw conflict(
            "This purchase request's required-by date has passed. Reopen it and set a new date before converting it to a purchase order.",
          );
        }
        poCode = await poRepo.allocatePoCodeTx(tx);
        const lines = live.items.map((l, i) => ({
          irmItemId: l.irmItemId,
          itemName: l.itemName,
          sku: l.sku,
          baseUnit: l.baseUnit,
          quantity: l.quantity,
          unitPricePence: l.unitPricePence,
          vatRate: l.vatRate,
          lineTotalPence: l.lineTotalPence,
          sortOrder: i,
          notes: l.notes,
        }));
        // The COMPLETE rental line, not just the id — the PO is the record the supplier reads and
        // the deadline alert counts, so a partial copy would leave the hire without its period or
        // its price. notifyOnDate is recomputed rather than copied because the PRF has no such
        // column: the alert is a PO-side concept (a PRF that never converted hired nothing).
        const rentalLines = live.rentalItems.map((l, i) => ({
          rentalItemId: l.rentalItemId,
          itemName: l.itemName,
          baseUnit: l.baseUnit,
          quantity: l.quantity,
          hireStartDate: l.hireStartDate,
          hireEndDate: l.hireEndDate,
          notifyDaysBefore: l.notifyDaysBefore,
          deliveryAddress: l.deliveryAddress,
          ratePeriod: l.ratePeriod,
          ratePence: l.ratePence,
          priceOverridden: l.priceOverridden,
          returnMode: l.returnMode,
          returnAddress: l.returnAddress,
          unitPricePence: l.unitPricePence,
          vatRate: l.vatRate,
          lineTotalPence: l.lineTotalPence,
          sortOrder: i,
          notes: l.notes,
          // Committed, NOT delivered. The warehouse confirms arrival (POST .../receive), and only
          // then does the hire start counting towards any return deadline.
          hireStatus: "awaiting_delivery",
          notifyOnDate: computeNotifyOnDate(l.hireStartDate, l.hireEndDate, l.notifyDaysBefore),
        }));
        poId = await poRepo.createPoTx(
          tx,
          {
            supplierId: live.supplierId,
            supplierName: supplier.name,
            warehouseId: live.warehouseId,
            purchaseRequestId: live.id,
            jobId: live.jobId,
            projectRef: live.projectRef,
            status: "draft",
            priority: "normal",
            referenceNumber: live.quoteReference,
            orderDate,
            expectedDeliveryDate,
            currency: "GBP",
            // BOTH kinds of line. Computing this from `lines` alone made a hire-only order total
            // ZERO — the figure an approver signs off and the supplier reads — while its own PRF
            // showed the real number.
            ...computeTotals([...lines, ...rentalLines]),
            // Carry the commercial terms captured on the PRF onto the PO. Payment term falls back
            // to the supplier's standing default when the PRF left it blank.
            deliveryTerms: live.deliveryTerms,
            paymentTerms:
              live.paymentTerms ??
              (supplier.paymentTerms === "Custom" ? (supplier.customPaymentTerms ?? null) : (supplier.paymentTerms ?? null)),
            internalNotes: internalParts.length ? internalParts.join("\n\n") : null,
            createdBy: actorLabel,
            updatedBy: actorLabel,
          },
          poCode,
          lines,
          // The PO's attachment rows point at the SAME Cloudinary files — nothing is re-uploaded.
          // So the identity is copied verbatim, never re-derived from the URL: two rows naming one
          // asset is what lets either be removed without destroying a file the other still shows.
          //
          // This list is hand-written against a generated Prisma input type, so a new column is
          // OPTIONAL and omitting it here compiles cleanly and silently. The guard against that is
          // "carries every attachment field the PRF row holds onto the PO row", in
          // purchase-request.service.test.ts.
          live.attachments.map((a) => ({
            label: a.label,
            fileName: a.fileName,
            fileType: a.fileType,
            fileSizeBytes: a.fileSizeBytes,
            url: a.url,
            publicId: a.publicId,
            resourceType: a.resourceType,
            uploadedBy: a.uploadedBy,
          })),
          rentalLines,
        );
        await prfRepo.setConvertedTx(tx, id, actorLabel);
      });
      break;
    } catch (e) {
      if (poRepo.isPoCodeConflict(e)) {
        await poRepo.fastForwardPoCounter();
        continue;
      }
      if (poRepo.isPoWriteConflict(e)) continue; // transient — retry the whole transaction
      throw e;
    }
  }
  // Exhausted retries — could be repeated code collisions OR transient Mongo write-conflicts under
  // contention. Use a message that covers both so support isn't sent down a code-collision-only path.
  if (attempt >= 5) throw conflict("Couldn't generate the purchase order due to high contention. Please try again.");

  recordStatus(actor, id, prf.code, "purchase_request.converted", { purchaseOrderId: poId, purchaseOrderCode: poCode });
  audit.record({
    actor,
    action: "purchase_order.created",
    targetType: "purchase_order",
    targetId: poId,
    targetLabel: poCode,
    metadata: { purchaseRequestId: id, purchaseRequestCode: prf.code },
  });
  const fresh = await prfRepo.findById(id);
  // Conversion is the one action that touches BOTH surfaces: the PRF becomes `converted` and a
  // brand-new PO appears. Notify each room so an open PRF detail AND an open PO list both refresh.
  emitPrfUpdated({ id, code: prf.code, status: fresh?.status ?? "converted" });
  emitToRoom(PURCHASE_ORDER_WATCHERS_ROOM, "purchase_order:updated", { id: poId, code: poCode, status: "draft" });
  return { purchaseRequest: toPublic(fresh ?? prf), purchaseOrderId: poId, purchaseOrderCode: poCode };
}

// ── Duplicate-as-revision (price-revision workflow, post-conversion) ─────────────────────────
// A converted PRF is read-only forever, and one-PO-per-PRF always holds. When the supplier
// revises a quote after conversion: cancel the PO (existing flow), then duplicate — a prefilled
// DRAFT copy linked via revisionOfId that goes through the full review cycle again.
export async function duplicatePurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const original = await loadOrThrow(id, actor);
  if (original.status !== "converted") {
    throw conflict("Only a converted purchase request can be duplicated as a revision — edit or resubmit a pre-conversion one instead.");
  }
  const supplier = await supplierService.requireActiveSupplier(original.supplierId);
  await warehouseService.requireActiveWarehouse(original.warehouseId);
  await irmService.requireActiveIrmItems(original.items.map((l) => l.irmItemId));
  await rentalItemService.requireActiveRentalItems(original.rentalItems.map((l) => l.rentalItemId));
  const actorLabel = actor?.email ?? null;

  const created = await prfRepo.createWithCode(
    {
      supplierId: original.supplierId,
      supplierName: supplier.name,
      warehouseId: original.warehouseId,
      jobId: original.jobId,
      projectRef: original.projectRef,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      status: "draft",
      quoteReference: original.quoteReference,
      quoteDate: original.quoteDate,
      quoteValidUntil: original.quoteValidUntil,
      requiredByDate: original.requiredByDate,
      justification: original.justification,
      notes: original.notes,
      deliveryTerms: original.deliveryTerms,
      paymentTerms: original.paymentTerms,
      currency: "GBP",
      subtotalPence: original.subtotalPence,
      vatPence: original.vatPence,
      grandTotalPence: original.grandTotalPence,
      revisionOfId: original.id,
      createdBy: actorLabel,
      updatedBy: actorLabel,
    },
    original.items.map((l, i) => ({
      irmItemId: l.irmItemId,
      itemName: l.itemName,
      sku: l.sku,
      baseUnit: l.baseUnit,
      quantity: l.quantity,
      unitPricePence: l.unitPricePence,
      vatRate: l.vatRate,
      lineTotalPence: l.lineTotalPence,
      sortOrder: i,
      notes: l.notes,
    })),
    // The rental lines travel too. The header's totals are copied verbatim above, so dropping these
    // would mint a revision whose grand total does not match the lines it shows — and a hire-only
    // request would duplicate into an empty one carrying a price.
    original.rentalItems.map((l, i) => ({
      rentalItemId: l.rentalItemId,
      itemName: l.itemName,
      baseUnit: l.baseUnit,
      quantity: l.quantity,
      hireStartDate: l.hireStartDate,
      hireEndDate: l.hireEndDate,
      notifyDaysBefore: l.notifyDaysBefore,
      deliveryAddress: l.deliveryAddress,
      ratePeriod: l.ratePeriod,
      ratePence: l.ratePence,
      priceOverridden: l.priceOverridden,
      returnMode: l.returnMode,
      returnAddress: l.returnAddress,
      unitPricePence: l.unitPricePence,
      vatRate: l.vatRate,
      lineTotalPence: l.lineTotalPence,
      sortOrder: i,
      notes: l.notes,
    })),
  );
  audit.record({
    actor,
    action: "purchase_request.created",
    targetType: "purchase_request",
    targetId: created.id,
    targetLabel: created.code,
    metadata: { revisionOf: original.code },
  });
  // A duplicate is a brand-new draft PRF — a watcher's board must show it like any other create.
  emitPrfUpdated(created);
  return toPublic(created);
}

// ── Reorder-workbench generation (draft PRFs, grouped supplier × warehouse) ──────────────────
export interface ReorderGeneratedPrf {
  id: string;
  code: string;
  supplierName: string;
  warehouseName: string;
  lineCount: number;
  totalPence: number;
}
export interface ReorderSkippedRow {
  irmItemId: string;
  itemName: string;
  warehouseName: string;
  reason: string;
}
export interface ReorderAdjustedRow {
  irmItemId: string;
  itemName: string;
  warehouseName: string;
  requestedQty: number;
  finalQty: number;
}
export interface GenerateReorderResult {
  created: ReorderGeneratedPrf[];
  skipped: ReorderSkippedRow[];
  adjusted: ReorderAdjustedRow[];
}

// Serialises the read-then-create window below. The revalidation only prevents a double-buy if a
// concurrent caller's draft PRFs ALREADY EXIST when we recompute — two operators pressing Generate
// at the same moment would otherwise both read the pre-PRF position and both raise a request for the
// same need. Chaining every call makes the recompute-then-create sequence atomic.
//
// Scope: this is an in-process lock, which closes the window for the single always-on server this
// deploys to — not across horizontally-scaled instances. Cross-instance would need a DB-level lock.
// The blast radius is bounded either way: these are DRAFTS entering the normal submit → approve →
// convert pipeline, so an approver still sees a duplicate before any money is committed.
let reorderGenerateChain: Promise<void> = Promise.resolve();
function withReorderGenerateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = reorderGenerateChain.then(fn);
  // The chain itself must never reject, or one failed generate would poison every later caller.
  reorderGenerateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Turn confirmed workbench rows into DRAFT PRFs — one per supplier × warehouse — that flow through
// the EXISTING submit → approve → convert pipeline (no parallel workflow). Before creating anything
// the LIVE suggestions are recomputed with the same maths + actor scoping as the workbench read:
//   • a selected row that no longer triggers is SKIPPED with a reason (stock moved, a GRN landed, or
//     a concurrent user just generated — their open draft PRFs are part of the netting, and the lock
//     above is what guarantees those drafts are visible to this recompute);
//   • a quantity above the live need is CAPPED and reported in `adjusted` (never silently changed).
// Prices prefill from IrmItem.standardCostPence (an estimate — the draft stays fully editable);
// required-by defaults to today + the group's longest primary-supplier lead time (fallback 14 days).
export function generateReorderPrfs(input: GenerateReorderInput, actor?: AuditActor): Promise<GenerateReorderResult> {
  return withReorderGenerateLock(() => runGenerateReorderPrfs(input, actor));
}

async function runGenerateReorderPrfs(input: GenerateReorderInput, actor?: AuditActor): Promise<GenerateReorderResult> {
  const { suggestions } = await inventoryService.getReorderSuggestions(actor);
  // Only ACTIONABLE rows are orderable. "Covered" rows (physically low but already covered by the
  // on-order pipeline) carry suggestedQty 0 — exclude them so a stray covered row is treated as "no
  // longer requires reordering" (skipped) rather than generating a zero-qty line.
  const liveByKey = new Map(suggestions.filter((s) => !s.covered).map((s) => [`${s.irmItemId}|${s.warehouseId}`, s]));

  type LiveSuggestion = (typeof suggestions)[number];
  type Survivor = { supplierId: string; warehouseId: string; irmItemId: string; quantity: number; live: LiveSuggestion };
  const skipped: ReorderSkippedRow[] = [];
  const adjusted: ReorderAdjustedRow[] = [];
  const survivors: Survivor[] = [];

  for (const row of input.rows) {
    assertWarehouseAccess(actor, row.warehouseId);
    const live = liveByKey.get(`${row.irmItemId}|${row.warehouseId}`);
    if (!live) {
      skipped.push({
        irmItemId: row.irmItemId,
        itemName: row.itemName?.trim() || "Item",
        warehouseName: row.warehouseName?.trim() || "warehouse",
        reason: "No longer requires reordering — stock or open requests changed since the list was calculated.",
      });
      continue;
    }
    const quantity = Math.min(row.quantity, live.suggestedQty);
    if (quantity !== row.quantity) {
      adjusted.push({
        irmItemId: row.irmItemId,
        itemName: live.itemName,
        warehouseName: live.warehouseName,
        requestedQty: row.quantity,
        finalQty: quantity,
      });
    }
    survivors.push({ supplierId: row.supplierId, warehouseId: row.warehouseId, irmItemId: row.irmItemId, quantity, live });
  }

  // One draft PRF per supplier × warehouse (a PRF carries exactly one warehouse, matching the PO rule).
  const groups = new Map<string, Survivor[]>();
  for (const s of survivors) {
    const key = `${s.supplierId}|${s.warehouseId}`;
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }

  // Validate every group's supplier + warehouse BEFORE creating anything, so a supplier/warehouse that
  // went inactive between the workbench read and now skips just its own group with a reason — rather
  // than aborting the batch after some draft PRFs were already committed (partial state).
  const plans: { group: Survivor[]; supplierName: string }[] = [];
  for (const group of groups.values()) {
    const { supplierId, warehouseId } = group[0];
    try {
      const supplier = await supplierService.requireActiveSupplier(supplierId);
      await warehouseService.requireActiveWarehouse(warehouseId);
      plans.push({ group, supplierName: supplier.name });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Supplier or warehouse is no longer available.";
      for (const s of group) {
        skipped.push({ irmItemId: s.irmItemId, itemName: s.live.itemName, warehouseName: s.live.warehouseName, reason });
      }
    }
  }

  const created: ReorderGeneratedPrf[] = [];
  const actorLabel = actor?.email ?? null;
  for (const { group, supplierName } of plans) {
    const { supplierId, warehouseId } = group[0];
    const lineRows = await buildLineRows(
      group.map((s) => ({ irmItemId: s.irmItemId, quantity: s.quantity, unitPricePence: s.live.unitCostPence })),
    );
    const totals = computeTotals(lineRows);

    const leads = group
      .map((s) => s.live.primarySupplier?.leadTimeDays)
      .filter((n): n is number => n != null && n > 0);
    const leadDays = leads.length > 0 ? Math.max(...leads) : 14;
    const requiredByDate = input.requiredByDate ? new Date(input.requiredByDate) : new Date(Date.now() + leadDays * 86_400_000);

    const prf = await prfRepo.createWithCode(
      {
        supplierId,
        supplierName,
        warehouseId,
        sourceType: "reorder", // provenance: raised by the Reorder workbench (system-owned, never client-set)
        status: "draft",
        requiredByDate,
        justification: "Raised from the Reorder workbench (stock at or below reorder level).",
        currency: "GBP",
        ...totals,
        createdBy: actorLabel,
        updatedBy: actorLabel,
      },
      lineRows,
    );
    audit.record({
      actor,
      action: "purchase_request.created",
      targetType: "purchase_request",
      targetId: prf.id,
      targetLabel: prf.code,
      metadata: { source: "reorder" },
    });
    emitPrfUpdated(prf);
    created.push({
      id: prf.id,
      code: prf.code,
      supplierName,
      warehouseName: group[0].live.warehouseName,
      lineCount: lineRows.length,
      totalPence: totals.grandTotalPence,
    });
  }

  return { created, skipped, adjusted };
}

// ── Attachments (draft-only — a PRF is editable ONLY in draft, attachments included) ─────────
function assertEditable(status: string): void {
  if (status !== "draft") {
    throw conflict("Attachments can only be changed on a draft purchase request.");
  }
}

/**
 * May this request take one more document of this size?
 *
 * Split out because the answer is needed at TWO moments once the browser uploads straight to
 * Cloudinary: before the file is sent, so a full request fails the user in a second rather than after
 * a 10 MB upload; and again at attachment time, which is the answer that counts — the request can gain
 * documents, or leave draft, while a file is in flight.
 */
export async function assertCanAttach(prfId: string, fileSizeBytes: number, actor?: AuditActor): Promise<void> {
  const prf = await loadOrThrow(prfId, actor);
  assertEditable(prf.status);
  if (prf.attachments.length >= PRF_ATTACHMENT_MAX_COUNT) {
    throw badRequest(`A purchase request can have at most ${PRF_ATTACHMENT_MAX_COUNT} documents.`);
  }
  const totalBytes = prf.attachments.reduce((sum, a) => sum + a.fileSizeBytes, 0);
  if (totalBytes + fileSizeBytes > PRF_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw badRequest("Total documents on a purchase request can't exceed 40 MB.");
  }
}

/** One already-stored asset, recorded against this request. */
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
 * Record an asset that is ALREADY in storage.
 *
 * The single place a PRF attachment row is written. Both entry points end here — the older path that
 * uploads through this server, and the direct-upload finalize that hands over an asset the browser
 * sent to Cloudinary itself — so the guards, the audit event and the DTO are written once and cannot
 * drift between them.
 *
 * `tx` is passed by finalize, which needs this write and the removal of its pending-upload row to
 * commit together.
 */
export async function attachUploadedAsset(
  prfId: string,
  input: AttachAssetInput,
  actor?: AuditActor,
  tx?: Prisma.TransactionClient,
): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(prfId, actor);
  await assertCanAttach(prfId, input.fileSizeBytes, actor);
  await prfRepo.addAttachment(
    {
      purchaseRequestId: prfId,
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
  // Only on the NON-transactional path. `audit.record` is fire-and-forget and writes on the default
  // client, so it does not roll back with `tx` — a transaction that aborts after this line (a write
  // conflict, a failed pending-row delete) would leave an "attachment_added" entry describing an
  // attachment that no longer exists. The transactional caller records it after the commit instead;
  // the event itself is still defined once, in `recordAttachmentAudit` below.
  if (!tx) recordAttachmentAudit(prf, actor);
  return getPurchaseRequest(prfId, actor);
}

/**
 * The attachment-added audit event, in one place.
 *
 * Exported so the direct-upload path can fire it once its transaction has COMMITTED, without
 * restating the action key, target type or label — the drift this module's single-write-point design
 * exists to prevent.
 */
export function recordAttachmentAudit(prf: { id: string; code: string }, actor?: AuditActor): void {
  audit.record({ actor, action: "purchase_request.attachment_added", targetType: "purchase_request", targetId: prf.id, targetLabel: prf.code });
}

export async function removeAttachment(prfId: string, attachmentId: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(prfId, actor);
  assertEditable(prf.status);
  const att = await prfRepo.findAttachment(attachmentId);
  if (!att || att.purchaseRequestId !== prfId) throw notFound("Attachment not found.");
  await prfRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "purchase_request.attachment_removed", targetType: "purchase_request", targetId: prfId, targetLabel: prf.code });

  // ── Cleanup, and the one race releaseAsset's reference count cannot see ──────────────────────
  //
  // INVARIANT: the asset may be destroyed only if the PRF is freshly confirmed still `draft` AFTER
  // the row above was deleted. Anything else — submitted, approved, converted, cancelled, gone —
  // leaves an orphaned file. An orphan costs storage; the alternative loses a document a PO may be
  // displaying.
  //
  // Why a status read guards a Cloudinary delete: converting a PRF copies its attachments' identity
  // onto the new PO's rows rather than re-uploading the files, so one asset ends up named by two
  // rows. releaseAsset counts those references, but its count runs at a single instant, and the
  // conversion runs in a TRANSACTION whose reads are snapshot-based:
  //
  //   removal reads draft ─┐
  //   submit + approve     │  conversion tx snapshot: sees approved AND sees this attachment
  //   THIS delete commits  │  (invisible to that snapshot)
  //   countRefs → 0        │
  //   destroy              │
  //                        └─ conversion COMMITS a PO row naming the file we just destroyed
  //
  // The two never collide on a document, so MongoDB raises no write conflict between them.
  //
  // The re-read closes it. For the conversion to have seen this attachment its snapshot must have
  // read `approved`, which means the approval was already COMMITTED — and therefore visible to this
  // read, which happens later still. So a live conversion that could copy this file always shows up
  // here as a non-draft status. The only way this could report `draft` again is a Reopen
  // (approved → draft), and a Reopen writes the PurchaseRequest document — the same document
  // `setConvertedTx` writes inside the conversion transaction — so it aborts that transaction with a
  // write conflict and rolls its PO attachment rows back with it.
  //
  // That last step is why `setConvertedTx` must stay INSIDE the conversion transaction alongside
  // `createPoTx`. "the conversion writes the PRF in the same transaction as the PO attachments"
  // in purchase-request.service.test.ts pins it.
  const fresh = await prfRepo.findById(prfId);
  if (fresh?.status !== "draft") {
    console.error(
      `[attachment] purchase_request ${prf.code} left draft during removal (now ${fresh?.status ?? "missing"}) — Cloudinary asset ${att.resourceType}/${att.publicId} left in place`,
    );
    return getPurchaseRequest(prfId, actor);
  }
  // Never throws; the attachment is already gone from the PRF whatever Cloudinary does.
  await attachmentService.releaseAsset(att, `purchase_request ${prf.code}`);
  return getPurchaseRequest(prfId, actor);
}
