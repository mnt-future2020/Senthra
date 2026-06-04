import type { Prisma, Role, User } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

// Data-access layer for the User model. The ONLY place Prisma is touched for
// users. Soft-deleted users (deletedAt set) are excluded from normal reads.

export type UserWithRole = User & { role: Role | null };

export interface UserListFilters {
  search?: string;
  status?: string;
  roleId?: string;
}

function buildWhere(filters: UserListFilters): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.roleId) where.roleId = filters.roleId;
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

// One page of matching users (most-recent first). Pagination is done in the
// database (skip/take) so the API never loads the whole collection.
export function findMany(
  filters: UserListFilters = {},
  skip = 0,
  take = 20,
): Promise<UserWithRole[]> {
  return prisma.user.findMany({
    where: buildWhere(filters),
    include: { role: true },
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });
}

// Total matching users (for the page count), using the same filters.
export function count(filters: UserListFilters = {}): Promise<number> {
  return prisma.user.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<UserWithRole | null> {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: { role: true },
  });
}

// Unique-email guard: matches even soft-deleted rows, since the email still
// occupies the unique index. The service decides how to message a clash.
export function findByEmailIncludingDeleted(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function create(data: Prisma.UserCreateInput): Promise<UserWithRole> {
  // Always persist deletedAt as an explicit null (not an absent field). MongoDB
  // treats a missing field differently from null, so without this the
  // `{ deletedAt: null }` "active" filters would skip freshly-created users.
  return prisma.user.create({ data: { deletedAt: null, ...data }, include: { role: true } });
}

export function update(id: string, data: Prisma.UserUpdateInput): Promise<UserWithRole> {
  return prisma.user.update({ where: { id }, data, include: { role: true } });
}

export function softDelete(id: string): Promise<User> {
  return prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Count active (non-deleted) users assigned a given role — used to guard role
// deletion.
export function countByRole(roleId: string): Promise<number> {
  return prisma.user.count({ where: { roleId, deletedAt: null } });
}

// Active user counts grouped by role, as a { roleId: count } map. One query for
// the whole roles list (avoids an N+1 of per-role counts).
export async function countByRoleMap(): Promise<Record<string, number>> {
  const groups = await prisma.user.groupBy({
    by: ["roleId"],
    where: { deletedAt: null, roleId: { not: null } },
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.roleId) map[g.roleId] = g._count._all;
  return map;
}

// Detach a role from EVERY user that references it (including soft-deleted ones),
// so deleting the role never leaves a dangling roleId. MongoDB has no FK cascade,
// so this is enforced in the application layer.
export function clearRole(roleId: string): Promise<Prisma.BatchPayload> {
  return prisma.user.updateMany({ where: { roleId }, data: { roleId: null } });
}
