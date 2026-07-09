import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import * as poRepo from "./purchase-order.repository.js";
import type { PoLineRow, PurchaseOrderWithRelations } from "./purchase-order.repository.js";
import * as poEmail from "./purchase-order.email.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as documentService from "#modules/document/document.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrdersSplitInput,
  POLineInput,
  PoAttachmentInput,
  PoSupplierAcceptInput,
  UpdatePurchaseOrderInput,
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
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${humanStatus(from)} purchase order to ${humanStatus(to)}.`);
  }
}

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

function warehouseAddress(w: PurchaseOrderWithRelations["warehouse"]): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
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
}

export async function listPurchaseOrders(params: ListPurchaseOrdersParams = {}, actor?: AuditActor): Promise<PagedPurchaseOrders> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
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
  };
  const total = await poRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await poRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { purchaseOrders: rows.map(toPublic), total, page, pageSize, totalPages };
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

  // One audit row per resulting PO — each is an independent purchase order.
  for (const po of created) {
    audit.record({ actor, action: "purchase_order.created", targetType: "purchase_order", targetId: po.id, targetLabel: po.code });
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
    const totals = computeTotals(lineRows);
    result = await poRepo.replaceItemsAndTotals(id, lineRows, totals, headerPatch);
  } else {
    result = await poRepo.update(id, headerPatch);
  }
  audit.record({ actor, action: "purchase_order.updated", targetType: "purchase_order", targetId: id, targetLabel: result.code });
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

export async function submitPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "pending_approval");
  if (po.items.length === 0) throw badRequest("Add at least one item before submitting.");
  const updated = await poRepo.update(id, { status: "pending_approval", submittedBy: actor?.email ?? null, submittedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.submitted");
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
    return { purchaseOrder: toPublic(updated), divertedToReview: false };
  }
  assertTransition(po.status, "approved");
  const updated = await poRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.approved");
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
  const url = await uploadFileToCloudinary(dataUri, randomUUID(), creds);
  await poRepo.addAttachment({
    purchaseOrderId: po.id,
    label: ISSUED_PO_ATTACHMENT_LABEL,
    fileName: pdf.filename,
    fileType: "pdf",
    fileSizeBytes: pdf.buffer.length,
    url,
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
  // In pm_review only the ASSIGNED PM may send (that's the whole point of the stage). A holder
  // of assign_pm may override — e.g. the PM is away — and the override is visible in the audit
  // trail because sentBy won't match pmEmail.
  if (po.status === "pm_review") {
    const isAssignedPm = Boolean(actor?.id && po.pmUserId && actor.id === po.pmUserId);
    const canOverride = Boolean(actor?.permissions?.includes("*") || actor?.permissions?.includes("purchase_orders.assign_pm"));
    if (!isAssignedPm && !canOverride) {
      throw forbidden(`Only the assigned project manager (${po.pmName ?? po.pmEmail ?? "unassigned"}) can send this purchase order.`);
    }
  }
  // sentBy is the issuer — the signer printed on the PO document (deterministic for email + download).
  const updated = await poRepo.update(id, { status: "sent", sentAt: new Date(), sentBy: actor?.email ?? null });
  recordStatus(actor, id, updated.code, "purchase_order.sent");
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

// ── Supplier acceptance (sent → supplier_accepted) ────────────────────────────────────────────
// Recorded manually by staff when the supplier confirms by email/phone. The confirmed delivery
// date is OPTIONAL here (suppliers often accept first and schedule later) and is revisable via
// updateConfirmedDeliveryDate — never a status of its own, so receiving is never blocked on it.
export async function recordSupplierAcceptance(
  id: string,
  input: PoSupplierAcceptInput,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "supplier_accepted");
  const confirmed = input.confirmedDeliveryDate ? new Date(input.confirmedDeliveryDate) : null;
  const updated = await poRepo.update(id, {
    status: "supplier_accepted",
    supplierAcceptedAt: input.acceptedDate ? new Date(input.acceptedDate) : new Date(),
    supplierAcceptedBy: actor?.email ?? null,
    supplierAckReference: trimToNull(input.supplierAckReference),
    confirmedDeliveryDate: confirmed,
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
      confirmedDeliveryDate: confirmed ? confirmed.toISOString() : undefined,
    },
  });
  return toPublic(updated);
}

// Revise the confirmed delivery date on an accepted order. The audit metadata carries
// {previousDate, newDate, reason} — the audit ledger IS the revision history (Friday → Monday
// → Wednesday stays fully traceable for disputes); no separate history table.
export async function updateConfirmedDeliveryDate(
  id: string,
  confirmedDeliveryDate: string,
  reason: string | undefined,
  actor?: AuditActor,
): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  if (po.status !== "supplier_accepted") {
    throw conflict("The confirmed delivery date can only be updated after the supplier has accepted the order.");
  }
  const next = new Date(confirmedDeliveryDate);
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
  return toPublic(updated);
}

export async function cancelPurchaseOrder(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "cancelled");
  const updated = await poRepo.update(id, { status: "cancelled", cancelledAt: new Date(), cancelReason: trimToNull(reason) });
  recordStatus(actor, id, updated.code, "purchase_order.cancelled");
  // Fire-and-forget: notify the supplier ONLY if the PO had already been issued to them.
  void poEmail.notifySupplierPoCancelled(updated).catch((e) =>
    console.error(`PO ${updated.code} cancellation email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function closePurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "closed");
  const updated = await poRepo.update(id, { status: "closed", closedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.closed");
  return toPublic(updated);
}

export async function deletePurchaseOrder(id: string, actor?: AuditActor): Promise<void> {
  const po = await loadOrThrow(id, actor);
  if (po.status !== "draft") throw conflict("Only draft purchase orders can be deleted.");
  await poRepo.softDelete(id);
  audit.record({ actor, action: "purchase_order.deleted", targetType: "purchase_order", targetId: id, targetLabel: po.code });
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────
// A PO is immutable once it reaches a terminal state — attachments can't be changed on a
// closed or cancelled order (consistent with the draft-only edit lock on the header/lines).
function assertAttachmentsEditable(status: string): void {
  if (status === "closed" || status === "cancelled") {
    throw conflict("Attachments can't be changed on a closed or cancelled purchase order.");
  }
}

export async function addAttachment(poId: string, input: PoAttachmentInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  assertAttachmentsEditable(po.status);
  // The archive label is system-owned — a user attachment must never masquerade as the
  // document of record.
  if (input.label?.trim() === ISSUED_PO_ATTACHMENT_LABEL) {
    throw badRequest(`"${ISSUED_PO_ATTACHMENT_LABEL}" is a reserved label.`);
  }
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("File uploads aren't configured. Add Cloudinary credentials in Settings first.");
  const url = await uploadFileToCloudinary(input.data, randomUUID(), creds);
  await poRepo.addAttachment({
    purchaseOrderId: poId,
    label: trimToNull(input.label),
    fileName: input.fileName.trim(),
    fileType: input.fileType,
    fileSizeBytes: input.fileSizeBytes,
    url,
    uploadedBy: actor?.email ?? null,
  });
  audit.record({ actor, action: "purchase_order.attachment_added", targetType: "purchase_order", targetId: poId, targetLabel: po.code });
  return getPurchaseOrder(poId, actor);
}

export async function removeAttachment(poId: string, attachmentId: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId, actor);
  assertAttachmentsEditable(po.status);
  const att = await poRepo.findAttachment(attachmentId);
  if (!att || att.purchaseOrderId !== poId) throw notFound("Attachment not found.");
  // The archived issued document is immutable — it IS the record of what the supplier received.
  if (att.label === ISSUED_PO_ATTACHMENT_LABEL && att.uploadedBy === "system") {
    throw conflict("The archived issued PO document can't be removed.");
  }
  await poRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "purchase_order.attachment_removed", targetType: "purchase_order", targetId: poId, targetLabel: po.code });
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
export function recomputeReceiptStatus(items: { quantity: number; receivedQuantity: number }[]): "sent" | "partially_received" | "fully_received" {
  const anyReceived = items.some((i) => i.receivedQuantity > 0);
  const allReceived = items.length > 0 && items.every((i) => i.receivedQuantity >= i.quantity);
  if (allReceived) return "fully_received";
  if (anyReceived) return "partially_received";
  return "sent";
}

// ADDITIVE Goods In seam — called INSIDE the GRN completion transaction. Bumps each PO line's
// receivedQuantity by the physically-received delta, recomputes the received status from ALL
// lines, and advances the PO (sent → partially_received / fully_received) emitting the reserved
// audit verb. Forward-only: receivedQuantity only grows, so recompute never downgrades. No
// existing PO behaviour/field changes — this is the writer the seams above were built for.
export async function applyGoodsReceipt(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  deltas: { purchaseOrderItemId: string; receivedDelta: number }[],
  actor?: AuditActor,
): Promise<void> {
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
    recordStatus(actor, purchaseOrderId, header.code, `purchase_order.${next}`);
  }
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
