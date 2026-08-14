import { Prisma, type Warehouse } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for the Warehouse master. The ONLY place Prisma is touched for
// warehouses. Soft-deleted warehouses (deletedAt set) are excluded from normal reads.

// NOTE: a warehouse has no manager column. Who manages it is derived from the user→warehouse
// assignments made under Users & Roles — see userWarehouseRepo.listManagersForWarehouses.
export type WarehouseWithRelations = Warehouse & {
  warehouseType: { id: string; name: string } | null;
};

const withRelations = {
  warehouseType: { select: { id: true, name: true } },
} satisfies Prisma.WarehouseInclude;

export interface WarehouseListFilters {
  search?: string;
  status?: string;
  typeId?: string;
  // Warehouse-access scope: when present, restrict to exactly these ids (a warehouse-scoped user's
  // assigned set). `undefined` = unrestricted. An empty array correctly matches nothing.
  ids?: string[];
}

function buildWhere(filters: WarehouseListFilters): Prisma.WarehouseWhereInput {
  const where: Prisma.WarehouseWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.typeId) where.typeId = filters.typeId;
  if (filters.ids !== undefined) where.id = { in: filters.ids };
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { code: { contains: q, mode: "insensitive" } },
      { city: { contains: q, mode: "insensitive" } },
      { contactPerson: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

// Unknown/absent sort → newest first (default).
function warehouseOrderBy(sort?: string): Prisma.WarehouseOrderByWithRelationInput {
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
  filters: WarehouseListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<WarehouseWithRelations[]> {
  return prisma.warehouse.findMany({
    where: buildWhere(filters),
    include: withRelations,
    orderBy: warehouseOrderBy(sort),
    skip,
    take,
  });
}

export function count(filters: WarehouseListFilters = {}): Promise<number> {
  return prisma.warehouse.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<WarehouseWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.warehouse.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<WarehouseWithRelations | null> {
  return prisma.warehouse.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

/**
 * Just the URL segment for one warehouse. Warehouse routes are keyed by CODE, not id, so the
 * attention service needs this to turn a single-warehouse scope into a deep link — and it runs on the
 * badge path, where pulling the type, managers and address relations `findById` includes would be
 * paid on every page load for nothing.
 */
export async function findCodeById(id: string): Promise<string | null> {
  if (!id) return null;
  const row = await prisma.warehouse.findFirst({ where: { id, deletedAt: null }, select: { code: true } });
  return row?.code ?? null;
}

// Ids of warehouses with no type assigned yet (incl. soft-deleted — they still hold a
// row). Used once by the seed backfill to give every warehouse a fallback type so
// `typeId` can be the single source of truth.
export function findIdsMissingType(): Promise<{ id: string }[]> {
  // `typeId: null` alone matches only an EXPLICIT null, and a warehouse created before the type
  // became mandatory has the field ABSENT — exactly the rows this backfill exists to find, and the
  // ones it would have skipped. No user-facing count depends on it, but a migration helper that
  // quietly does nothing is the worst kind: it reports success.
  return prisma.warehouse.findMany({
    where: { OR: [{ typeId: null }, { typeId: { isSet: false } }] },
    select: { id: true },
  });
}

// The ACTIVE, non-deleted warehouses among `ids` (id only). Used to validate user→warehouse
// assignments: any requested id NOT returned here is inactive, soft-deleted or non-existent.
export function findActiveByIds(ids: string[]): Promise<{ id: string }[]> {
  if (!ids.length) return Promise.resolve([]);
  return prisma.warehouse.findMany({
    where: { id: { in: ids }, status: "active", deletedAt: null },
    select: { id: true },
  });
}

// Lean active-warehouse options for a picker (id/code/name only), code-sorted. A trimmed list
// instead of paging the full warehouse records. `ids` scopes the result to a warehouse-scoped
// user's assigned set (undefined = unrestricted).
export function findOptions(ids?: string[]): Promise<{ id: string; code: string; name: string }[]> {
  const where: Prisma.WarehouseWhereInput = { status: "active", deletedAt: null };
  if (ids !== undefined) where.id = { in: ids };
  return prisma.warehouse.findMany({
    where,
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
}

// Unchecked update input so the service can set scalar FKs (e.g. `typeId`) directly
// instead of going through relation connect/disconnect — simpler and avoids
// disconnect-on-null edge cases.
export function update(id: string, data: Prisma.WarehouseUncheckedUpdateInput): Promise<WarehouseWithRelations> {
  return prisma.warehouse.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<Warehouse> {
  return prisma.warehouse.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Clear isDefault on every OTHER warehouse — used to enforce a single default. Only
// touches live rows; soft-deleted ones keep their flag (irrelevant once excluded).
export function unsetDefaultExcept(exceptId: string): Promise<Prisma.BatchPayload> {
  return prisma.warehouse.updateMany({
    where: { isDefault: true, deletedAt: null, id: { not: exceptId } },
    data: { isDefault: false },
  });
}

// Active, non-deleted FIELD ENGINEERS for the job/dispatch engineer picker — only users whose role
// grants the field-operations stock-holding capability (canHoldStock). Minimal slice, name-sorted;
// the role filter is what keeps admins / finance / warehouse managers out of the "assign an
// engineer" dropdowns. Mirrors the canHoldStock gate the job services enforce.
export function findEngineerOptions(): Promise<
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
    where: { status: "active", deletedAt: null, role: { is: { canHoldStock: true } } },
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

// --- code allocation (atomic Counter, prefix "WH") --------------------------
//
// Same mechanism as customerCode / employeeId: a single $inc on one Counter row hands
// out gap-free, collision-free running numbers (WH-0001, WH-0002, …). The `code`
// @unique index is defence-in-depth; on the (otherwise impossible) out-of-band
// collision we fast-forward the counter past the real max and retry.

const WAREHOUSE_CODE_PREFIX = "WH";

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
async function highestWarehouseNumber(): Promise<number> {
  const head = `${WAREHOUSE_CODE_PREFIX}-`;
  const rows = await prisma.warehouse.findMany({
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
      where: { key: WAREHOUSE_CODE_PREFIX },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestWarehouseNumber();
  try {
    await prisma.counter.create({ data: { key: WAREHOUSE_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
  const c = await prisma.counter.update({
    where: { key: WAREHOUSE_CODE_PREFIX },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestWarehouseNumber();
  await prisma.counter.upsert({
    where: { key: WAREHOUSE_CODE_PREFIX },
    create: { key: WAREHOUSE_CODE_PREFIX, seq: max },
    update: { seq: max },
  });
}

// Create a warehouse with a freshly-allocated, collision-safe code.
export async function createWithCode(
  data: Omit<Prisma.WarehouseCreateInput, "code">,
): Promise<WarehouseWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${WAREHOUSE_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await prisma.warehouse.create({
        data: { deletedAt: null, ...data, code },
        include: withRelations,
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique warehouse code.");
}
