import type { Prisma, Session } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Session model (one row per signed-in device).

export function create(data: Prisma.SessionCreateInput): Promise<Session> {
  return prisma.session.create({ data });
}

export function findBySid(sid: string): Promise<Session | null> {
  return prisma.session.findUnique({ where: { sid } });
}

// A principal's sessions, most-recently-used first.
export function findForPrincipal(
  principalId: string,
  principalType: string,
): Promise<Session[]> {
  return prisma.session.findMany({
    where: { principalId, principalType },
    orderBy: { lastUsedAt: "desc" },
  });
}

export function touch(sid: string): Promise<Session> {
  return prisma.session.update({ where: { sid }, data: { lastUsedAt: new Date() } });
}

export function deleteBySid(sid: string): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({ where: { sid } });
}

export function deleteManyBySids(sids: string[]): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({ where: { sid: { in: sids } } });
}

export function deleteAllForPrincipal(
  principalId: string,
  principalType: string,
): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({ where: { principalId, principalType } });
}

/**
 * Drop every session whose `expiresAt` has passed.
 *
 * These rows are ALREADY dead to the application: `findActive` treats an elapsed `expiresAt` as no
 * session at all (and deletes the row it happened to touch), and `startSession` excludes them from
 * the device cap. So this can never reach a live session — it removes rows the app already refuses
 * to honour, and whose only remaining content is the device's IP address and user-agent.
 *
 * It exists because that pruning is LAZY: a row is only reconsidered when someone presents its sid
 * again, or when the same principal signs in. A device that never comes back — a lost phone, a
 * decommissioned laptop, someone who left — leaves its row, and its IP, in the database forever.
 */
export function deleteExpired(now: Date): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
}

export function deleteOthersForPrincipal(
  principalId: string,
  principalType: string,
  keepSid: string,
): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({
    where: { principalId, principalType, sid: { not: keepSid } },
  });
}
