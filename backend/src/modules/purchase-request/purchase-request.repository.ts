import { Prisma, type PurchaseRequest, type PurchaseRequestAttachment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for Purchase Requests (PRF). The ONLY place Prisma is touched for PRFs.
// Soft-deleted PRFs (deletedAt set) are excluded from normal reads. Header + lines + totals are
// written atomically (withTransaction) so a PRF can never persist with stale totals or
// half-written lines. Mirrors purchase-order.repository throughout.

// Supplier slice for the read-only "Supplier Information" section (same slice as the PO's).
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
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
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

const jobSelect = { id: true, jobNumber: true, name: true, status: true } satisfies Prisma.JobSelect;

const withRelations = {
  supplier: { select: supplierSelect },
  warehouse: { select: warehouseSelect },
  job: { select: jobSelect },
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { irmItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  attachments: { orderBy: { createdAt: "asc" } },
  // The PO generated from this PRF (at most one — see the schema note) for the linked-PO
  // badge + procurement-chain strip.
  purchaseOrders: { select: { id: true, code: true, status: true } },
} satisfies Prisma.PurchaseRequestInclude;

export type PurchaseRequestWithRelations = Prisma.PurchaseRequestGetPayload<{ include: typeof withRelations }>;

// The scalar fields written to a line (snapshots + computed total).
export interface PrfLineRow {
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

export interface PrfTotals {
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
}

export interface PurchaseRequestListFilters {
  search?: string;
  status?: string;
  statuses?: string[];
  supplierId?: string;
  warehouseId?: string;
  jobId?: string;
  // Warehouse-access scope (from warehouseScopeFilter): `undefined` = unrestricted.
  warehouseIds?: string[];
}

// Exported for unit testing — pure where-clause builder, no Prisma I/O.
export function buildWhere(filters: PurchaseRequestListFilters): Prisma.PurchaseRequestWhereInput {
  const where: Prisma.PurchaseRequestWhereInput = { deletedAt: null };
  if (filters.statuses?.length) where.status = { in: filters.statuses };
  else if (filters.status) where.status = filters.status;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters.jobId) where.jobId = filters.jobId;
  if (filters.warehouseIds !== undefined) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { warehouseId: { in: filters.warehouseIds } }];
  }
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { quoteReference: { contains: q, mode: "insensitive" } },
      { projectRef: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.PurchaseRequestOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(
  filters: PurchaseRequestListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<PurchaseRequestWithRelations[]> {
  return prisma.purchaseRequest.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}

export function count(filters: PurchaseRequestListFilters = {}): Promise<number> {
  return prisma.purchaseRequest.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<PurchaseRequestWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.purchaseRequest.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<PurchaseRequestWithRelations | null> {
  return prisma.purchaseRequest.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

// Generic header update — used by the workflow actions (status/timestamps/actor). NEVER used to
// change lines; line edits go through replaceItemsAndTotals.
export function update(id: string, data: Prisma.PurchaseRequestUncheckedUpdateInput): Promise<PurchaseRequestWithRelations> {
  return prisma.purchaseRequest.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<PurchaseRequest> {
  return prisma.purchaseRequest.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Replace ALL line rows + recompute the header totals, atomically (draft edit).
export async function replaceItemsAndTotals(
  prfId: string,
  lines: PrfLineRow[],
  totals: PrfTotals,
  headerPatch: Prisma.PurchaseRequestUncheckedUpdateInput,
): Promise<PurchaseRequestWithRelations> {
  return withTransaction(async (tx) => {
    await tx.purchaseRequestItem.deleteMany({ where: { purchaseRequestId: prfId } });
    if (lines.length) await tx.purchaseRequestItem.createMany({ data: lines.map((l) => ({ purchaseRequestId: prfId, ...l })) });
    await tx.purchaseRequest.update({ where: { id: prfId }, data: { ...headerPatch, ...totals } });
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id: prfId }, include: withRelations });
  });
}

// --- delete-guard counters (used by Supplier / Warehouse delete guards) ----------------------
export function countBySupplier(supplierId: string): Promise<number> {
  return prisma.purchaseRequest.count({ where: { supplierId, deletedAt: null } });
}
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.purchaseRequest.count({ where: { warehouseId, deletedAt: null } });
}

// --- convert seam (tx-aware; called only from the PRF-conversion transaction) ----------------
// Re-read the PRF INSIDE the transaction so the status guard + copied lines/attachments can't
// race a concurrent edit or a second convert click (both would see `converted` and fail).
export function findForConvertTx(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseRequest.findFirst({
    where: { id, deletedAt: null },
    include: { items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }, attachments: true },
  });
}
export function setConvertedTx(tx: Prisma.TransactionClient, id: string, updatedBy: string | null) {
  return tx.purchaseRequest.update({
    where: { id },
    data: { status: "converted", convertedAt: new Date(), updatedBy },
  });
}

// --- attachments ----------------------------------------------------------------------------
export function addAttachment(data: Prisma.PurchaseRequestAttachmentUncheckedCreateInput): Promise<PurchaseRequestAttachment> {
  return prisma.purchaseRequestAttachment.create({ data });
}
export function findAttachment(id: string): Promise<PurchaseRequestAttachment | null> {
  return prisma.purchaseRequestAttachment.findUnique({ where: { id } });
}
export function removeAttachment(id: string): Promise<PurchaseRequestAttachment> {
  return prisma.purchaseRequestAttachment.delete({ where: { id } });
}

// --- code allocation (atomic Counter, prefix "PRF") ------------------------------------------
const PRF_CODE_PREFIX = "PRF";

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

async function highestPrfNumber(): Promise<number> {
  const head = `${PRF_CODE_PREFIX}-`;
  const rows = await prisma.purchaseRequest.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
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
    const c = await prisma.counter.update({ where: { key: PRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestPrfNumber();
  try {
    await prisma.counter.create({ data: { key: PRF_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({ where: { key: PRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestPrfNumber();
  await prisma.counter.upsert({ where: { key: PRF_CODE_PREFIX }, create: { key: PRF_CODE_PREFIX, seq: max }, update: { seq: max } });
}

// Create a PRF (header + lines + totals) atomically with a freshly-allocated, collision-safe code.
export async function createWithCode(
  header: Omit<Prisma.PurchaseRequestUncheckedCreateInput, "code">,
  lines: PrfLineRow[],
): Promise<PurchaseRequestWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${PRF_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        // Persist deletedAt as an explicit null (not absent) — Prisma+Mongo's `{ deletedAt: null }`
        // read filter does NOT match documents where the field is missing. Mirrors poRepo.createWithCode.
        const prf = await tx.purchaseRequest.create({ data: { deletedAt: null, ...header, code } });
        if (lines.length) await tx.purchaseRequestItem.createMany({ data: lines.map((l) => ({ purchaseRequestId: prf.id, ...l })) });
        return tx.purchaseRequest.findUniqueOrThrow({ where: { id: prf.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique purchase-request code.");
}
