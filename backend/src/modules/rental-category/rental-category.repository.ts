import { Prisma, type RentalCategory } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the RentalCategory model. Mirrors irm-category.repository — the rental
// taxonomy is deliberately its own master, not a share of IrmCategory (see the design spec §2.2).

export function findMany(): Promise<RentalCategory[]> {
  return prisma.rentalCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<RentalCategory | null> {
  return prisma.rentalCategory.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<RentalCategory | null> {
  return prisma.rentalCategory.findUnique({ where: { key } });
}

export function findByName(name: string): Promise<RentalCategory | null> {
  return prisma.rentalCategory.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

export function create(
  data: Omit<Prisma.RentalCategoryCreateInput, "nameLower">,
): Promise<RentalCategory> {
  return prisma.rentalCategory.create({ data: { ...data, nameLower: data.name.toLowerCase() } });
}

export function update(id: string, data: Prisma.RentalCategoryUpdateInput): Promise<RentalCategory> {
  const patch: Prisma.RentalCategoryUpdateInput = { ...data };
  if (typeof patch.name === "string") patch.nameLower = patch.name.toLowerCase();
  return prisma.rentalCategory.update({ where: { id }, data: patch });
}

export function remove(id: string): Promise<RentalCategory> {
  return prisma.rentalCategory.delete({ where: { id } });
}

// A soft-deleted item is invisible here too. Both arms are required: on MongoDB a row whose create
// omitted `deletedAt` does not match `{ deletedAt: null }`, and an undercount here would let a
// category in use be deleted.
const LIVE = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } satisfies Prisma.RentalItemWhereInput;

// How many LIVE rental items reference this category — the in-use guard for delete.
export function countItems(categoryId: string): Promise<number> {
  return prisma.rentalItem.count({ where: { rentalCategoryId: categoryId, ...LIVE } });
}

export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function countItemsByCategoryMap(): Promise<Record<string, number>> {
  const groups = await prisma.rentalItem.groupBy({
    by: ["rentalCategoryId"],
    where: LIVE,
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.rentalCategoryId) map[g.rentalCategoryId] = g._count._all;
  return map;
}
