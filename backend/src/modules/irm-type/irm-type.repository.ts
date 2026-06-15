import { Prisma, type IrmType } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the IrmType model. Mirrors supplier-type.repository: the
// `nameLower` mirror is derived here so it can never drift from the display name.

export function findMany(): Promise<IrmType[]> {
  return prisma.irmType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<IrmType | null> {
  return prisma.irmType.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<IrmType | null> {
  return prisma.irmType.findUnique({ where: { key } });
}

// Case-insensitive lookup off the `nameLower` unique index — the polite pre-check.
export function findByName(name: string): Promise<IrmType | null> {
  return prisma.irmType.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

export function create(data: Omit<Prisma.IrmTypeCreateInput, "nameLower">): Promise<IrmType> {
  return prisma.irmType.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.IrmTypeUpdateInput): Promise<IrmType> {
  const patch: Prisma.IrmTypeUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.irmType.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<IrmType> {
  return prisma.irmType.delete({ where: { id } });
}

// How many LIVE IRM items reference this type — the in-use guard for delete.
export function countItems(typeId: string): Promise<number> {
  return prisma.irmItem.count({ where: { typeId, deletedAt: null } });
}

// True when a write hit a unique index (P2002) — the `nameLower` name guard or `key`.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Grouped item counts per type (avoids per-type N+1 in the list).
export async function countItemsByTypeMap(): Promise<Record<string, number>> {
  const groups = await prisma.irmItem.groupBy({
    by: ["typeId"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.typeId) map[g.typeId] = g._count._all;
  return map;
}
