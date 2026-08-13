import { Prisma, type GoodsReceipt, type GoodsReceiptAttachment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";

// Friendly message when the DB serial-uniqueness backstop fires (a concurrent receipt grabbed the
// same serial between our app-level check and our write).
const SERIAL_CONFLICT_MSG =
  "One or more of those serial numbers were just received on another goods receipt. Refresh and try again.";

// A P2002 raised by the GoodsReceiptSerial @@unique([irmItemId, serialLower]) backstop (as opposed
// to the GRN code unique). Exported so it can be unit-tested directly.
export function isSerialUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target != null && String(target).toLowerCase().includes("serial");
}

// Data-access layer for Goods In (GRN). The ONLY place Prisma is touched for goods receipts.
// Soft-deleted GRNs (deletedAt set) are excluded from normal reads. Header + lines + serials +
// batches are written atomically (withTransaction). The completion transaction itself is
// orchestrated in the service (it also writes inventory + the PO), using completeTx here.

// Supplier slice for the read-only "Supplier Information" section (resolved live via the PO).
const supplierSelect = {
  id: true,
  code: true,
  name: true,
  contactPerson: true,
  contactEmail: true,
  contactPhone: true,
} satisfies Prisma.SupplierSelect;

// Warehouse slice — code/name + address parts (joined into one line in the DTO).
const warehouseSelect = {
  id: true,
  code: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
} satisfies Prisma.WarehouseSelect;

const irmItemSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  trackInventory: true,
  trackSerialNumbers: true,
  trackBatchNumbers: true,
} satisfies Prisma.IrmItemSelect;

const withRelations = {
  purchaseOrder: { select: { id: true, code: true, status: true, supplier: { select: supplierSelect } } },
  warehouse: { select: warehouseSelect },
  items: {
    orderBy: { sortOrder: "asc" },
    include: {
      irmItem: { select: irmItemSelect },
      serials: { orderBy: { createdAt: "asc" } },
      batches: { orderBy: { createdAt: "asc" } },
    },
  },
  attachments: { orderBy: { createdAt: "desc" } },
} satisfies Prisma.GoodsReceiptInclude;

export type GoodsReceiptWithRelations = Prisma.GoodsReceiptGetPayload<{ include: typeof withRelations }>;

// --- row shapes the service builds for create / replace --------------------------------------
export interface GRNSerialRow {
  serialNumber: string;
  serialLower: string;
  irmItemId: string;
}
export interface GRNBatchRow {
  batchNumber: string;
  expiryDate: Date | null;
  quantity: number;
}
export interface GRNLineRow {
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
  serials: GRNSerialRow[];
  batches: GRNBatchRow[];
}

function lineCreateData(l: GRNLineRow, sortOrder: number): Prisma.GoodsReceiptItemUncheckedCreateWithoutGoodsReceiptInput {
  return {
    purchaseOrderItemId: l.purchaseOrderItemId,
    irmItemId: l.irmItemId,
    itemName: l.itemName,
    sku: l.sku,
    baseUnit: l.baseUnit,
    orderedQuantity: l.orderedQuantity,
    previouslyReceived: l.previouslyReceived,
    receivedQuantity: l.receivedQuantity,
    damagedQuantity: l.damagedQuantity,
    acceptedQuantity: l.acceptedQuantity,
    notes: l.notes,
    sortOrder,
    serials: { create: l.serials.map((s) => ({ serialNumber: s.serialNumber, serialLower: s.serialLower, irmItemId: s.irmItemId })) },
    batches: { create: l.batches.map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: b.quantity })) },
  };
}

// --- filters / reads -------------------------------------------------------------------------
export interface GoodsReceiptListFilters {
  search?: string;
  status?: string;
  warehouseId?: string;
  // Warehouse-access scope. `undefined` = unrestricted (no constraint); an array constrains to those
  // warehouses (an empty array correctly matches nothing). Applied alongside `warehouseId` — both apply.
  warehouseIds?: string[];
  purchaseOrderId?: string;
  /** Every receipt from one supplier — the supplier's own Goods In tab. Matches the DENORMALISED
   *  `supplierId` snapshot on the receipt (there is no FK; it is resolved from the PO at creation),
   *  which is what `@@index([supplierId])` on GoodsReceipt exists to serve. */
  supplierId?: string;
}

