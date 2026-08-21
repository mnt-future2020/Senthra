import type { Prisma, PolicyDocument, PolicyVersion } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the two policy models. The ONLY place Prisma is touched for policies.
//
// Note which reads exist and which do not: there is a lookup for a PUBLISHED version by id, and one
// for the document (draft included). There is deliberately NO "find the document for the public
// endpoint" helper — the public path resolves through `findPublishedVersion`, which reads
// PolicyVersion and cannot return draft text whatever it is passed.

export const PRIVACY_POLICY_KEY = "privacy_policy";

// --- document (draft side) ----------------------------------------------------------------------

export function findDocument(key: string): Promise<PolicyDocument | null> {
  return prisma.policyDocument.findUnique({ where: { key } });
}

/**
 * Create the document row if it is not already there. Used by the seed, which runs on every boot.
 *
 * `update: {}` on purpose: an upsert that wrote anything would reset a live draft on restart. The
 * only job here is existence.
 *
 * Reports whether it INSERTED, so the seed can say what it actually did. The preceding read exists
 * only to answer that: the upsert below is unchanged and still runs either way, so this adds a
 * question, not a write. `createdAt === updatedAt` was the obvious-looking alternative and is wrong
 * — `update: {}` never touches the row, so those two stay equal for the life of the document and
 * every boot would report a fresh insert.
 *
 * The read cannot be folded into the upsert: Prisma does not report which branch an upsert took.
 * If two instances boot simultaneously and both miss the read, both log a creation while the unique
 * index still guarantees ONE row — a duplicated log line in a rare race, and nothing more.
 */
export async function ensureDocument(
  key: string,
): Promise<{ document: PolicyDocument; created: boolean }> {
  const existing = await prisma.policyDocument.findUnique({ where: { key } });
  const document = await prisma.policyDocument.upsert({
    where: { key },
    create: { key, draftBody: "" },
    update: {},
  });
  return { document, created: existing === null };
}

/**
 * Save the draft, but only if nobody has changed it since the editor loaded it.
 *
 * One conditional updateMany, evaluated atomically by Mongo — the same guard the rest of the app
 * uses for state that two requests can converge on. A count of 0 means the revision moved under us:
 * someone else saved, and overwriting their work silently is exactly what this prevents. It is a
 * 409 to the caller, never a retry.
 */
export async function saveDraftIfUnchanged(
  key: string,
  expectedRevision: number,
  body: string,
  updatedBy: string | null,
): Promise<number> {
  const res = await prisma.policyDocument.updateMany({
    where: { key, draftRevision: expectedRevision },
    data: {
      draftBody: body,
      draftUpdatedAt: new Date(),
      draftUpdatedBy: updatedBy,
      draftRevision: { increment: 1 },
    },
  });
  return res.count;
}

// --- publish (transactional) --------------------------------------------------------------------

/** Read inside the publish transaction, so the revision guard and the version allocation see one snapshot. */
export function findDocumentTx(tx: Prisma.TransactionClient, key: string): Promise<PolicyDocument | null> {
  return tx.policyDocument.findUnique({ where: { key } });
}

export function createVersionTx(
  tx: Prisma.TransactionClient,
  data: {
    documentKey: string;
    version: number;
    body: string;
    publishedById: string | null;
    publishedBy: string | null;
  },
): Promise<PolicyVersion> {
  return tx.policyVersion.create({ data });
}

/**
 * Point the document at the version just created and record the number handed out.
 *
 * Writes the SAME row the transaction already read, which is what makes two concurrent publishes
 * collide: Mongo aborts the loser with P2034 and `withTransactionRetry` replays it against the
 * committed state, where it either allocates the next number or fails the revision guard.
 */
export function setPublishedVersionTx(
  tx: Prisma.TransactionClient,
  key: string,
  versionId: string,
  version: number,
): Promise<PolicyDocument> {
  return tx.policyDocument.update({
    where: { key },
    data: { publishedVersionId: versionId, lastPublishedVersion: version },
  });
}

// --- versions (published side) ------------------------------------------------------------------

export function findVersionById(id: string): Promise<PolicyVersion | null> {
  if (!id) return Promise.resolve(null);
  return prisma.policyVersion.findUnique({ where: { id } });
}

/**
 * The published version a public reader should see, resolved from the document's pointer.
 *
 * Two queries rather than a relation join, and the second one reads PolicyVersion — so this can only
 * ever return published text. A document with a null pointer returns null, which is the "nothing
 * published" answer; it never falls back to `draftBody`.
 */
export async function findPublishedVersion(key: string): Promise<PolicyVersion | null> {
  const doc = await prisma.policyDocument.findUnique({
    where: { key },
    select: { publishedVersionId: true },
  });
  if (!doc?.publishedVersionId) return null;
  return prisma.policyVersion.findUnique({ where: { id: doc.publishedVersionId } });
}

/** Published history, newest first. Bounded — the admin screen lists, it does not page. */
export function listVersions(documentKey: string, take = 50): Promise<PolicyVersion[]> {
  return prisma.policyVersion.findMany({
    where: { documentKey },
    orderBy: { publishedAt: "desc" },
    take,
  });
}
