import { Prisma, type VanStockRequest, type VanStockRequestLine, type VanStockFulfilment, type VanStockFulfilmentLine } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict, notFound } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";

// The ONLY place Prisma is touched for the four VanStock* models. Code allocation copies the JKR
// atomic Counter + retry mechanism; the posting transaction mirrors GM's createMovementWithCode.

export type FulfilmentWithLines = VanStockFulfilment & { lines: VanStockFulfilmentLine[] };
export type RequestWithLines = VanStockRequest & { lines: VanStockRequestLine[]; fulfilments: FulfilmentWithLines[] };

const INCLUDE = { lines: true, fulfilments: { include: { lines: true }, orderBy: { sequence: "asc" as const } } };

// ── Canonical line math — the SINGLE SOURCE OF TRUTH for "how much is left" and "is this line done".
// Every cap, remaining-qty, and status-recompute MUST use these (posting, scan-lookup, close-short,
// approve). Re-implementing the arithmetic inline is what caused the closedShortQty over-issue and the
// stuck-partially_fulfilled bugs — do NOT inline it again.
type LineMath = { approvedQty: number | null; requestedQty: number; fulfilledQty: number; closedShortQty: number | null };
export function lineRemaining(l: LineMath): number {
  return (l.approvedQty ?? l.requestedQty) - l.fulfilledQty - (l.closedShortQty ?? 0);
}
export function lineDone(l: LineMath): boolean {
  if (l.approvedQty === 0) return true; // excluded at approval — never holds the request open
  return lineRemaining(l) <= 0;
}
export function linesAllDone(lines: LineMath[]): boolean {
  return lines.every(lineDone);
}

export interface CreateRequestData {
  code: string;
  type: string;
  status: string;
  priority: string;
  createdVia: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId?: string | null;
  preferredWarehouseName?: string | null;
  preferredWarehouseCode?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  warehouseCode?: string | null;
  reason: string;
  notes?: string | null;
  attachments: string[];
  reviewedByUserId?: string | null;
  reviewedByEmail?: string | null;
  reviewedAt?: Date | null;
  createdBy?: string | null;
}

export interface CreateRequestLineData {
  irmItemId: string;
  itemName: string;
  code?: string | null;
  sku?: string | null;
  uom?: string | null;
  requestedQty: number;
  approvedQty?: number | null;
  // Single-warehouse flows (walk-in, returns) set the source at create; restock requests set it on approve.
  sourceWarehouseId?: string | null;
  sourceWarehouseName?: string | null;
  sourceWarehouseCode?: string | null;
}

// ---- Code allocation (VSR-####) — identical mechanism to JKR ----------------------------------
const VSR_CODE_PREFIX = "VSR";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

