import { Prisma, type WarehouseType } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the WarehouseType model. Mirrors category.repository: the
// `nameLower` mirror is derived here so it can never drift from the display name.

export function findMany(): Promise<WarehouseType[]> {
  return prisma.warehouseType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<WarehouseType | null> {
  return prisma.warehouseType.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<WarehouseType | null> {
  return prisma.warehouseType.findUnique({ where: { key } });
}

// Case-insensitive lookup off the `nameLower` unique index — the polite pre-check.
export function findByName(name: string): Promise<WarehouseType | null> {
  return prisma.warehouseType.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

export function create(
  data: Omit<Prisma.WarehouseTypeCreateInput, "nameLower">,
): Promise<WarehouseType> {
  return prisma.warehouseType.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.WarehouseTypeUpdateInput): Promise<WarehouseType> {
  const patch: Prisma.WarehouseTypeUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.warehouseType.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<WarehouseType> {
  return prisma.warehouseType.delete({ where: { id } });
}

// How many LIVE warehouses reference this type — the in-use guard for delete.
export function countWarehouses(typeId: string): Promise<number> {
  return prisma.warehouse.count({ where: { typeId, deletedAt: null } });
}

// True when a write hit a unique index (P2002) — the `nameLower` name guard or `key`.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Grouped warehouse counts per type (avoids per-type N+1 in the list).
export async function countWarehousesByTypeMap(): Promise<Record<string, number>> {
  const groups = await prisma.warehouse.groupBy({
    by: ["typeId"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.typeId) map[g.typeId] = g._count._all;
  return map;
}
