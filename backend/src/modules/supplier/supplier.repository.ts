import { Prisma, type Supplier } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Supplier master. The ONLY place Prisma is touched for
// suppliers. Soft-deleted suppliers (deletedAt set) are excluded from normal reads.

// The owner fields surfaced on a supplier read (a thin slice of User — never the whole
// record). jobTitle + role.name drive the "Name — Role" dropdown label.
const ownerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
  jobTitle: true,
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;

export type SupplierWithRelations = Supplier & {
  owner:
    | {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        status: string;
        jobTitle: string | null;
        role: { name: string } | null;
      }
    | null;
  supplierType: { id: string; name: string } | null;
};

const withRelations = {
  owner: { select: ownerSelect },
  supplierType: { select: { id: true, name: true } },
} satisfies Prisma.SupplierInclude;

export interface SupplierListFilters {
  search?: string;
  status?: string;
  typeId?: string;
}

function buildWhere(filters: SupplierListFilters): Prisma.SupplierWhereInput {
  const where: Prisma.SupplierWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.typeId) where.typeId = filters.typeId;
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { code: { contains: q, mode: "insensitive" } },
      { legalName: { contains: q, mode: "insensitive" } },
      { city: { contains: q, mode: "insensitive" } },
      { contactPerson: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

// Unknown/absent sort → newest first (default).
function supplierOrderBy(sort?: string): Prisma.SupplierOrderByWithRelationInput {
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
  filters: SupplierListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<SupplierWithRelations[]> {
  return prisma.supplier.findMany({
    where: buildWhere(filters),
    include: withRelations,
    orderBy: supplierOrderBy(sort),
    skip,
    take,
  });
}

export function count(filters: SupplierListFilters = {}): Promise<number> {
  return prisma.supplier.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<SupplierWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.supplier.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<SupplierWithRelations | null> {
  return prisma.supplier.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

// Unchecked update input so the service can set the scalar `ownerUserId` / `typeId` FKs
// directly (clear with null / assign an id) instead of going through relation
// connect/disconnect — simpler and avoids disconnect-on-null edge cases.
export function update(id: string, data: Prisma.SupplierUncheckedUpdateInput): Promise<SupplierWithRelations> {
  return prisma.supplier.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<Supplier> {
  return prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Active, non-deleted staff users for the owner picker (minimal slice, name-sorted).
// jobTitle + role.name feed the "Name — Role" dropdown label.
export function findOwnerOptions(): Promise<
  {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    jobTitle: string | null;
    role: { name: string } | null;
  }[]
> {
  return prisma.user.findMany({
    where: { status: "active", deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      jobTitle: true,
      role: { select: { name: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

// --- code allocation (atomic Counter, prefix "SUP") -------------------------
//
// Same mechanism as warehouseCode / customerCode / employeeId: a single $inc on one
// Counter row hands out gap-free, collision-free running numbers (SUP-0001, SUP-0002, …).
// The `code` @unique index is defence-in-depth; on the (otherwise impossible) out-of-band
// collision we fast-forward the counter past the real max and retry.

const SUPPLIER_CODE_PREFIX = "SUP";

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

// Highest numeric suffix currently used for the prefix (scanning ALL rows incl.
// soft-deleted — their codes still hold a slot in the unique index). Seeds the counter.
async function highestSupplierNumber(): Promise<number> {
  const head = `${SUPPLIER_CODE_PREFIX}-`;
  const rows = await prisma.supplier.findMany({
    where: { code: { startsWith: head } },
    select: { code: true },
  });
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
    const c = await prisma.counter.update({
      where: { key: SUPPLIER_CODE_PREFIX },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestSupplierNumber();
  try {
    await prisma.counter.create({ data: { key: SUPPLIER_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
  const c = await prisma.counter.update({
    where: { key: SUPPLIER_CODE_PREFIX },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestSupplierNumber();
  await prisma.counter.upsert({
    where: { key: SUPPLIER_CODE_PREFIX },
    create: { key: SUPPLIER_CODE_PREFIX, seq: max },
    update: { seq: max },
  });
}

// Create a supplier with a freshly-allocated, collision-safe code.
export async function createWithCode(
  data: Omit<Prisma.SupplierCreateInput, "code">,
): Promise<SupplierWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${SUPPLIER_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await prisma.supplier.create({
        data: { deletedAt: null, ...data, code },
        include: withRelations,
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique supplier code.");
}
