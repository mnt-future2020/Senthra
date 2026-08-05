import { Prisma, type JobKitRequest, type JobKitRequestLine } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// The ONLY place Prisma is touched for JobKitRequest records. Header + lines are written atomically;
// code allocation uses the same atomic Counter + retry mechanism as GM/ENG/JOB.

export type KitRequestWithLines = JobKitRequest & { lines: JobKitRequestLine[] };

export interface CreateKitRequestData {
  code: string;
  status: string;
  jobId: string;
  jobNumber: string;
  requestedByEngineerId: string;
  requestedByEngineerName: string;
  requestedByEngineerEmail: string | null;
  reason: string;
  notes?: string | null;
  attachments: string[];
  createdBy?: string | null;
}

export interface CreateKitRequestLineData {
  source: string;
  irmItemId?: string | null;
  customerStockEntryId?: string | null;
  itemName: string;
  sku?: string | null;
  uom?: string | null;
  qty: number;
}

// ---- Code allocation (JKR-####, atomic Counter + retry) -------------------------------------
const JKR_CODE_PREFIX = "JKR";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestJkrNumber(): Promise<number> {
  const head = `${JKR_CODE_PREFIX}-`;
  const rows = await prisma.jobKitRequest.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextJkrSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: JKR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestJkrNumber();
  try {
    await prisma.counter.create({ data: { key: JKR_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: JKR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardJkrCounter(): Promise<void> {
  const start = await highestJkrNumber();
  try {
    await prisma.counter.upsert({ where: { key: JKR_CODE_PREFIX }, create: { key: JKR_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort */
  }
}

export async function createKitRequest(data: CreateKitRequestData, lines: CreateKitRequestLineData[]): Promise<KitRequestWithLines> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextJkrSequence();
    const code = `${JKR_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const req = await tx.jobKitRequest.create({
          data: { deletedAt: null, ...data, code, lines: { create: lines } },
        });
        return tx.jobKitRequest.findUniqueOrThrow({ where: { id: req.id }, include: { lines: true } });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardJkrCounter();
    }
  }
  throw new Error("Could not allocate a unique kit-request code.");
}

// ---- Reads -----------------------------------------------------------------------------------
export function findById(id: string): Promise<KitRequestWithLines | null> {
  if (!id) return Promise.resolve(null);
  return prisma.jobKitRequest.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
}

function searchOr(s: string): Prisma.JobKitRequestWhereInput[] {
  const term = escapeRegex(s);
  return [
    { code: { contains: term, mode: "insensitive" } },
    { jobNumber: { contains: term, mode: "insensitive" } },
    { reason: { contains: term, mode: "insensitive" } },
    { requestedByEngineerName: { contains: term, mode: "insensitive" } },
  ];
}

function orderBy(sort?: string): Prisma.JobKitRequestOrderByWithRelationInput {
  return sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" };
}

export interface ListParams {
  status?: string;
  jobId?: string;
  engineerId?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export async function listRequests(params: ListParams = {}): Promise<{ requests: KitRequestWithLines[]; total: number }> {
  const { status, jobId, engineerId, search, sort, page = 1, pageSize = 20 } = params;
  const and: Prisma.JobKitRequestWhereInput[] = [{ deletedAt: null }];
  if (status) and.push({ status });
  if (jobId) and.push({ jobId });
  if (engineerId) and.push({ requestedByEngineerId: engineerId });
  if (search?.trim()) and.push({ OR: searchOr(search.trim()) });
  const where: Prisma.JobKitRequestWhereInput = { AND: and };
  const skip = (page - 1) * pageSize;
  const [requests, total] = await Promise.all([
    prisma.jobKitRequest.findMany({ where, include: { lines: true }, orderBy: orderBy(sort), skip, take: pageSize }),
    prisma.jobKitRequest.count({ where }),
  ]);
  return { requests, total };
}

// Count of pending requests (review-queue badge). Optionally scoped to one job.
export function countPending(jobId?: string): Promise<number> {
  return prisma.jobKitRequest.count({ where: { status: "pending", deletedAt: null, ...(jobId ? { jobId } : {}) } });
}

// Pending-request counts for many jobs in ONE query (jobs-list badge), keyed by jobId. Mirrors the
// goodsStatus/active-jobs batch pattern so the list never N+1s per row.
export async function countPendingByJobs(jobIds: string[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const rows = await prisma.jobKitRequest.groupBy({
    by: ["jobId"],
    where: { status: "pending", deletedAt: null, jobId: { in: jobIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.jobId, r._count._all]));
}

// ---- Atomic status transitions ---------------------------------------------------------------

// Claim a pending request for approval — flips pending → approved atomically so two concurrent
// approvals can't both grow the kit (the loser matches 0 rows). Returns the matched count.
export async function claimPending(id: string): Promise<number> {
  const res = await prisma.jobKitRequest.updateMany({ where: { id, status: "pending", deletedAt: null }, data: { status: "approved" } });
  return res.count;
}

// Roll a claimed (approved) request back to pending — used if the post-claim work fails, so the PM can
// retry cleanly instead of the request being stuck "approved" with nothing done.
export async function revertToPending(id: string): Promise<void> {
  await prisma.jobKitRequest.updateMany({ where: { id, status: "approved", deletedAt: null }, data: { status: "pending" } });
}

export interface LineSourcePatch {
  id: string;
  sourceType: string | null; // warehouse | engineer | null (misc)
  sourceEngineerId: string | null;
  sourceWarehouseId: string | null;
  /** What the reviewer approved. null = in full; 0 = the line was excluded. See the schema note. */
  approvedQty: number | null;
}

export interface FinalizeApprovalPatch {
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: Date;
  decisionNote: string | null;
  fulfillmentMode: string;
  transferId: string | null;
  transferIds: string[];
  // Where each line is actually sourced from — the authoritative detail behind fulfillmentMode.
  lineSources: LineSourcePatch[];
}

// Approve CHECKPOINT 1 (tx-aware) — stamp each request line with the JobKitLine it grew, INSIDE the
// kit-grow transaction (passed via appendKitFromRequest's stampTx), so the grow + stamp commit together.
// A retry after a crash sees the lines already stamped and SKIPS re-growing (no quantity inflation).
export async function stampLineKitIdsTx(tx: Prisma.TransactionClient, lineKitIds: { id: string; jobKitLineId: string | null }[]): Promise<void> {
  for (const u of lineKitIds) {
    if (u.jobKitLineId) await tx.jobKitRequestLine.update({ where: { id: u.id }, data: { jobKitLineId: u.jobKitLineId } });
  }
}

// Approve CHECKPOINT 2 (tx-aware) — persist the opened transfer's id INSIDE the transfer-creation
// transaction (via createTransfer's afterCreate), so the transfer + this checkpoint commit together.
// A retry then sees req.transferId set and reuses it instead of opening a SECOND transfer.
export async function setTransferIdTx(tx: Prisma.TransactionClient, id: string, transferId: string): Promise<void> {
  await tx.jobKitRequest.update({ where: { id }, data: { transferId } });
}

// Approve CHECKPOINT 2 (tx-aware, multi-source) — APPEND an opened transfer's id inside its own
// creation transaction. Mixed fulfilment opens one transfer per source engineer, so the checkpoint
// has to accumulate rather than overwrite: a crash between two transfers must leave the first one
// recorded. `push` is atomic in Mongo, so concurrent appends can't clobber each other. Also mirrors
// the first id into the legacy single `transferId` for readers that still use it.
export async function appendTransferIdTx(tx: Prisma.TransactionClient, id: string, transferId: string): Promise<void> {
  const current = await tx.jobKitRequest.findUnique({ where: { id }, select: { transferId: true } });
  await tx.jobKitRequest.update({
    where: { id },
    data: {
      transferIds: { push: transferId },
      ...(current?.transferId ? {} : { transferId }),
    },
  });
}

// Approve CHECKPOINT 3 — persist the review metadata + each line's resolved source. Line kit-id
// stamping and transfer ids are already checkpointed (stampLineKitIdsTx / appendTransferIdTx).
export async function finalizeApproval(id: string, patch: FinalizeApprovalPatch): Promise<KitRequestWithLines> {
  const { lineSources, ...header } = patch;
  for (const s of lineSources) {
    await prisma.jobKitRequestLine.update({
      where: { id: s.id },
      data: { sourceType: s.sourceType, sourceEngineerId: s.sourceEngineerId, sourceWarehouseId: s.sourceWarehouseId, approvedQty: s.approvedQty },
    });
  }
  return prisma.jobKitRequest.update({ where: { id }, data: header, include: { lines: true } });
}

export interface DeclinePatch {
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  decisionNote: string | null;
}

// Decline a pending request atomically (pending → declined). Returns the matched count.
export async function declinePending(id: string, patch: DeclinePatch): Promise<number> {
  const res = await prisma.jobKitRequest.updateMany({
    where: { id, status: "pending", deletedAt: null },
    data: { status: "declined", reviewedByUserId: patch.reviewedByUserId, reviewedByEmail: patch.reviewedByEmail, reviewedAt: new Date(), decisionNote: patch.decisionNote },
  });
  return res.count;
}

// Cancel a pending request atomically — only the original requester may cancel (guarded in the where).
export async function cancelPending(id: string, requesterId: string): Promise<number> {
  const res = await prisma.jobKitRequest.updateMany({
    where: { id, status: "pending", deletedAt: null, requestedByEngineerId: requesterId },
    data: { status: "cancelled" },
  });
  return res.count;
}

// --- Dashboard read-model — not a generic reporting API ---

/** Pending kit requests for the PM-review worklist. code = JKR-####; jobNumber = JOB-YYYY-#### (link target). */
export async function pendingWorklist(): Promise<Array<{ id: string; code: string; jobNumber: string; createdAt: Date }>> {
  const rows = await prisma.jobKitRequest.findMany({
    where: { status: "pending", deletedAt: null },
    select: { id: true, code: true, jobNumber: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50, // per-queue cap — oldest-first keeps the actionable head; the service re-caps the merge
  });
  return rows.map((r) => ({ id: r.id, code: r.code, jobNumber: r.jobNumber, createdAt: r.createdAt }));
}
