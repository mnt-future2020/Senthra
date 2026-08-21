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

/**
 * Drop every device registered to one user.
 *
 * For accounts that can no longer authenticate — soft-deleted, inactive or suspended. `requireAuth`
 * refuses all three (findById excludes soft-deleted rows; a non-active status is rejected outright),
 * so these tokens cannot be reached by a legitimate session and only sit in the fan-out set waiting
 * for FCM to eventually report them dead.
 *
 * Safe against re-activation: the app re-registers on every principal change, not only at login
 * (mobile usePushNotifications), so a reinstated user's device re-appears on their next signed-in
 * launch. Nothing here removes a token belonging to an account that can still sign in.
 */
export function removeAllForUser(userId: string) {
  return prisma.deviceToken.deleteMany({ where: { userId } });
}

export function removeMany(tokens: string[]) {
  if (tokens.length === 0) return Promise.resolve(null);
  return prisma.deviceToken.deleteMany({ where: { token: { in: tokens } } });
}
