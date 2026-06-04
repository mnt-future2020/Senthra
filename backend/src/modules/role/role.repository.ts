import type { Prisma, Role } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Role model.

export function findMany(): Promise<Role[]> {
  return prisma.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<Role | null> {
  return prisma.role.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<Role | null> {
  return prisma.role.findUnique({ where: { key } });
}

// Case-insensitive lookup by display name — used to enforce name uniqueness
// (the `name` column itself isn't a unique index).
export function findByName(name: string): Promise<Role | null> {
  return prisma.role.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
}

export function create(data: Prisma.RoleCreateInput): Promise<Role> {
  return prisma.role.create({ data });
}

export function update(id: string, data: Prisma.RoleUpdateInput): Promise<Role> {
  return prisma.role.update({ where: { id }, data });
}

export function remove(id: string): Promise<Role> {
  return prisma.role.delete({ where: { id } });
}

export function count(): Promise<number> {
  return prisma.role.count();
}

// Idempotent seed helper. Creates the role if its key is missing; on an existing
// row it reconciles only the code-owned fields passed in `update` (name,
// sortOrder) so default changes ship to existing installs, while admin-editable
// fields (description) are left untouched.
export function upsertByKey(
  key: string,
  create: Prisma.RoleCreateInput,
  update: Prisma.RoleUpdateInput = {},
): Promise<Role> {
  return prisma.role.upsert({ where: { key }, update, create });
}
