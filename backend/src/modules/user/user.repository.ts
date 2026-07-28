import { Prisma, type Role, type User } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

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
    const q = escapeRegex(filters.search);
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

// Every active (non-deleted) staff user with their role. Used to resolve
// notification recipients by permission (e.g. PO approvers) — callers filter on
// role.permissions in JS. The active-staff collection is small, so loading it whole
// is cheaper and simpler than a Mongo relation-filter query.
export function findActiveWithRole(): Promise<UserWithRole[]> {
  return prisma.user.findMany({
    where: { deletedAt: null, status: "active" },
    include: { role: true },
  });
}

export function findById(id: string): Promise<UserWithRole | null> {
  // Guard a nullish id: Prisma silently drops an `undefined` filter key, so
  // `findFirst({ where: { id: undefined, deletedAt: null } })` would otherwise
  // match the FIRST non-deleted user instead of returning null.
  if (!id) return Promise.resolve(null);
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
//
// The running number is handed out by an ATOMIC COUNTER (the `Counter` collection, one
// row per prefix) — the same mechanism databases use for sequences and apps use for
// invoice / order numbers. Each allocation is a single `$inc` on one document, so the
// database serializes concurrent creates and no two ever receive the same number: no
// retry needed, no collision, and no random fallback that would break the "-0007"
// format. On first use of a prefix the counter is seeded from the highest existing id
// for that prefix, so switching the prefix or hard-deleting users never reuses a number
// nor jumps onto an occupied one.
//
// The `employeeId` unique index on User stays as defence-in-depth. A number can only
// collide if an id was written OUT-OF-BAND above the counter (data import, manual fix,
// restored backup); we then fast-forward the counter past the real max and retry. We
// never fall back to a random id — on the (otherwise impossible) exhaustion we throw,
// so a bad state surfaces loudly instead of being papered over with an unreadable id.

// True for a unique-constraint violation on the employeeId index (the only User clash
// we retry). `meta.target` names the offending index; when the engine omits it (rare),
// treat it as employeeId — email is pre-checked before allocation, so employeeId is the
// only unique field set here whose clash is expected. A real concurrent email clash
// still carries `target: ["email"]`, so it's excluded and surfaces as a 409.
function isEmployeeIdConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return false;
  }
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("employeeId");
}

// P2025 — an `update` matched no row (here: this prefix has no counter yet).
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

// P2002 — a unique-constraint violation (here: a concurrent request seeded the counter
// for this prefix first).
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Highest numeric suffix currently used for `prefix` (e.g. "STR" → 12 for "STR-0012"),
// scanning ALL rows incl. soft-deleted (their IDs still hold a slot in the unique
// index, so the number must not be reused). Returns 0 when the prefix has no numbered
// IDs yet. Random-suffix legacy ids like "STR-E2C231" carry no number, so they're
// skipped — they never block or inflate the sequence. Used only to SEED / re-sync the
// counter, not on every allocation.
async function highestEmployeeNumber(prefix: string): Promise<number> {
  const head = `${prefix}-`;
  const rows = await prisma.user.findMany({
    where: { employeeId: { startsWith: head } },
    select: { employeeId: true },
  });
  let max = 0;
  for (const { employeeId } of rows) {
    const suffix = employeeId?.slice(head.length) ?? "";
    if (!/^\d+$/.test(suffix)) continue; // only purely-numeric suffixes count
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

// Atomically hand out the next number for `prefix`. Steady state is a single `$inc`.
// The first allocation for a brand-new prefix seeds the counter from the highest
// existing id, race-safely: a concurrent seeder just makes our create throw P2002 and
// we fall through to the same `$inc`.
async function nextSequence(prefix: string): Promise<number> {
  try {
    const c = await prisma.counter.update({
      where: { key: prefix },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e; // anything but "no counter yet" is a real error
  }
  // Seed at the current high-water mark so the first `$inc` below yields max + 1 (never
  // an occupied number); created STR-0012 → counter starts at 12 → first id is STR-0013.
  const start = await highestEmployeeNumber(prefix);
  try {
    await prisma.counter.create({ data: { key: prefix, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
  const c = await prisma.counter.update({
    where: { key: prefix },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return c.seq;
}

// Self-heal for the rare out-of-band collision: push the counter up to the real max so
// the next `$inc` clears every existing id. Best-effort — the allocation loop re-checks.
async function fastForwardCounter(prefix: string): Promise<void> {
  const max = await highestEmployeeNumber(prefix);
  await prisma.counter.upsert({
    where: { key: prefix },
    create: { key: prefix, seq: max },
    update: { seq: max },
  });
}

async function withEmployeeId<T>(
  prefix: string,
  write: (employeeId: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence(prefix);
    const employeeId = `${prefix}-${String(seq).padStart(4, "0")}`;
    try {
      return await write(employeeId);
    } catch (e) {
      if (!isEmployeeIdConflict(e)) throw e;
      // The counter handed out a live number → an id exists out-of-band above it.
      // Re-sync past the real max and retry. Never a random id.
      await fastForwardCounter(prefix);
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

// Ids of the live users holding a role. Used by the role-capability guard, which has to ask a
// question about the role's HOLDERS (do any still have van stock?) rather than about the role.
// `includeDeleted` exists for the stock-safety guards: a soft-deleted user's van stock is still on
// the books and still needs a holder that CAN hold it, so a guard asking "would this strand stock?"
// must see them. Excluding them would let the hazard through via delete-then-revoke.
export async function findIdsByRole(roleId: string, opts: { includeDeleted?: boolean } = {}): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: opts.includeDeleted ? { roleId } : { roleId, deletedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
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

// Cascade a job-title rename to EVERY user holding the old name (denormalized
// User.jobTitle). Same pattern as renameDepartment.
export function renameJobTitle(
  oldName: string,
  newName: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.user.updateMany({
    where: { jobTitle: oldName },
    data: { jobTitle: newName },
  });
}
