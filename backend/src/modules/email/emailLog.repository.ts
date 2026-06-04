import type { EmailLog, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the EmailLog model (email delivery log).

export function create(data: Prisma.EmailLogCreateInput): Promise<EmailLog> {
  return prisma.emailLog.create({ data });
}

export function findRecent(limit = 100): Promise<EmailLog[]> {
  return prisma.emailLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

export function countByStatus(status: string): Promise<number> {
  return prisma.emailLog.count({ where: { status } });
}
