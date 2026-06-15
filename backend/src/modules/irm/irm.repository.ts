import { Prisma, type IrmItem } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// Data-access layer for the IRM Catalogue. The ONLY place Prisma is touched for IRM items.
// Soft-deleted items (deletedAt set) are excluded from normal reads — BUT the SKU
// uniqueness lookup deliberately scans them too (SKUs are reserved forever).

const ownerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
  jobTitle: true,
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;

type SupplierLink = {
  id: string;
  supplierId: string;
  isPrimary: boolean;
  priority: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
  supplier: { id: string; code: string; name: string; status: string };
};

export type IrmItemWithRelations = IrmItem & {
  irmType: { id: string; name: string } | null;
  irmCategory: { id: string; name: string } | null;
  owner:
    | { id: string; firstName: string; lastName: string; email: string; status: string; jobTitle: string | null; role: { name: string } | null }
    | null;
  suppliers: SupplierLink[];
};

const withRelations = {
  irmType: { select: { id: true, name: true } },
  irmCategory: { select: { id: true, name: true } },
  owner: { select: ownerSelect },
  suppliers: {
    orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
    select: {
      id: true,
      supplierId: true,
      isPrimary: true,
      priority: true,
      supplierSku: true,
      leadTimeDays: true,
      supplier: { select: { id: true, code: true, name: true, status: true } },
    },
  },
} satisfies Prisma.IrmItemInclude;

export interface IrmListFilters {
  search?: string;
  status?: string;
  typeId?: string;
  categoryId?: string;
  supplierId?: string;
}

function buildWhere(filters: IrmListFilters): Prisma.IrmItemWhereInput {
  const where: Prisma.IrmItemWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.typeId) where.typeId = filters.typeId;
  if (filters.categoryId) where.irmCategoryId = filters.categoryId;
  if (filters.supplierId) where.suppliers = { some: { supplierId: filters.supplierId } };
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { code: { contains: q, mode: "insensitive" } },
      { sku: { contains: q, mode: "insensitive" } },
      { brand: { contains: q, mode: "insensitive" } },
      { mpn: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function irmOrderBy(sort?: string): Prisma.IrmItemOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "name":
      return { name: "asc" };
    case "code":
      return { code: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(
  filters: IrmListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<IrmItemWithRelations[]> {
  return prisma.irmItem.findMany({
    where: buildWhere(filters),
    include: withRelations,
    orderBy: irmOrderBy(sort),
    skip,
    take,
  });
}

export function count(filters: IrmListFilters = {}): Promise<number> {
  return prisma.irmItem.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<IrmItemWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.irmItem.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<IrmItemWithRelations | null> {
  return prisma.irmItem.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

// SKU uniqueness lookup — scans ALL rows INCLUDING soft-deleted, so a SKU that has ever
// existed can never be reused. Returns the owning item id (to exclude self on update).
export function findBySkuLower(skuLower: string): Promise<{ id: string } | null> {
  return prisma.irmItem.findFirst({ where: { skuLower }, select: { id: true } });
}

// Enforce GLOBAL-FOREVER SKU uniqueness at the database with a PARTIAL unique index.
// Prisma can't express partial/sparse indexes for MongoDB — a plain `@unique` on an optional
// field creates a NON-sparse index that rejects a SECOND null, and most items have no SKU
// (prisma/prisma#23870) — so we create the index directly. Only documents whose `skuLower`
// is a string are indexed: unlimited null/absent SKUs are allowed, while real SKUs stay
// unique across EVERY row (incl. soft-deleted — the index spans the whole collection).
// Idempotent: createIndexes is a no-op once an identical index exists, so it is safe to run
// on every boot (called from the seed/migration step).
export async function ensureSkuUniqueIndex(): Promise<void> {
  await prisma.$runCommandRaw({
    createIndexes: "IrmItem",
    indexes: [
      {
        key: { skuLower: 1 },
        name: "IrmItem_skuLower_unique",
        unique: true,
        partialFilterExpression: { skuLower: { $type: "string" } },
      },
    ],
  });
}

export function update(id: string, data: Prisma.IrmItemUncheckedUpdateInput): Promise<IrmItemWithRelations> {
  return prisma.irmItem.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<IrmItem> {
  return prisma.irmItem.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Active staff users for the owner picker (minimal slice, name-sorted).
export function findOwnerOptions(): Promise<
  { id: string; firstName: string; lastName: string; email: string; jobTitle: string | null; role: { name: string } | null }[]
> {
  return prisma.user.findMany({
    where: { status: "active", deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, role: { select: { name: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

// Replace ALL supplier-junction rows for an item (delete + recreate), atomically. Wrapped in
// a transaction so a failure mid-reconcile can never leave the item with ZERO suppliers (it
// rolls back to the prior set); the @@unique([irmItemId, supplierId]) guards dupes. Caller
// (the service) guarantees the new set is ≥1 row with exactly one primary.
export interface SupplierLinkRow {
  supplierId: string;
  isPrimary: boolean;
  priority: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
}
export async function replaceSuppliers(irmItemId: string, rows: SupplierLinkRow[]): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.irmItemSupplier.deleteMany({ where: { irmItemId } });
    if (rows.length) {
      await tx.irmItemSupplier.createMany({ data: rows.map((r) => ({ irmItemId, ...r })) });
    }
  });
}

// --- code allocation (atomic Counter, prefix "IRM") -------------------------
const IRM_CODE_PREFIX = "IRM";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

// True for a unique-constraint violation (P2002) on the skuLower partial index — the
// defence-in-depth that catches a concurrent racing write the app-level pre-check missed.
// `code` conflicts are retried and resolved inside createWithCode, so any P2002 that reaches
// the service from a create/update is the SKU index; `meta.target` is matched leniently
// (index name or field path) and a missing target is treated as the SKU clash.
export function isSkuConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).toLowerCase().includes("sku");
}
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

async function highestIrmNumber(): Promise<number> {
  const head = `${IRM_CODE_PREFIX}-`;
  const rows = await prisma.irmItem.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
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
    const c = await prisma.counter.update({ where: { key: IRM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestIrmNumber();
  try {
    await prisma.counter.create({ data: { key: IRM_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({ where: { key: IRM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestIrmNumber();
  await prisma.counter.upsert({ where: { key: IRM_CODE_PREFIX }, create: { key: IRM_CODE_PREFIX, seq: max }, update: { seq: max } });
}

// Create an item with a freshly-allocated, collision-safe code (suppliers added separately).
export async function createWithCode(
  data: Omit<Prisma.IrmItemCreateInput, "code">,
): Promise<IrmItemWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${IRM_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await prisma.irmItem.create({ data: { deletedAt: null, ...data, code }, include: withRelations });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique IRM code.");
}
