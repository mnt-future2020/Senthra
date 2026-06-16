import { Prisma, type PurchaseOrder, type PurchaseOrderAttachment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// Data-access layer for Purchase Orders. The ONLY place Prisma is touched for POs. Soft-deleted
// POs (deletedAt set) are excluded from normal reads. Header + lines + totals are written
// atomically (withTransaction) so a PO can never persist with stale totals or half-written lines.

// Supplier slice for the read-only "Supplier Information" section.
const supplierSelect = {
  id: true,
  code: true,
  name: true,
  contactPerson: true,
  contactEmail: true,
  contactPhone: true,
  paymentTerms: true,
  customPaymentTerms: true,
  currency: true,
  leadTimeDays: true,
} satisfies Prisma.SupplierSelect;

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

const withRelations = {
  supplier: { select: supplierSelect },
  warehouse: { select: warehouseSelect },
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { irmItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  attachments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.PurchaseOrderInclude;

export type PurchaseOrderWithRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof withRelations }>;

// The scalar fields written to a line (snapshots + computed total; receivedQuantity defaults 0).
export interface PoLineRow {
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  unitPricePence: number;
  vatRate: number;
  lineTotalPence: number;
  sortOrder: number;
  notes: string | null;
}

export interface PoTotals {
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
}

export interface PurchaseOrderListFilters {
  search?: string;
  status?: string;
  priority?: string;
  supplierId?: string;
  warehouseId?: string;
}

function buildWhere(filters: PurchaseOrderListFilters): Prisma.PurchaseOrderWhereInput {
  const where: Prisma.PurchaseOrderWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.priority) where.priority = filters.priority;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { referenceNumber: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.PurchaseOrderOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    case "expected":
      return { expectedDeliveryDate: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(
  filters: PurchaseOrderListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<PurchaseOrderWithRelations[]> {
  return prisma.purchaseOrder.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}

export function count(filters: PurchaseOrderListFilters = {}): Promise<number> {
  return prisma.purchaseOrder.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<PurchaseOrderWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<PurchaseOrderWithRelations | null> {
  return prisma.purchaseOrder.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

// Generic header update — used by the workflow actions (status/timestamps/actor). NEVER used to
// change lines; line edits go through replaceItemsAndTotals.
export function update(id: string, data: Prisma.PurchaseOrderUncheckedUpdateInput): Promise<PurchaseOrderWithRelations> {
  return prisma.purchaseOrder.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<PurchaseOrder> {
  return prisma.purchaseOrder.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Replace ALL line rows + recompute the header totals, atomically (draft edit).
export async function replaceItemsAndTotals(
  poId: string,
  lines: PoLineRow[],
  totals: PoTotals,
  headerPatch: Prisma.PurchaseOrderUncheckedUpdateInput,
): Promise<PurchaseOrderWithRelations> {
  return withTransaction(async (tx) => {
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: poId } });
    if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: poId, ...l })) });
    await tx.purchaseOrder.update({ where: { id: poId }, data: { ...headerPatch, ...totals } });
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: withRelations });
  });
}

// --- delete-guard counters (used by Supplier / Warehouse / IRM delete guards) ----------------
export function countBySupplier(supplierId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: { supplierId, deletedAt: null } });
}
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: { warehouseId, deletedAt: null } });
}
export function countByIrmItem(irmItemId: string): Promise<number> {
  return prisma.purchaseOrderItem.count({ where: { irmItemId, purchaseOrder: { is: { deletedAt: null } } } });
}

// --- attachments ----------------------------------------------------------------------------
export function addAttachment(data: Prisma.PurchaseOrderAttachmentUncheckedCreateInput): Promise<PurchaseOrderAttachment> {
  return prisma.purchaseOrderAttachment.create({ data });
}
export function findAttachment(id: string): Promise<PurchaseOrderAttachment | null> {
  return prisma.purchaseOrderAttachment.findUnique({ where: { id } });
}
export function removeAttachment(id: string): Promise<PurchaseOrderAttachment> {
  return prisma.purchaseOrderAttachment.delete({ where: { id } });
}

// --- code allocation (atomic Counter, prefix "PO") ------------------------------------------
const PO_CODE_PREFIX = "PO";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

async function highestPoNumber(): Promise<number> {
  const head = `${PO_CODE_PREFIX}-`;
  const rows = await prisma.purchaseOrder.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
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
    const c = await prisma.counter.update({ where: { key: PO_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestPoNumber();
  try {
    await prisma.counter.create({ data: { key: PO_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({ where: { key: PO_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestPoNumber();
  await prisma.counter.upsert({ where: { key: PO_CODE_PREFIX }, create: { key: PO_CODE_PREFIX, seq: max }, update: { seq: max } });
}

// Create a PO (header + lines + totals) atomically with a freshly-allocated, collision-safe code.
export async function createWithCode(
  header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">,
  lines: PoLineRow[],
): Promise<PurchaseOrderWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${PO_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        // Persist deletedAt as an explicit null (not absent): Prisma+Mongo's `{ deletedAt: null }`
        // read filter does NOT match documents where the field is missing, so without this every
        // freshly-created PO would be invisible to findById/findByCode/list/the delete-guard counts.
        // Mirrors supplierRepo.createWithCode.
        const po = await tx.purchaseOrder.create({ data: { deletedAt: null, ...header, code } });
        if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
        return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique purchase-order code.");
}
