import { Prisma, type Category } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Category model.

export function findMany(): Promise<Category[]> {
  return prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { key } });
}

// Case-insensitive lookup, served straight off the `nameLower` unique index — the
// polite pre-check before a write. The @unique index is the real guard.
export function findByName(name: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

// `nameLower` is derived from the display `name` here so the two can never drift out
// of sync — the lowercased mirror is always written alongside whatever name we store.
export function create(data: Omit<Prisma.CategoryCreateInput, "nameLower">): Promise<Category> {
  return prisma.category.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.CategoryUpdateInput): Promise<Category> {
  const patch: Prisma.CategoryUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.category.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<Category> {
  return prisma.category.delete({ where: { id } });
}

// How many stock entries reference this category — the in-use guard for delete.
export function countItems(categoryId: string): Promise<number> {
  return prisma.customerStockEntry.count({ where: { categoryId } });
}

// True when a write failed because a unique index rejected a duplicate (P2002) —
// the `nameLower` name guard or the `key` slug. The service turns this into the same
// friendly 409 as the pre-check, so a name that slips past the pre-check under a
// concurrent write still gets a clean message instead of a raw Prisma 500.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Grouped item counts for all categories at once (avoids per-category N+1 in the list).
export async function countItemsByCategoryMap(): Promise<Record<string, number>> {
  const groups = await prisma.customerStockEntry.groupBy({
    by: ["categoryId"],
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.categoryId) map[g.categoryId] = g._count._all;
  return map;
}