function buildWhere(filters: GoodsReceiptListFilters): Prisma.GoodsReceiptWhereInput {
  const where: Prisma.GoodsReceiptWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters.warehouseIds !== undefined) where.warehouseId = { ...(where.warehouseId ? { equals: where.warehouseId as string } : {}), in: filters.warehouseIds };
  if (filters.purchaseOrderId) where.purchaseOrderId = filters.purchaseOrderId;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { poCode: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { deliveryNoteNumber: { contains: q, mode: "insensitive" } },
      { referenceNumber: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.GoodsReceiptOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    case "received":
      return { receivedDate: "desc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(filters: GoodsReceiptListFilters = {}, skip = 0, take = 20, sort?: string): Promise<GoodsReceiptWithRelations[]> {
  return prisma.goodsReceipt.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}
export function count(filters: GoodsReceiptListFilters = {}): Promise<number> {
  return prisma.goodsReceipt.count({ where: buildWhere(filters) });
}
/**
 * Draft receipts split PER WAREHOUSE — the per-row half of the attention catalog's `wh.grn_drafts`.
 *
 * The flat count answers "is there work?"; this answers "where?", which is the question a manager who
 * can reach several warehouses actually has. Warehouses with none are simply absent from the map
 * (groupBy emits no row for an empty group), so callers must treat missing as zero.
 */
export async function countDraftsByWarehouse(warehouseIds?: string[]): Promise<Record<string, number>> {
  const rows = await prisma.goodsReceipt.groupBy({
    by: ["warehouseId"],
    where: { deletedAt: null, status: "draft", ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.warehouseId, r._count._all]));
}
export function findById(id: string): Promise<GoodsReceiptWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.goodsReceipt.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}
export function findByCode(code: string): Promise<GoodsReceiptWithRelations | null> {
  return prisma.goodsReceipt.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}
// tx-aware read for the completion transaction — re-reads the GRN (status + live items) INSIDE the
// tx so completion never trusts a snapshot taken before the transaction began.
export function findByIdTx(tx: Prisma.TransactionClient, id: string): Promise<GoodsReceiptWithRelations | null> {
  return tx.goodsReceipt.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

// --- header / status writes ------------------------------------------------------------------
export function update(id: string, data: Prisma.GoodsReceiptUncheckedUpdateInput): Promise<GoodsReceiptWithRelations> {
  return prisma.goodsReceipt.update({ where: { id }, data, include: withRelations });
}
export function softDelete(id: string): Promise<GoodsReceipt> {
  return prisma.goodsReceipt.update({ where: { id }, data: { deletedAt: new Date() } });
}
// tx-aware: mark a GRN completed inside the completion transaction (alongside inventory + PO).
export function completeTx(tx: Prisma.TransactionClient, id: string, completedBy: string | null) {
  return tx.goodsReceipt.update({ where: { id }, data: { status: "completed", completedBy, completedAt: new Date() } });
}

// Replace ALL lines + their serials/batches and patch the header, atomically (draft edit).
export async function replaceItemsAndChildren(
  id: string,
  lines: GRNLineRow[],
  headerPatch: Prisma.GoodsReceiptUncheckedUpdateInput,
): Promise<GoodsReceiptWithRelations> {
  try {
    return await withTransaction(async (tx) => {
      const existing = await tx.goodsReceiptItem.findMany({ where: { goodsReceiptId: id }, select: { id: true } });
      const itemIds = existing.map((e) => e.id);
      if (itemIds.length) {
        await tx.goodsReceiptSerial.deleteMany({ where: { goodsReceiptItemId: { in: itemIds } } });
        await tx.goodsReceiptBatch.deleteMany({ where: { goodsReceiptItemId: { in: itemIds } } });
        await tx.goodsReceiptItem.deleteMany({ where: { goodsReceiptId: id } });
      }
      for (let i = 0; i < lines.length; i++) {
        await tx.goodsReceiptItem.create({ data: { goodsReceiptId: id, ...lineCreateData(lines[i], i) } });
      }
      await tx.goodsReceipt.update({ where: { id }, data: headerPatch });
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id }, include: withRelations });
    });
  } catch (e) {
    if (isSerialUniqueViolation(e)) throw conflict(SERIAL_CONFLICT_MSG);
    throw e;
  }
}

// --- delete-guard counters (used by PO / Warehouse / IRM delete guards) ----------------------
export function countByPurchaseOrder(purchaseOrderId: string): Promise<number> {
  return prisma.goodsReceipt.count({ where: { purchaseOrderId, deletedAt: null } });
}
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.goodsReceipt.count({ where: { warehouseId, deletedAt: null } });
}
export function countByIrmItem(irmItemId: string): Promise<number> {
  return prisma.goodsReceiptItem.count({ where: { irmItemId, goodsReceipt: { is: { deletedAt: null } } } });
}
export function countBySupplier(supplierId: string): Promise<number> {
  return prisma.goodsReceipt.count({ where: { supplierId, deletedAt: null } });
}

