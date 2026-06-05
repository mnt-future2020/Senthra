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

export function deleteOthersForPrincipal(
  principalId: string,
  principalType: string,
  keepSid: string,
): Promise<Prisma.BatchPayload> {
  return prisma.session.deleteMany({
    where: { principalId, principalType, sid: { not: keepSid } },
  });
}
