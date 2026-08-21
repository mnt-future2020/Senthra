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

/**
 * Delete delivery-log rows created before `cutoff`.
 *
 * ## Not wired up yet, on purpose
 *
 * Nothing calls this. There is no timer, no route and no start-up hook — because the retention
 * PERIOD is a business/legal decision that has not been taken, and this file is not the place to
 * invent one. When it is taken, the caller supplies the cutoff.
 *
 * `cutoff` is a REQUIRED argument with no default for exactly that reason: there is no way to call
 * this and accidentally get a period nobody agreed to. A default here would become the policy.
 *
 * ## Why the model can be purged at all
 *
 * EmailLog is write-only. `create` is called from the send path; `findRecent` and `countByStatus`
 * have no callers anywhere in the application — no route, no controller, no dashboard read. Sending,
 * templating, delivery-status handling and the rental-reminder retry path never read a row back.
 * Deleting old rows therefore removes stored recipient addresses without changing any behaviour.
 */
export function deleteOlderThan(cutoff: Date): Promise<Prisma.BatchPayload> {
  return prisma.emailLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