// Warehouse Inventory READ seam: completed-receipt history for an item at a warehouse — feeds the
// inventory detail "Purchase History" tab (PO / supplier / received qty / date). Pure read.
export function receivedHistoryForItemWarehouse(irmItemId: string, warehouseId: string) {
  return prisma.goodsReceiptItem.findMany({
    where: { irmItemId, goodsReceipt: { is: { warehouseId, status: "completed", deletedAt: null } } },
    select: { receivedQuantity: true, goodsReceipt: { select: { code: true, poCode: true, supplierName: true, receivedDate: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

// --- Dashboard read-model — not a generic reporting API (read-only; warehouse-scoped) ---------

/** receivedDate of completed GRNs since `since` — feeds the "Goods Received" card
 *  (last-7-day count + weekly sparkline are both derived from this one read). */
export async function completedReceiptsSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date }>> {
  const rows = await prisma.goodsReceipt.findMany({
    where: {
      status: "completed",
      receivedDate: { gte: since },
      deletedAt: null,
      ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
    },
    select: { receivedDate: true },
  });
  return rows.map((r) => ({ at: r.receivedDate }));
}

// --- serial uniqueness (app-level, per item, across non-deleted GRNs) ------------------------
export function findSerialConflicts(irmItemId: string, serialLowers: string[], excludeGoodsReceiptId?: string): Promise<{ serialLower: string }[]> {
  if (serialLowers.length === 0) return Promise.resolve([]);
  return prisma.goodsReceiptSerial.findMany({
    where: {
      irmItemId,
      serialLower: { in: serialLowers },
      goodsReceiptItem: {
        is: {
          // Cancelled receipts post no stock, so their serials don't reserve the namespace — exclude
          // them so a serial from a cancelled delivery can be received again.
          goodsReceipt: { is: { deletedAt: null, status: { not: "cancelled" }, ...(excludeGoodsReceiptId ? { id: { not: excludeGoodsReceiptId } } : {}) } },
        },
      },
    },
    select: { serialLower: true },
  });
}

// IRM tracking flags for the selected items (drives serial/batch requirements + whether an
// item's accepted stock writes to inventory). Read regardless of item status — receiving
// physical goods isn't blocked by a later deactivation of the catalogue item.
export function findIrmTrackFlags(
  irmItemIds: string[],
): Promise<{ id: string; trackInventory: boolean; trackSerialNumbers: boolean; trackBatchNumbers: boolean }[]> {
  if (irmItemIds.length === 0) return Promise.resolve([]);
  return prisma.irmItem.findMany({
    where: { id: { in: irmItemIds } },
    select: { id: true, trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: true },
  });
}

// --- attachments -----------------------------------------------------------------------------
export function addAttachment(
  data: Prisma.GoodsReceiptAttachmentUncheckedCreateInput,
  tx?: Prisma.TransactionClient,
): Promise<GoodsReceiptAttachment> {
  // `tx` is passed by the direct-upload finalize, which commits this row and its pending-upload
  // ledger removal together.
  return (tx ?? prisma).goodsReceiptAttachment.create({ data });
}
export function findAttachment(id: string): Promise<GoodsReceiptAttachment | null> {
  return prisma.goodsReceiptAttachment.findUnique({ where: { id } });
}
export function removeAttachment(id: string): Promise<GoodsReceiptAttachment> {
  return prisma.goodsReceiptAttachment.delete({ where: { id } });
}

// --- code allocation (atomic Counter, prefix "GRN") -----------------------------------------
const GRN_CODE_PREFIX = "GRN";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestGrnNumber(): Promise<number> {
  const head = `${GRN_CODE_PREFIX}-`;
  const rows = await prisma.goodsReceipt.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: GRN_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGrnNumber();
  try {
    await prisma.counter.create({ data: { key: GRN_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: GRN_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardCounter(): Promise<void> {
  const start = await highestGrnNumber();
  try {
    await prisma.counter.upsert({ where: { key: GRN_CODE_PREFIX }, create: { key: GRN_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort; the next nextSequence() increments anyway */
  }
}

// Create a GRN + its lines + serials + batches atomically with a unique GRN-#### code.
// deletedAt: null is written EXPLICITLY — Prisma+Mongo `{deletedAt:null}` reads don't match an
// absent field, so without this a freshly-created GRN would be invisible to findById/list.
export async function createWithCode(
  header: Omit<Prisma.GoodsReceiptUncheckedCreateInput, "code" | "items">,
  lines: GRNLineRow[],
): Promise<GoodsReceiptWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${GRN_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const grn = await tx.goodsReceipt.create({
          data: {
            deletedAt: null,
            ...header,
            code,
            items: { create: lines.map((l, i) => lineCreateData(l, i)) },
          },
        });
        return tx.goodsReceipt.findUniqueOrThrow({ where: { id: grn.id }, include: withRelations });
      });
    } catch (e) {
      // DB serial-uniqueness backstop → friendly 409 (a concurrent receipt grabbed the same serial).
      if (isSerialUniqueViolation(e)) throw conflict(SERIAL_CONFLICT_MSG);
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique goods-receipt code.");
}
