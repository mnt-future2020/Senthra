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
//
// The `timeout`/`maxWait` are raised well above Prisma's 5s default. When the app server is close to
// the database a legitimate multi-write transaction (engineer-transfer completion, goods issue/return)
// finishes in well under a second — but a HIGH-LATENCY link (e.g. a dev machine → a remote Atlas
// cluster, ~0.5s per round-trip × ~10 writes) can push it just past 5s and Mongo aborts a perfectly
// valid transaction. These are ceilings, not delays: they don't slow the fast path, they only stop
// network latency alone from killing a valid commit. Callers can override per-transaction.
export function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return prisma.$transaction(fn, { maxWait: options?.maxWait ?? 10_000, timeout: options?.timeout ?? 20_000 });
}
