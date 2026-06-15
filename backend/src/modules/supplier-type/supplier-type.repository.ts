import { Prisma, type SupplierType } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the SupplierType model. Mirrors warehouse-type.repository: the
// `nameLower` mirror is derived here so it can never drift from the display name.

export function findMany(): Promise<SupplierType[]> {
  return prisma.supplierType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<SupplierType | null> {
  return prisma.supplierType.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<SupplierType | null> {
  return prisma.supplierType.findUnique({ where: { key } });
}

// Case-insensitive lookup off the `nameLower` unique index — the polite pre-check.
export function findByName(name: string): Promise<SupplierType | null> {
  return prisma.supplierType.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

export function create(
  data: Omit<Prisma.SupplierTypeCreateInput, "nameLower">,
): Promise<SupplierType> {
  return prisma.supplierType.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.SupplierTypeUpdateInput): Promise<SupplierType> {
  const patch: Prisma.SupplierTypeUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.supplierType.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<SupplierType> {
  return prisma.supplierType.delete({ where: { id } });
}

// How many LIVE suppliers reference this type — the in-use guard for delete.
export function countSuppliers(typeId: string): Promise<number> {
  return prisma.supplier.count({ where: { typeId, deletedAt: null } });
}

// True when a write hit a unique index (P2002) — the `nameLower` name guard or `key`.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Grouped supplier counts per type (avoids per-type N+1 in the list).
export async function countSuppliersByTypeMap(): Promise<Record<string, number>> {
  const groups = await prisma.supplier.groupBy({
    by: ["typeId"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.typeId) map[g.typeId] = g._count._all;
  return map;
}