// PERF (known, deferred — not hot): scans every VSR code to compute a max in JS. Only reached on a
// counter miss/P2002 conflict, so it's off the normal create path; at ~100k requests it'd be a 100k-doc
// read. An `orderBy: { code: "desc" }, take: 1` would replace it, but the zero-padded code sorts
// lexicographically only while the suffix width is fixed — so that swap needs a width-change plan.
// Inherited verbatim from JKR's allocator; fix both together or neither.
async function highestVsrNumber(): Promise<number> {
  const head = `${VSR_CODE_PREFIX}-`;
  const rows = await prisma.vanStockRequest.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextVsrSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: VSR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestVsrNumber();
  try {
    await prisma.counter.create({ data: { key: VSR_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: VSR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardVsrCounter(): Promise<void> {
  const start = await highestVsrNumber();
  try {
    await prisma.counter.upsert({ where: { key: VSR_CODE_PREFIX }, create: { key: VSR_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort */
  }
}

export async function createRequest(data: CreateRequestData, lines: CreateRequestLineData[]): Promise<RequestWithLines> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextVsrSequence();
    const code = `${VSR_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const req = await tx.vanStockRequest.create({
          data: { deletedAt: null, ...data, code, lines: { create: lines } },
        });
        return tx.vanStockRequest.findUniqueOrThrow({ where: { id: req.id }, include: INCLUDE });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardVsrCounter();
    }
  }
  throw new Error("Could not allocate a unique van-stock-request code.");
}

// ---- Reads -----------------------------------------------------------------------------------
export function findById(id: string): Promise<RequestWithLines | null> {
  if (!id) return Promise.resolve(null);
  return prisma.vanStockRequest.findFirst({ where: { id, deletedAt: null }, include: INCLUDE });
}

function searchOr(s: string): Prisma.VanStockRequestWhereInput[] {
  const term = escapeRegex(s);
  return [
    { code: { contains: term, mode: "insensitive" } },
    { reason: { contains: term, mode: "insensitive" } },
    { engineerName: { contains: term, mode: "insensitive" } },
    { warehouseName: { contains: term, mode: "insensitive" } },
  ];
}

// A request "belongs to" warehouse X when: (returns/walk-in) its final warehouseId is X; (pending
// restock) the engineer's collection (preferred) warehouse is X; (approved/partial restock) ANY line
// is sourced to X. The last arm makes a split restock appear in every involved warehouse's queue.
export function belongsToWarehouses(ids: string[]): Prisma.VanStockRequestWhereInput {
  return {
    OR: [
      { warehouseId: { in: ids } },
      { AND: [{ status: "pending" }, { preferredWarehouseId: { in: ids } }] },
      { lines: { some: { sourceWarehouseId: { in: ids } } } },
    ],
  };
}

export interface ListParams {
  status?: string;
  type?: string;
  engineerId?: string;
  priority?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  // One warehouse's queue (the warehouse-detail tab): final warehouse = X, or pending preferring X.
  warehouseId?: string;
  // Reviewer scoping (same ownership rule over the actor's assigned warehouses). undefined ⇒ unrestricted.
  warehouseScope?: string[];
}

export async function listRequests(params: ListParams = {}): Promise<{ requests: RequestWithLines[]; total: number }> {
  const { status, type, engineerId, priority, search, sort, page = 1, pageSize = 20, warehouseId, warehouseScope } = params;
  const and: Prisma.VanStockRequestWhereInput[] = [{ deletedAt: null }];
  if (status) and.push({ status });
  if (type) and.push({ type });
  if (engineerId) and.push({ engineerId });
  if (priority) and.push({ priority });
  if (search?.trim()) and.push({ OR: searchOr(search.trim()) });
  if (warehouseId) and.push(belongsToWarehouses([warehouseId]));
  if (warehouseScope) and.push(belongsToWarehouses(warehouseScope));
  const where: Prisma.VanStockRequestWhereInput = { AND: and };
  const skip = (page - 1) * pageSize;
  const [requests, total] = await Promise.all([
    prisma.vanStockRequest.findMany({ where, include: INCLUDE, orderBy: sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" }, skip, take: pageSize }),
    prisma.vanStockRequest.count({ where }),
  ]);
  return { requests, total };
}

export function countPending(warehouseScope?: string[]): Promise<number> {
  return prisma.vanStockRequest.count({
    where: { AND: [{ status: "pending", deletedAt: null }, ...(warehouseScope ? [belongsToWarehouses(warehouseScope)] : [])] },
  });
}

// Open (pending/approved/partially_fulfilled) line items for one engineer + type — powers the
// non-blocking duplicate warning in the composer.
export async function findOpenLineItems(engineerId: string, type: string): Promise<Array<{ irmItemId: string; code: string }>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { engineerId, type, deletedAt: null, status: { in: ["pending", "approved", "partially_fulfilled"] } },
    select: { code: true, lines: { select: { irmItemId: true } } },
  });
  return rows.flatMap((r) => r.lines.map((l) => ({ irmItemId: l.irmItemId, code: r.code })));
}

// ---- Atomic transitions ------------------------------------------------------------------------

export interface ApprovalPatch {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  decisionNote: string | null;
}

// Approve (restock): flip pending → approved atomically, then stamp the warehouse + per-line
// approvedQty AND source warehouse in the SAME transaction. Loser of a concurrent approve matches
// 0 rows → conflict.
export async function claimPendingForApproval(
  id: string,
  patch: ApprovalPatch,
  lineApprovals: Array<{ lineId: string; approvedQty: number; sourceWarehouseId: string | null; sourceWarehouseName: string | null; sourceWarehouseCode: string | null }>,
): Promise<RequestWithLines> {
  return withTransaction(async (tx) => {
    const res = await tx.vanStockRequest.updateMany({
      where: { id, status: "pending", deletedAt: null },
      data: {
        status: "approved",
        warehouseId: patch.warehouseId,
        warehouseName: patch.warehouseName,
        warehouseCode: patch.warehouseCode,
        reviewedByUserId: patch.reviewedByUserId,
        reviewedByEmail: patch.reviewedByEmail,
        reviewedAt: new Date(),
        decisionNote: patch.decisionNote,
      },
    });
    if (res.count === 0) throw conflict("This request was just handled by someone else.");
    for (const la of lineApprovals) {
      await tx.vanStockRequestLine.update({
        where: { id: la.lineId },
        data: {
          approvedQty: la.approvedQty,
          sourceWarehouseId: la.sourceWarehouseId,
          sourceWarehouseName: la.sourceWarehouseName,
          sourceWarehouseCode: la.sourceWarehouseCode,
        },
      });
    }
    // If the approval left NOTHING to fulfil — e.g. every line excluded (approvedQty 0) because no
    // warehouse could cover it — the request is already complete; move it straight to fulfilled so it
    // isn't stranded in `approved` with no terminating action available (H3).
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId: id } });
    if (linesAllDone(fresh)) {
      await tx.vanStockRequest.update({ where: { id }, data: { status: "fulfilled", completionType: "complete", lastFulfilledAt: new Date() } });
    }
    return tx.vanStockRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  });
}

export interface DeclinePatch {
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  decisionNote: string;
}

export async function declinePending(id: string, patch: DeclinePatch): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "pending", deletedAt: null },
    data: { status: "declined", reviewedByUserId: patch.reviewedByUserId, reviewedByEmail: patch.reviewedByEmail, reviewedAt: new Date(), decisionNote: patch.decisionNote },
  });
  return res.count;
}

export async function cancelPending(id: string, engineerId: string): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "pending", deletedAt: null, engineerId },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return res.count;
}

export interface FinishRemainingPatch {
  completionType: string; // closed_short | cancelled_remaining
  closedShortBy?: string | null;
  closeShortNote?: string | null;
  engineerId?: string; // guard: only the owner may cancel-remaining
}

// Cancel remaining (engineer): whole-request partially_fulfilled → fulfilled.
export async function finishRemaining(id: string, patch: FinishRemainingPatch): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "partially_fulfilled", deletedAt: null, ...(patch.engineerId ? { engineerId: patch.engineerId } : {}) },
    data: {
      status: "fulfilled",
      completionType: patch.completionType,
      ...(patch.completionType === "closed_short"
        ? { closedShortBy: patch.closedShortBy ?? null, closedShortAt: new Date(), closeShortNote: patch.closeShortNote ?? null }
        : { cancelledAt: new Date() }),
    },
  });
  return res.count;
}

export interface CloseShortLinesResult {
  affected: number;
  request: RequestWithLines;
}
// Per-warehouse close-short: write off the given lines' remaining qty (stamping closedShort* on each),
// then recompute overall status in the SAME transaction. `lineIds` are pre-filtered by the service to
// the actor's own outstanding lines. The request flips to fulfilled only when NO line has live
// remaining qty anywhere (other warehouses' lines may still be open).
export async function closeShortLines(requestId: string, lineIds: string[], note: string, actorEmail: string): Promise<CloseShortLinesResult> {
  return withTransaction(async (tx) => {
    const req = await tx.vanStockRequest.findFirst({ where: { id: requestId, deletedAt: null }, include: INCLUDE });
    if (!req) throw notFound("Van stock request not found.");
    if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request can be closed short.");

    let affected = 0;
    for (const id of lineIds) {
      const line = req.lines.find((l) => l.id === id);
      if (!line) continue;
      const remaining = lineRemaining(line);
      if (remaining <= 0) continue;
      await tx.vanStockRequestLine.update({
        where: { id },
        data: { closedShortQty: (line.closedShortQty ?? 0) + remaining, closedShortBy: actorEmail, closedShortNote: note, closedShortAt: new Date() },
      });
      affected++;
    }

    // Recompute overall status from the post-write lines (canonical: fulfilled | excluded | closed-short).
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId } });
    const done = linesAllDone(fresh);
    if (done) {
      await tx.vanStockRequest.update({
        where: { id: requestId },
        data: { status: "fulfilled", completionType: "closed_short", closedShortBy: actorEmail, closedShortAt: new Date(), closeShortNote: note },
      });
    }
    const request = await tx.vanStockRequest.findUniqueOrThrow({ where: { id: requestId }, include: INCLUDE });
    return { affected, request };
  });
}

// ---- The posting transaction --------------------------------------------------------------------

export interface FulfilEntry {
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: string; // good | damaged
  damagePhotoUrl?: string | null;
  damageReason?: string | null;
  scannedCode?: string | null;
}

// One atomic posting: re-read + guard inside the tx, run the caller's ledger writes (apply), append
// the VanStockFulfilment document, accumulate fulfilledQty, recompute status. Mirrors GM's
// createMovementWithCode(header, lines, apply) shape — everything commits or nothing does.
export async function postFulfilment(
  requestId: string,
  allowedStatuses: string[],
  performedBy: string,
  entries: FulfilEntry[],
  apply: (tx: Prisma.TransactionClient, req: RequestWithLines) => Promise<void>,
): Promise<RequestWithLines> {
  return withTransaction(async (tx) => {
    const req = await tx.vanStockRequest.findFirst({ where: { id: requestId, deletedAt: null }, include: INCLUDE });
    if (!req) throw notFound("Van stock request not found.");
    if (!allowedStatuses.includes(req.status)) throw conflict(`This request is ${req.status} — it can't be fulfilled.`);

    // Server-side remaining-qty guard, per request line, INSIDE the tx (concurrent postings abort).
    const byLine = new Map(req.lines.map((l) => [l.id, l]));
    const postedByLine = new Map<string, number>();
    for (const e of entries) {
      const line = byLine.get(e.lineId);
      if (!line) throw conflict("A scanned entry doesn't belong to this request — refresh and try again.");
      postedByLine.set(e.lineId, (postedByLine.get(e.lineId) ?? 0) + e.qty);
    }
    for (const [lineId, qty] of postedByLine) {
      const line = byLine.get(lineId)!;
      const cap = lineRemaining(line); // subtracts fulfilled AND closedShort — can't re-fulfil written-off qty
      if (qty > cap) throw conflict(`"${line.itemName}": only ${Math.max(0, cap)} left to fulfil on this request.`);
    }

    await apply(tx, req);

    // Derive the sequence from the CURRENT max inside the tx rather than the pre-apply read's
    // length — combined with the @@unique([requestId, sequence]), a concurrent poster either sees
    // our row (and takes the next number) or loses the insert with P2002 and retries the posting.
    const last = await tx.vanStockFulfilment.findFirst({ where: { requestId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    const seq = (last?.sequence ?? 0) + 1;
    await tx.vanStockFulfilment.create({
      data: {
        requestId,
        sequence: seq,
        performedBy,
        lines: {
          create: entries.map((e) => ({
            lineId: e.lineId,
            irmItemId: e.irmItemId,
            itemName: e.itemName,
            qty: e.qty,
            condition: e.condition,
            damagePhotoUrl: e.damagePhotoUrl ?? null,
            damageReason: e.damageReason ?? null,
            scannedCode: e.scannedCode ?? null,
          })),
        },
      },
    });

    for (const [lineId, qty] of postedByLine) {
      await tx.vanStockRequestLine.update({ where: { id: lineId }, data: { fulfilledQty: { increment: qty } } });
    }

    // Recompute status from the post-increment lines (canonical rule: fulfilled | excluded | closed-short).
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId } });
    const done = linesAllDone(fresh);
    await tx.vanStockRequest.update({
      where: { id: requestId },
      data: { status: done ? "fulfilled" : "partially_fulfilled", lastFulfilledAt: new Date(), ...(done ? { completionType: "complete" } : {}) },
    });

    return tx.vanStockRequest.findUniqueOrThrow({ where: { id: requestId }, include: INCLUDE });
  });
}

// --- Dashboard read-model ---
/** Pending VSRs for the warehouse worklist, scoped to the actor's warehouses (returns own their
 *  final warehouse; pending restocks are owned by the engineer's collection warehouse). Each row
 *  carries the owning warehouse CODE so the worklist can deep-link to that warehouse's tab. */
export async function pendingWorklist(warehouseScope?: string[]): Promise<Array<{ id: string; code: string; type: string; engineerName: string; priority: string; createdAt: Date; targetWarehouseCode: string | null }>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { AND: [{ status: "pending", deletedAt: null }, ...(warehouseScope ? [belongsToWarehouses(warehouseScope)] : [])] },
    select: { id: true, code: true, type: true, engineerName: true, priority: true, createdAt: true, warehouseCode: true, preferredWarehouseCode: true },
    orderBy: { createdAt: "asc" },
    take: 50, // per-queue cap — oldest-first keeps the actionable head; the service re-caps the merge
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    type: r.type,
    engineerName: r.engineerName,
    priority: r.priority,
    createdAt: r.createdAt,
    targetWarehouseCode: r.warehouseCode ?? r.preferredWarehouseCode,
  }));
}
