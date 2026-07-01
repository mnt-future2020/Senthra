import type { AuditLog, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for the AuditLog model (immutable audit trail). The ONLY
// place Prisma is touched for audit entries.

export interface AuditListFilters {
  search?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
}

function buildWhere(filters: AuditListFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.action) where.action = filters.action;
  if (filters.actorType) where.actorType = filters.actorType;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  }
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { actorEmail: { contains: q, mode: "insensitive" } },
      { targetLabel: { contains: q, mode: "insensitive" } },
      { targetId: { contains: q, mode: "insensitive" } },
      { action: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export function create(data: Prisma.AuditLogCreateInput): Promise<AuditLog> {
  return prisma.auditLog.create({ data });
}

// One page of matching entries, newest first.
export function findMany(
  filters: AuditListFilters = {},
  skip = 0,
  take = 25,
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });
}

export function count(filters: AuditListFilters = {}): Promise<number> {
  return prisma.auditLog.count({ where: buildWhere(filters) });
}

// All matching entries up to `take` (the export cap), newest first. A single
// bounded query keeps it memory-safe; if the cap ever needs to grow past what's
// comfortable to hold in memory, switch this to a cursor-paged loop — callers
// won't change.
export function findForExport(
  filters: AuditListFilters = {},
  take = 50_000,
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    take,
  });
}

// Distinct action keys present in the log, ascending — feeds the UI's action
// filter dropdown so it only offers values that actually exist.
export async function distinctActions(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}

// Distinct actor types actually present (admin | user | customer | system). The
// UI offers only these, so a value no event ever produces (e.g. "system" until
// system-generated events exist) never shows as a dead filter option.
export async function distinctActorTypes(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    distinct: ["actorType"],
    select: { actorType: true },
    orderBy: { actorType: "asc" },
  });
  return rows.map((r) => r.actorType);
}

// Distinct target types present (customer | role | user | email_template | …),
// nulls excluded — feeds the "domain" filter so entries can be narrowed by which
// entity they concern.
export async function distinctTargetTypes(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { targetType: { not: null } },
    distinct: ["targetType"],
    select: { targetType: true },
    orderBy: { targetType: "asc" },
  });
  return rows.flatMap((r) => (r.targetType ? [r.targetType] : []));
}
