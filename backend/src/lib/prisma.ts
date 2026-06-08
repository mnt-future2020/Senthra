import { Prisma, PrismaClient } from "@prisma/client";

import { isProduction } from "../config/env.js";

// Reuse a single PrismaClient across hot reloads / module imports in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

// Run a group of writes atomically (all-or-nothing) in one transaction: every repo
// call made with the provided `tx` client commits together or rolls back together.
// On MongoDB this needs a replica set — which every Atlas cluster is — so if the
// deployment ever didn't support it, this fails loudly rather than silently skipping
// atomicity.
export function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn);
}
