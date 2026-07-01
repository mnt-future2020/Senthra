import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import * as poRepo from "./purchase-order.repository.js";
import type { PoLineRow, PurchaseOrderWithRelations } from "./purchase-order.repository.js";
import * as poEmail from "./purchase-order.email.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrdersSplitInput,
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
  statuses?: string[];
  priority?: string;
  supplier?: string;
  warehouse?: string;
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

export async function approvePurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "approved");
  const updated = await poRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_order.approved");
  return toPublic(updated);
}

export async function rejectPurchaseOrder(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "draft"); // reject = back to draft for rework
  const updated = await poRepo.update(id, { status: "draft", rejectionReason: reason.trim() });
  recordStatus(actor, id, updated.code, "purchase_order.rejected");
  return toPublic(updated);
}

export async function sendPurchaseOrder(id: string, actor?: AuditActor): Promise<PublicPurchaseOrder> {
  const po = await loadOrThrow(id, actor);
  assertTransition(po.status, "sent");
  // sentBy is the issuer — the signer printed on the PO document (deterministic for email + download).
  const updated = await poRepo.update(id, { status: "sent", sentAt: new Date(), sentBy: actor?.email ?? null });
  recordStatus(actor, id, updated.code, "purchase_order.sent");
  // Fire-and-forget: email the supplier the issued PO with its PDF. NEVER blocks or rolls back.
  void poEmail.notifySupplierPoSent(updated, actor).catch((e) =>
    console.error(`PO ${updated.code} supplier email failed:`, e instanceof Error ? e.message : e),
  );
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

// READ seam for Warehouse Inventory: total still-to-arrive quantity for an item at a warehouse,
// summed across open POs (sent / partially_received). Pure read; no PO behaviour change.
export async function incomingForItemWarehouse(irmItemId: string, warehouseId: string): Promise<number> {
  const lines = await poRepo.incomingLinesForItemWarehouse(irmItemId, warehouseId);
  return lines.reduce((sum, l) => sum + Math.max(0, l.quantity - l.receivedQuantity), 0);
}
