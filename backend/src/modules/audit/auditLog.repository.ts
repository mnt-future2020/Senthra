import type { AuditLog, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the AuditLog model (immutable audit trail).

export function create(data: Prisma.AuditLogCreateInput): Promise<AuditLog> {
  return prisma.auditLog.create({ data });
}

export function findRecent(limit = 100): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}
