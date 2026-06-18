import { randomUUID } from "node:crypto";

import * as grnRepo from "./goods-in.repository.js";
import type { GoodsReceiptWithRelations, GRNLineRow } from "./goods-in.repository.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type { CreateGoodsReceiptInput, GRNLineInput, GRNAttachmentInput, UpdateGoodsReceiptInput } from "./goods-in.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Status state machine (forward-only; backend-enforced). Inventory is written ONCE, at
// Completed. Completed is terminal & immutable. Cancel is only from Draft. ────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${from} goods receipt to ${to}.`);
  }
}

// ── DTO ──────────────────────────────────────────────────────────────────────────────────────
export interface PublicGRNSupplier {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}
export interface PublicGRNWarehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
}
export interface PublicGRNSerial {
  id: string;
  serialNumber: string;
}
export interface PublicGRNBatch {
  id: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
}
export interface PublicGRNItem {
  id: string;
  purchaseOrderItemId: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  orderedQuantity: number;
  previouslyReceived: number;
  receivedQuantity: number;
  damagedQuantity: number;
  acceptedQuantity: number;
  notes: string | null;
  serials: PublicGRNSerial[];
  batches: PublicGRNBatch[];
  irmItem: { id: string; code: string; name: string; status: string; trackSerialNumbers: boolean; trackBatchNumbers: boolean; trackInventory: boolean } | null;
}
export interface PublicGRNAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}
export interface PublicGoodsReceipt {
  id: string;
  code: string;
  purchaseOrderId: string;
  poCode: string | null;
  purchaseOrder: { id: string; code: string; status: string } | null;
  supplierId: string | null;
  supplierName: string | null;
  supplier: PublicGRNSupplier | null;
  warehouseId: string;
  warehouse: PublicGRNWarehouse | null;
  status: string;
  receivedDate: string;
  referenceNumber: string | null;
  carrier: string | null;
  deliveryNoteNumber: string | null;
  vehicleRegistration: string | null;
  description: string | null;
  qualityStatus: string;
  qualityNotes: string | null;
  internalNotes: string | null;
  items: PublicGRNItem[];
  attachments: PublicGRNAttachment[];
  // Roll-ups for the list/summary.
  totalReceived: number;
  totalAccepted: number;
  totalDamaged: number;
  createdBy: string | null;
  completedBy: string | null;
  completedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedGoodsReceipts {
  goodsReceipts: PublicGoodsReceipt[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function warehouseAddress(w: GoodsReceiptWithRelations["warehouse"]): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function toPublic(grn: GoodsReceiptWithRelations): PublicGoodsReceipt {
  const supplier = grn.purchaseOrder?.supplier;
  let totalReceived = 0;
  let totalAccepted = 0;
  let totalDamaged = 0;
  for (const i of grn.items) {
    totalReceived += i.receivedQuantity;
    totalAccepted += i.acceptedQuantity;
    totalDamaged += i.damagedQuantity;
  }
  return {
    id: grn.id,
    code: grn.code,
    purchaseOrderId: grn.purchaseOrderId,
    poCode: grn.poCode,
    purchaseOrder: grn.purchaseOrder ? { id: grn.purchaseOrder.id, code: grn.purchaseOrder.code, status: grn.purchaseOrder.status ?? "" } : null,
    supplierId: grn.supplierId,
    supplierName: grn.supplierName,
    supplier: supplier
      ? {
          id: supplier.id,
          code: supplier.code,
          name: supplier.name,
          contactPerson: supplier.contactPerson,
          contactEmail: supplier.contactEmail,
          contactPhone: supplier.contactPhone,
        }
      : null,
    warehouseId: grn.warehouseId,
    warehouse: grn.warehouse ? { id: grn.warehouse.id, code: grn.warehouse.code, name: grn.warehouse.name, address: warehouseAddress(grn.warehouse) } : null,
    status: grn.status ?? "draft",
    receivedDate: grn.receivedDate.toISOString(),
    referenceNumber: grn.referenceNumber,
    carrier: grn.carrier,
    deliveryNoteNumber: grn.deliveryNoteNumber,
    vehicleRegistration: grn.vehicleRegistration,
    description: grn.description,
    qualityStatus: grn.qualityStatus ?? "passed",
    qualityNotes: grn.qualityNotes,
    internalNotes: grn.internalNotes,
    items: grn.items.map((i) => ({
      id: i.id,
      purchaseOrderItemId: i.purchaseOrderItemId,
      irmItemId: i.irmItemId,
      itemName: i.itemName,
      sku: i.sku,
      baseUnit: i.baseUnit,
      orderedQuantity: i.orderedQuantity,
      previouslyReceived: i.previouslyReceived,
      receivedQuantity: i.receivedQuantity,
      damagedQuantity: i.damagedQuantity,
      acceptedQuantity: i.acceptedQuantity,
      notes: i.notes,
      serials: i.serials.map((s) => ({ id: s.id, serialNumber: s.serialNumber })),
      batches: i.batches.map((b) => ({ id: b.id, batchNumber: b.batchNumber, expiryDate: iso(b.expiryDate), quantity: b.quantity })),
      irmItem: i.irmItem
        ? {
            id: i.irmItem.id,
            code: i.irmItem.code,
            name: i.irmItem.name,
            status: i.irmItem.status ?? "active",
            trackSerialNumbers: i.irmItem.trackSerialNumbers,
            trackBatchNumbers: i.irmItem.trackBatchNumbers,
            trackInventory: i.irmItem.trackInventory,
          }
        : null,
    })),
    attachments: grn.attachments.map((a) => ({
      id: a.id,
      label: a.label,
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url: a.url,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    totalReceived,
    totalAccepted,
    totalDamaged,
    createdBy: grn.createdBy,
    completedBy: grn.completedBy,
    completedAt: iso(grn.completedAt),
    cancelledBy: grn.cancelledBy,
    cancelledAt: iso(grn.cancelledAt),
    cancelReason: grn.cancelReason,
    updatedBy: grn.updatedBy,
    createdAt: grn.createdAt.toISOString(),
    updatedAt: grn.updatedAt.toISOString(),
  };
}

// ── Line building + validation ────────────────────────────────────────────────────────────────
type PoLineLite = { id: string; irmItemId: string; itemName: string; sku: string | null; baseUnit: string | null; quantity: number; receivedQuantity: number };
type TrackFlags = { trackInventory: boolean; trackSerialNumbers: boolean; trackBatchNumbers: boolean };

function buildLineRows(items: GRNLineInput[], poLines: Map<string, PoLineLite>, flags: Map<string, TrackFlags>): GRNLineRow[] {
  const rows: GRNLineRow[] = [];
  for (const line of items) {
    const po = poLines.get(line.purchaseOrderItemId);
    if (!po) throw badRequest("A selected line isn't on this purchase order.");
    const remaining = po.quantity - po.receivedQuantity;
    const received = line.receivedQuantity;
    const damaged = line.damagedQuantity ?? 0;
    if (received > remaining) {
      throw conflict(`${po.itemName}: only ${remaining} remaining to receive (ordered ${po.quantity}, already received ${po.receivedQuantity}).`);
    }
    if (damaged > received) throw badRequest(`${po.itemName}: damaged quantity can't exceed received quantity.`);
    const accepted = received - damaged;
    const f = flags.get(po.irmItemId) ?? { trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false };

    let serials: GRNLineRow["serials"] = [];
    if (f.trackSerialNumbers) {
      const cleaned = (line.serials ?? []).map((s) => s.trim()).filter(Boolean);
      if (cleaned.length !== accepted) {
        throw badRequest(`${po.itemName}: enter exactly ${accepted} serial number(s) — one per accepted unit.`);
      }
      const lowers = cleaned.map((s) => s.toLowerCase());
      if (new Set(lowers).size !== lowers.length) throw badRequest(`${po.itemName}: duplicate serial numbers in this receipt.`);
      serials = cleaned.map((sn, i) => ({ serialNumber: sn, serialLower: lowers[i], irmItemId: po.irmItemId }));
    }

    let batches: GRNLineRow["batches"] = [];
    if (f.trackBatchNumbers) {
      const provided = line.batches ?? [];
      const sum = provided.reduce((a, b) => a + b.quantity, 0);
      if (sum !== accepted) throw badRequest(`${po.itemName}: batch quantities must total ${accepted} (the accepted quantity).`);
      batches = provided.map((b) => ({ batchNumber: b.batchNumber.trim(), expiryDate: b.expiryDate ? new Date(b.expiryDate) : null, quantity: b.quantity }));
    }

    rows.push({
      purchaseOrderItemId: po.id,
      irmItemId: po.irmItemId,
      itemName: po.itemName,
      sku: po.sku,
      baseUnit: po.baseUnit,
      orderedQuantity: po.quantity,
      previouslyReceived: po.receivedQuantity,
      receivedQuantity: received,
      damagedQuantity: damaged,
      acceptedQuantity: accepted,
      notes: trimToNull(line.notes),
      serials,
      batches,
    });
  }
  return rows;
}

// Serial numbers are unique per IRM item across all non-deleted GRNs (a serial = one physical
// unit). Checks dups within this receipt + against the database.
async function assertSerialsUnique(rows: GRNLineRow[], excludeGrnId?: string): Promise<void> {
  const byItem = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.serials.length) continue;
    const arr = byItem.get(r.irmItemId) ?? [];
    arr.push(...r.serials.map((s) => s.serialLower));
    byItem.set(r.irmItemId, arr);
  }
  for (const [irmItemId, lowers] of byItem) {
    if (new Set(lowers).size !== lowers.length) throw badRequest("The same serial number appears more than once in this receipt.");
    const conflicts = await grnRepo.findSerialConflicts(irmItemId, lowers, excludeGrnId);
    if (conflicts.length) throw conflict(`Serial number already received elsewhere: ${conflicts.map((c) => c.serialLower).join(", ")}.`);
  }
}

async function loadFlags(poLines: Map<string, PoLineLite>, items: GRNLineInput[]): Promise<Map<string, TrackFlags>> {
  const irmIds = [...new Set(items.map((i) => poLines.get(i.purchaseOrderItemId)?.irmItemId).filter((x): x is string => Boolean(x)))];
  const flags = await grnRepo.findIrmTrackFlags(irmIds);
  return new Map(flags.map((f) => [f.id, { trackInventory: f.trackInventory, trackSerialNumbers: f.trackSerialNumbers, trackBatchNumbers: f.trackBatchNumbers }]));
}

function poLineMap(po: Awaited<ReturnType<typeof poService.requireReceivablePurchaseOrder>>): Map<string, PoLineLite> {
  return new Map(
    po.items.map((l) => [l.id, { id: l.id, irmItemId: l.irmItemId, itemName: l.itemName, sku: l.sku, baseUnit: l.baseUnit, quantity: l.quantity, receivedQuantity: l.receivedQuantity }]),
  );
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────
export interface ListGoodsReceiptsParams {
  search?: string;
  status?: string;
  warehouse?: string;
  purchaseOrder?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listGoodsReceipts(params: ListGoodsReceiptsParams = {}): Promise<PagedGoodsReceipts> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = { search: params.search, status: params.status, warehouseId: params.warehouse, purchaseOrderId: params.purchaseOrder };
  const total = await grnRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await grnRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { goodsReceipts: rows.map(toPublic), total, page, pageSize, totalPages };
}

export async function getGoodsReceipt(idOrCode: string): Promise<PublicGoodsReceipt> {
  const grn = OBJECT_ID_RE.test(idOrCode) ? await grnRepo.findById(idOrCode) : await grnRepo.findByCode(idOrCode);
  if (!grn) throw notFound("Goods receipt not found.");
  return toPublic(grn);
}

async function loadOrThrow(id: string): Promise<GoodsReceiptWithRelations> {
  const grn = await grnRepo.findById(id);
  if (!grn) throw notFound("Goods receipt not found.");
  return grn;
}

// ── Create / update (draft only) ────────────────────────────────────────────────────────────
export async function createGoodsReceipt(input: CreateGoodsReceiptInput, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const po = await poService.requireReceivablePurchaseOrder(input.purchaseOrderId);
  const poLines = poLineMap(po);
  const flags = await loadFlags(poLines, input.items);
  const rows = buildLineRows(input.items, poLines, flags);
  await assertSerialsUnique(rows);
  const actorEmail = actor?.email ?? null;

  const created = await grnRepo.createWithCode(
    {
      purchaseOrderId: po.id,
      poCode: po.code,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      warehouseId: po.warehouseId,
      status: "draft",
      receivedDate: new Date(input.receivedDate),
      referenceNumber: trimToNull(input.referenceNumber),
      carrier: trimToNull(input.carrier),
      deliveryNoteNumber: trimToNull(input.deliveryNoteNumber),
      vehicleRegistration: trimToNull(input.vehicleRegistration),
      description: trimToNull(input.description),
      qualityStatus: input.qualityStatus ?? "passed",
      qualityNotes: trimToNull(input.qualityNotes),
      internalNotes: trimToNull(input.internalNotes),
      createdBy: actorEmail,
      updatedBy: actorEmail,
    },
    rows,
  );
  audit.record({ actor, action: "goods_in.created", targetType: "goods_receipt", targetId: created.id, targetLabel: created.code });
  return toPublic(created);
}

export async function updateGoodsReceipt(id: string, input: UpdateGoodsReceiptInput, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const existing = await grnRepo.findById(id);
  if (!existing) throw notFound("Goods receipt not found.");
  if (existing.status !== "draft") throw conflict("Only draft goods receipts can be edited.");

  const headerPatch: Record<string, unknown> = { updatedBy: actor?.email ?? null };
  if (input.receivedDate !== undefined) headerPatch.receivedDate = new Date(input.receivedDate);
  if (input.referenceNumber !== undefined) headerPatch.referenceNumber = trimToNull(input.referenceNumber);
  if (input.carrier !== undefined) headerPatch.carrier = trimToNull(input.carrier);
  if (input.deliveryNoteNumber !== undefined) headerPatch.deliveryNoteNumber = trimToNull(input.deliveryNoteNumber);
  if (input.vehicleRegistration !== undefined) headerPatch.vehicleRegistration = trimToNull(input.vehicleRegistration);
  if (input.description !== undefined) headerPatch.description = trimToNull(input.description);
  if (input.qualityStatus !== undefined) headerPatch.qualityStatus = input.qualityStatus;
  if (input.qualityNotes !== undefined) headerPatch.qualityNotes = trimToNull(input.qualityNotes);
  if (input.internalNotes !== undefined) headerPatch.internalNotes = trimToNull(input.internalNotes);

  let result: GoodsReceiptWithRelations;
  if (input.items !== undefined) {
    const po = await poService.requireReceivablePurchaseOrder(existing.purchaseOrderId);
    const poLines = poLineMap(po);
    const flags = await loadFlags(poLines, input.items);
    const rows = buildLineRows(input.items, poLines, flags);
    await assertSerialsUnique(rows, id);
    result = await grnRepo.replaceItemsAndChildren(id, rows, headerPatch);
  } else {
    result = await grnRepo.update(id, headerPatch);
  }
  audit.record({ actor, action: "goods_in.updated", targetType: "goods_receipt", targetId: id, targetLabel: result.code });
  return toPublic(result);
}

// ── Complete (the only inventory-writing action) ──────────────────────────────────────────────
export async function completeGoodsReceipt(id: string, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const grn = await loadOrThrow(id);
  assertTransition(grn.status, "completed");
  if (grn.items.length === 0) throw badRequest("Add at least one received item before completing.");
  const actorEmail = actor?.email ?? null;

  await withTransaction(async (tx) => {
    // 0) Re-read the GRN INSIDE the tx and revalidate — never trust the pre-tx snapshot. A
    //    concurrent complete (status no longer draft) or edit (updatedAt moved) must abort here so
    //    inventory and the PO can't be advanced twice or from stale quantities. The fresh items are
    //    used for the writes below, not `grn.items`.
    const fresh = await grnRepo.findByIdTx(tx, id);
    if (!fresh) throw conflict("This goods receipt is no longer available. Refresh and try again.");
    if (fresh.status !== "draft") throw conflict("This goods receipt was just completed or cancelled elsewhere. Refresh and try again.");
    if (fresh.updatedAt.getTime() !== grn.updatedAt.getTime()) {
      throw conflict("This goods receipt was just modified elsewhere. Refresh and try again.");
    }
    if (fresh.items.length === 0) throw conflict("This goods receipt has no items to receive.");

    // 1) Advance the PO first (validates remaining against the live PO inside the tx; throwing
    //    here rolls back everything, including any inventory below).
    await poService.applyGoodsReceipt(
      tx,
      fresh.purchaseOrderId,
      fresh.items.map((i) => ({ purchaseOrderItemId: i.purchaseOrderItemId, receivedDelta: i.receivedQuantity })),
      actor,
    );
    // 2) Increase warehouse inventory by the ACCEPTED quantity (good stock only; damaged units
    //    are recorded on the line but never enter on-hand). Only items that track inventory.
    for (const item of fresh.items) {
      if (item.irmItem?.trackInventory && item.acceptedQuantity > 0) {
        await inventoryService.applyInbound(tx, {
          irmItemId: item.irmItemId,
          warehouseId: fresh.warehouseId,
          quantity: item.acceptedQuantity,
          sourceType: "goods_receipt",
          sourceId: fresh.id,
          sourceCode: fresh.code,
          createdBy: actorEmail,
        });
      }
    }
    // 3) Stamp the GRN completed.
    await grnRepo.completeTx(tx, id, actorEmail);
  });

  audit.record({ actor, action: "goods_in.completed", targetType: "goods_receipt", targetId: id, targetLabel: grn.code });
  return getGoodsReceipt(id);
}

export async function cancelGoodsReceipt(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const grn = await loadOrThrow(id);
  assertTransition(grn.status, "cancelled");
  const updated = await grnRepo.update(id, { status: "cancelled", cancelledBy: actor?.email ?? null, cancelledAt: new Date(), cancelReason: trimToNull(reason) });
  audit.record({ actor, action: "goods_in.cancelled", targetType: "goods_receipt", targetId: id, targetLabel: updated.code });
  return toPublic(updated);
}

export async function deleteGoodsReceipt(id: string, actor?: AuditActor): Promise<void> {
  const grn = await loadOrThrow(id);
  if (grn.status !== "draft") throw conflict("Only draft goods receipts can be deleted.");
  await grnRepo.softDelete(id);
  audit.record({ actor, action: "goods_in.deleted", targetType: "goods_receipt", targetId: id, targetLabel: grn.code });
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────
export async function addAttachment(grnId: string, input: GRNAttachmentInput, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const grn = await loadOrThrow(grnId);
  // Attachments are editable on a DRAFT receipt only — a completed or cancelled GRN is
  // immutable (mirrors the edit/delete guards).
  if (grn.status !== "draft") throw conflict("Only draft goods receipts can have attachments changed.");
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("File uploads aren't configured. Add Cloudinary credentials in Settings first.");
  const url = await uploadFileToCloudinary(input.data, randomUUID(), creds, "senthra/goods-in");
  await grnRepo.addAttachment({
    goodsReceiptId: grnId,
    label: trimToNull(input.label),
    fileName: input.fileName.trim(),
    fileType: input.fileType,
    fileSizeBytes: input.fileSizeBytes,
    url,
    uploadedBy: actor?.email ?? null,
  });
  audit.record({ actor, action: "goods_in.attachment_added", targetType: "goods_receipt", targetId: grnId, targetLabel: grn.code });
  return getGoodsReceipt(grnId);
}

export async function removeAttachment(grnId: string, attachmentId: string, actor?: AuditActor): Promise<PublicGoodsReceipt> {
  const grn = await loadOrThrow(grnId);
  if (grn.status !== "draft") throw conflict("Only draft goods receipts can have attachments changed.");
  const att = await grnRepo.findAttachment(attachmentId);
  if (!att || att.goodsReceiptId !== grnId) throw notFound("Attachment not found.");
  await grnRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "goods_in.attachment_removed", targetType: "goods_receipt", targetId: grnId, targetLabel: grn.code });
  return getGoodsReceipt(grnId);
}
