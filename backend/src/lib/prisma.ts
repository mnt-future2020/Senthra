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

// A TRANSIENT MongoDB write-conflict: two transactions wrote the same document and Mongo aborted the
// loser. Prisma surfaces it as P2034. Nothing is wrong with the losing request — it lost a race — so
// the right answer is to run it again against the now-committed state, not to fail it.
export function isWriteConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

// `withTransaction` plus an automatic replay when Mongo aborts the transaction for a write-conflict.
//
// Reach for this wherever concurrent requests DELIBERATELY converge on one document — a shared
// counter, or a parent row whose status is derived from its children. Those designs rely on the
// conflict: without a common document to collide on, two transactions each read a snapshot taken
// before the other's write, and both derive a parent state from children they can't see, leaving the
// parent wrong with nothing left to re-trigger the calculation. Colliding turns that silent, permanent
// wrong answer into a retry that reads the committed truth.
//
// `fn` MUST be safe to run more than once: an aborted transaction rolled every one of its writes
// back, so a replay starts from the same state the first attempt saw — but anything `fn` does
// OUTSIDE the transaction (audit records, emails) would repeat. Keep those after the call.
export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; attempts?: number },
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTransaction(fn, options);
    } catch (e) {
      // Out of attempts, or a real failure (validation, guard, not-found) that replaying won't fix.
      if (i === attempts - 1 || !isWriteConflict(e)) throw e;
    }
  }
  // Unreachable: the final attempt either returns or throws above.
  throw new Error("withTransactionRetry: exhausted attempts");
}
