import { Prisma, type IrmCategory } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the IrmCategory model. Mirrors supplier-type.repository.

export function findMany(): Promise<IrmCategory[]> {
  return prisma.irmCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<IrmCategory | null> {
  return prisma.irmCategory.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<IrmCategory | null> {
  return prisma.irmCategory.findUnique({ where: { key } });
}

export function findByName(name: string): Promise<IrmCategory | null> {
  return prisma.irmCategory.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

export function create(
  data: Omit<Prisma.IrmCategoryCreateInput, "nameLower">,
): Promise<IrmCategory> {
  return prisma.irmCategory.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.IrmCategoryUpdateInput): Promise<IrmCategory> {
  const patch: Prisma.IrmCategoryUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.irmCategory.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<IrmCategory> {
  return prisma.irmCategory.delete({ where: { id } });
}

// How many LIVE IRM items reference this category — the in-use guard for delete.
export function countItems(categoryId: string): Promise<number> {
  return prisma.irmItem.count({ where: { irmCategoryId: categoryId, deletedAt: null } });
}

export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function countItemsByCategoryMap(): Promise<Record<string, number>> {
  const groups = await prisma.irmItem.groupBy({
    by: ["irmCategoryId"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.irmCategoryId) map[g.irmCategoryId] = g._count._all;
  return map;
}
