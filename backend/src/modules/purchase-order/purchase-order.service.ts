import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import * as poRepo from "./purchase-order.repository.js";
import type { PoLineRow, PurchaseOrderWithRelations } from "./purchase-order.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type {
  CreatePurchaseOrderInput,
  POLineInput,
  PoAttachmentInput,
  UpdatePurchaseOrderInput,
} from "./purchase-order.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Status state machine (forward-only; backend-enforced). The one sanctioned reverse edge is
// pending_approval → draft (Reject for rework). The received states are reachable only via the
// Goods In seam, never a PO endpoint. ────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"], // → draft = Reject (rework)
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "fully_received", "cancelled"], // received = Goods In
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
  status: string;
  priority: string;
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
    status: po.status ?? "draft",
    priority: po.priority ?? "normal",
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
  const rows: PoLineRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const item = await irmService.requireActiveIrmItem(line.irmItemId);
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

export interface ListPurchaseOrdersParams {
  search?: string;
  status?: string;
  priority?: string;
  supplier?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listPurchaseOrders(params: ListPurchaseOrdersParams = {}): Promise<PagedPurchaseOrders> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = {
    search: params.search,
    status: params.status,
    priority: params.priority,
    supplierId: params.supplier,
    warehouseId: params.warehouse,
  };
  const total = await poRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await poRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { purchaseOrders: rows.map(toPublic), total, page, pageSize, totalPages };
}

export async function getPurchaseOrder(idOrCode: string): Promise<PublicPurchaseOrder> {
  const po = OBJECT_ID_RE.test(idOrCode) ? await poRepo.findById(idOrCode) : await poRepo.findByCode(idOrCode);
  if (!po) throw notFound("Purchase order not found.");
  return toPublic(po);
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const supplier = await supplierService.requireActiveSupplier(input.supplierId);
  await warehouseService.requireActiveWarehouse(input.warehouseId);
  const lineRows = await buildLineRows(input.items);
  const totals = computeTotals(lineRows);
  const actorLabel = actor?.email ?? null;

  const created = await poRepo.createWithCode(
    {
      supplierId: input.supplierId,
      supplierName: supplier.name,
      warehouseId: input.warehouseId,
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

export async function updatePurchaseOrder(id: string, input: UpdatePurchaseOrderInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const existing = await poRepo.findById(id);
  if (!existing) throw notFound("Purchase order not found.");
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
    await warehouseService.requireActiveWarehouse(input.warehouseId);
    headerPatch.warehouseId = input.warehouseId;
  }
  if (input.priority !== undefined) headerPatch.priority = input.priority;
  if (input.referenceNumber !== undefined) headerPatch.referenceNumber = trimToNull(input.referenceNumber);
  if (input.description !== undefined) headerPatch.description = trimToNull(input.description);
  if (input.orderDate !== undefined) headerPatch.orderDate = new Date(input.orderDate);
  if (input.expectedDeliveryDate !== undefined) headerPatch.expectedDeliveryDate = new Date(input.expectedDeliveryDate);
  if (input.deliveryAddress !== undefined) headerPatch.deliveryAddress = trimToNull(input.deliveryAddress);
  if (input.deliveryInstructions !== undefined) headerPatch.deliveryInstructions = trimToNull(input.deliveryInstructions);
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
async function loadOrThrow(id: string): Promise<PurchaseOrderWithRelations> {
  const po = await poRepo.findById(id);
  if (!po) throw notFound("Purchase order not found.");
  return po;
}
function recordStatus(actor: AuditActor | undefined, id: string, code: string, action: string): void {
  audit.record({ actor, action, targetType: "purchase_order", targetId: id, targetLabel: code });
}

export async function submitPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "pending_approval");
  if (po.items.length === 0) throw badRequest("Add at least one item before submitting.");
  const updated = await poRepo.update(id, { status: "pending_approval", submittedBy: actor?.email ?? null, submittedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.submitted");
  return toPublic(updated);
}

export async function approvePurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "approved");
  const updated = await poRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.approved");
  return toPublic(updated);
}

export async function rejectPurchaseOrder(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "draft"); // reject = back to draft for rework
  const updated = await poRepo.update(id, { status: "draft", rejectionReason: reason.trim() });
  recordStatus(actor, id, updated.code, "purchase_order.rejected");
  return toPublic(updated);
}

export async function sendPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "sent");
  const updated = await poRepo.update(id, { status: "sent", sentAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.sent");
  return toPublic(updated);
}

export async function cancelPurchaseOrder(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "cancelled");
  const updated = await poRepo.update(id, { status: "cancelled", cancelledAt: new Date(), cancelReason: trimToNull(reason) });
  recordStatus(actor, id, updated.code, "purchase_order.cancelled");
  return toPublic(updated);
}

export async function closePurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id);
  assertTransition(po.status, "closed");
  const updated = await poRepo.update(id, { status: "closed", closedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.closed");
  return toPublic(updated);
}

export async function deletePurchaseOrder(id: string, actor?: AuditActor): Promise<void> {
  const po = await loadOrThrow(id);
  if (po.status !== "draft") throw conflict("Only draft purchase orders can be deleted.");
  await poRepo.softDelete(id);
  audit.record({ actor, action: "purchase_order.deleted", targetType: "purchase_order", targetId: id, targetLabel: po.code });
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────
export async function addAttachment(poId: string, input: PoAttachmentInput, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId);
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
  return getPurchaseOrder(poId);
}

export async function removeAttachment(poId: string, attachmentId: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(poId);
  const att = await poRepo.findAttachment(attachmentId);
  if (!att || att.purchaseOrderId !== poId) throw notFound("Attachment not found.");
  await poRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "purchase_order.attachment_removed", targetType: "purchase_order", targetId: poId, targetLabel: po.code });
  return getPurchaseOrder(poId);
}

// ── Seams for the FUTURE Goods In module (NOT wired to any PO endpoint) ───────────────────────
// Assert a PO can receive stock; Goods In calls this before recording a receipt.
export async function requireReceivablePurchaseOrder(id: string): Promise<PurchaseOrderWithRelations> {
  if (!id || !OBJECT_ID_RE.test(id)) throw badRequest("Select a purchase order.");
  const po = await poRepo.findById(id);
  if (!po) throw badRequest("Selected purchase order no longer exists.");
  if (po.status !== "sent" && po.status !== "partially_received") {
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
