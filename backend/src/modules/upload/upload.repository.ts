import type { Prisma, PendingUpload } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

/**
 * The pending-upload ledger. Rows live for seconds and describe an asset nobody has taken delivery of.
 *
 * Every claim goes through a CONDITIONAL UPDATE whose affected-row count decides the winner. That is
 * the whole concurrency mechanism: finalize and the reaper race for the same row, and exactly one of
 * them can win, because the update's own `where` clause is the test.
 */

export function create(data: Prisma.PendingUploadUncheckedCreateInput): Promise<PendingUpload> {
  return prisma.pendingUpload.create({ data });
}

export function findByPublicId(publicId: string): Promise<PendingUpload | null> {
  return prisma.pendingUpload.findUnique({ where: { publicId } });
}

/**
 * Take the lease, or lose the race. Returns the expiry it set — the caller's PROOF of holding it —
 * and null for the caller that lost.
 *
 * Free when the lease is null (nobody has held it) or in the past (whoever held it never came back).
 * A caller that crashes leaves its lease behind, and the expiry is what returns the row to the pool —
 * a plain boolean "claimed" flag would keep it marked busy forever, and the reaper, which skips busy
 * rows, would never reclaim the asset.
 */
export async function claim(publicId: string, leaseMs: number, tx?: Prisma.TransactionClient): Promise<Date | null> {
  const now = new Date();
  const client = tx ?? prisma;
  const claimExpiresAt = new Date(now.getTime() + leaseMs);
  const res = await client.pendingUpload.updateMany({
    where: {
      publicId,
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { isSet: false } }, { claimExpiresAt: { lt: now } }],
    },
    data: { claimExpiresAt },
  });
  return res.count === 1 ? claimExpiresAt : null;
}

/**
 * Extend a lease this caller already holds. Returns false if it does not still hold it.
 *
 * Finalize needs this INSIDE its write transaction, so that "the lease is still mine" and "the
 * attachment is written" are one commit and a reaper cannot destroy the asset in between.
 *
 * It cannot use `claim` for that: claim's test is "the lease is FREE", and finalize's own live lease
 * fails it — the caller would be blocked by itself, which is precisely how every attach-mode upload
 * came to end in a conflict. The test here is "the lease is still the exact one I was given". Only the
 * holder knows that value, and anyone who took the row since — a reaper, a second finalize — would
 * have written their own expiry over it, so a stale holder correctly fails.
 */
export async function renew(
  publicId: string,
  held: Date,
  leaseMs: number,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const res = await (tx ?? prisma).pendingUpload.updateMany({
    where: { publicId, claimExpiresAt: held },
    data: { claimExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return res.count === 1;
}

/**
 * Stamp the finalized asset's URL and file metadata onto its ledger row (`deferred-attach` only).
 *
 * The row is minted at signature time, when none of this is known yet. Recording it at finalize is
 * what lets a save that holds nothing but the URL rebuild the whole attachment — identity included.
 */
export function stampAsset(
  publicId: string,
  data: { url: string; fileName: string; fileType: string; fileSizeBytes: number },
): Promise<PendingUpload> {
  return prisma.pendingUpload.update({ where: { publicId }, data });
}

/**
 * The ledger row an unattached URL belongs to, or null.
 *
 * `url` is unique, so this is an exact identity lookup rather than a guess — which is the whole
 * reason the column exists. Parsing a publicId back out of a Cloudinary URL is the alternative, and
 * it is how you destroy the wrong file.
 *
 * `findFirst`, not `findUnique`: the uniqueness lives in a PARTIAL index (see
 * ensurePendingUploadUrlUniqueIndex) rather than a Prisma `@unique`, so the client does not offer
 * `url` as a unique selector. The guarantee is the same — the index still rejects a duplicate url.
 */
export function findByUrl(url: string): Promise<PendingUpload | null> {
  return prisma.pendingUpload.findFirst({ where: { url } });
}

/**
 * Enforce url uniqueness at the database with a PARTIAL unique index.
 *
 * A plain `@unique` on this optional column is NOT usable: Prisma renders it as a non-sparse unique
 * index on MongoDB, where null is an indexed value (prisma/prisma#23870). Every row here is minted
 * at SIGNATURE time with no url — url is only stamped at finalize, and only for `deferred-attach` —
 * so the second url-less row in flight is rejected with a duplicate-key error. That is not a corner
 * case: it takes down direct browser uploads for the whole app, and one abandoned upload leaves a
 * url-less row sitting there for the full 24 h reaper window.
 *
 * Indexing only documents whose `url` is a string allows unlimited url-less rows while keeping real
 * urls unique — which is what the lookup above depends on to be an identity rather than a guess.
 * It also gives findByUrl an index instead of a collection scan.
 *
 * Idempotent: createIndexes is a no-op once an identical index exists, so it is safe on every boot.
 */
export async function ensurePendingUploadUrlUniqueIndex(): Promise<void> {
  await prisma.$runCommandRaw({
    createIndexes: "PendingUpload",
    indexes: [
      {
        key: { url: 1 },
        name: "PendingUpload_url_unique",
        unique: true,
        partialFilterExpression: { url: { $type: "string" } },
      },
    ],
  });
}

export function remove(publicId: string, tx?: Prisma.TransactionClient): Promise<{ count: number }> {
  return (tx ?? prisma).pendingUpload.deleteMany({ where: { publicId } });
}

/**
 * Rows the reaper may consider: old enough that the browser is never coming back, and not held by a
 * live lease. It still has to WIN the claim before destroying anything — this only narrows the set.
 */
export function findReapable(olderThan: Date, take: number): Promise<PendingUpload[]> {
  const now = new Date();
  return prisma.pendingUpload.findMany({
    where: {
      createdAt: { lt: olderThan },
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { isSet: false } }, { claimExpiresAt: { lt: now } }],
    },
    take,
    orderBy: { createdAt: "asc" },
  });
}
