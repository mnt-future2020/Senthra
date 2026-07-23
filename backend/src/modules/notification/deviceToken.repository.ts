import { prisma } from "../../lib/prisma.js";

// The only place DeviceToken rows are touched. A token is globally unique, so
// registering it under a (possibly new) user is an upsert keyed on the token.

export function upsert(token: string, userId: string, platform: string) {
  return prisma.deviceToken.upsert({
    where: { token },
    create: { token, userId, platform },
    update: { userId, platform, lastSeenAt: new Date() },
  });
}

export function remove(token: string) {
  return prisma.deviceToken.deleteMany({ where: { token } });
}

export async function tokensForUser(userId: string): Promise<string[]> {
  const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
  return rows.map((r) => r.token);
}

export function removeMany(tokens: string[]) {
  if (tokens.length === 0) return Promise.resolve(null);
  return prisma.deviceToken.deleteMany({ where: { token: { in: tokens } } });
}
