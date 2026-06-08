import crypto from "node:crypto";

import { Prisma, type Role, type User } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

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

// Server-side ordering for the user list. Unknown/absent → newest first (default).
function userOrderBy(
  sort?: string,
): Prisma.UserOrderByWithRelationInput | Prisma.UserOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "name":
      return [{ firstName: "asc" }, { lastName: "asc" }];
    default:
      return { createdAt: "desc" };
  }
}

// One page of matching users. Pagination + ordering are done in the database
// (skip/take/orderBy) so the API never loads the whole collection.
export function findMany(
  filters: UserListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<UserWithRole[]> {
  return prisma.user.findMany({
    where: buildWhere(filters),
    include: { role: true },
    orderBy: userOrderBy(sort),
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

// Uniqueness check for auto-generated employee IDs (matches soft-deleted rows too,
// since employeeId is a unique index across every row).
export function findByEmployeeId(employeeId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { employeeId } });
}

// Lookup by the human employee reference (e.g. "STR-0007"), non-deleted, with role —
// used when a page routes by employeeId instead of the database id.
export function findByEmployeeIdWithRole(employeeId: string): Promise<UserWithRole | null> {
  return prisma.user.findFirst({
    where: { employeeId, deletedAt: null },
    include: { role: true },
  });
}

// Total user rows including soft-deleted — the base for the next employee-ID number.
export function countAll(): Promise<number> {
  return prisma.user.count();
}

// Login / forgot-password lookup: a non-deleted user by email, with role + auth
// fields. Does NOT filter by status — the caller checks it, so a suspended account
// can be messaged clearly (login) or silently skipped (reset email).
export function findByEmailWithRole(email: string): Promise<UserWithRole | null> {
  return prisma.user.findFirst({
    where: { email, deletedAt: null },
    include: { role: true },
  });
}

// Password-reset lookup (non-deleted), with role.
export function findByResetTokenHash(resetTokenHash: string): Promise<UserWithRole | null> {
  return prisma.user.findFirst({
    where: { resetTokenHash, deletedAt: null },
    include: { role: true },
  });
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

// --- Employee ID allocation -------------------------------------------------
//
// Auto-generate a unique, readable staff reference (e.g. "SNT-0007"). The `prefix`
// comes from settings (resolved by the caller) so it isn't hardcoded to one brand.
// The number tracks the total row count (soft-deleted rows included, so numbers are
// never reused). Generation is best-effort — the WRITE is what guarantees
// uniqueness: the create/update is retried against the `employeeId` unique index,
// so two concurrent creates that pick the same number can't both win (the DB
// rejects the second and we regenerate). A random suffix on the final attempt
// guarantees the loop terminates.

// A unique-constraint violation we should retry (regenerate the employeeId).
// `meta.target` names the offending index — when it points at employeeId, retry.
// When the engine omits target (rare), treat it as an employeeId clash too: email
// is already pre-checked before this allocation loop, so employeeId is the only
// unique field set here whose collision is expected. A real concurrent email clash
// still carries `target: ["email"]`, so it's excluded and surfaces as a 409.
function isEmployeeIdConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return false;
  }
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("employeeId");
}

async function withEmployeeId<T>(
  prefix: string,
  write: (employeeId: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    // Re-count each attempt: a retry means a concurrent create just committed, so a
    // fresh count steps past it instead of re-picking the same contended number.
    const base = await prisma.user.count();
    const employeeId =
      attempt < 5
        ? `${prefix}-${String(base + 1 + attempt).padStart(4, "0")}`
        : `${prefix}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    try {
      return await write(employeeId);
    } catch (e) {
      if (isEmployeeIdConflict(e)) continue; // a concurrent create took it — retry
      throw e;
    }
  }
  throw new Error("Could not allocate a unique employee ID.");
}

// Create a new user with a freshly-allocated, collision-safe employeeId.
export function createWithEmployeeId(
  data: Omit<Prisma.UserCreateInput, "employeeId">,
  prefix: string,
): Promise<UserWithRole> {
  return withEmployeeId(prefix, (employeeId) =>
    prisma.user.create({
      data: { deletedAt: null, ...data, employeeId },
      include: { role: true },
    }),
  );
}

// Revive (overwrite) a soft-deleted user, re-allocating a collision-safe employeeId.
export function reviveWithEmployeeId(
  id: string,
  data: Omit<Prisma.UserUpdateInput, "employeeId">,
  prefix: string,
): Promise<UserWithRole> {
  return withEmployeeId(prefix, (employeeId) =>
    prisma.user.update({
      where: { id },
      data: { ...data, employeeId },
      include: { role: true },
    }),
  );
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

// Cascade a department rename to EVERY user holding the old name (including
// soft-deleted ones). User.department is the denormalized department NAME, not a
// reference, so a rename must be written across all rows carrying the old value —
// otherwise existing staff keep the stale name. MongoDB has no FK cascade, so this
// is enforced in the application layer.
export function renameDepartment(
  oldName: string,
  newName: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.user.updateMany({
    where: { department: oldName },
    data: { department: newName },
  });
}
