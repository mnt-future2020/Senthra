import { Prisma, type VanStockRequest, type VanStockRequestLine, type VanStockFulfilment, type VanStockFulfilmentLine } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict, notFound } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";
import { priorityFilterValues, readPriority } from "./van-stock-request.validation.js";

// The ONLY place Prisma is touched for the four VanStock* models. Code allocation copies the JKR
// atomic Counter + retry mechanism; the posting transaction mirrors GM's createMovementWithCode.

export type FulfilmentWithLines = VanStockFulfilment & { lines: VanStockFulfilmentLine[] };

// The per-line source warehouse with its LIVE address — surfaced to the engineer (who has no
// warehouse-module access) so a SPLIT request tells them where to collect each item. Mirrors the job
// module's kitWarehouseSelect.
const sourceWarehouseSelect = {
  id: true,
  name: true,
  code: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
  contactPhone: true,
} satisfies Prisma.WarehouseSelect;

export type SourceWarehouse = Prisma.WarehouseGetPayload<{ select: typeof sourceWarehouseSelect }>;
export type LineWithSource = VanStockRequestLine & { sourceWarehouse: SourceWarehouse | null };
export type RequestWithLines = VanStockRequest & { lines: LineWithSource[]; fulfilments: FulfilmentWithLines[] };

const INCLUDE = {
  lines: { include: { sourceWarehouse: { select: sourceWarehouseSelect } } },
  fulfilments: { include: { lines: true }, orderBy: { sequence: "asc" as const } },
};

// ── Canonical line math — the SINGLE SOURCE OF TRUTH for "how much is left" and "is this line done".
// Every cap, remaining-qty, and status-recompute MUST use these (posting, scan-lookup, close-short,
// approve). Re-implementing the arithmetic inline is what caused the closedShortQty over-issue and the
// stuck-partially_fulfilled bugs — do NOT inline it again.
type LineMath = { approvedQty: number | null; requestedQty: number; fulfilledQty: number; closedShortQty: number | null; cancelledQty?: number | null };
// How much of this line can be scanned RIGHT NOW. Zero until its own warehouse has approved it.
//
// This used to read `approvedQty ?? requestedQty`, which was safe only while one approval covered the
// whole request: a line could never sit undecided inside an approved one. Each source warehouse now
// approves only ITS OWN lines, so that state is normal — and the old fallback made an undecided line
// look fully outstanding, so the fulfil zone offered it to be scanned out with no approval behind it.
// Returns and walk-ins are unaffected: both set approvedQty at create, so they are never undecided.
export function lineRemaining(l: LineMath): number {
  if (l.approvedQty == null) return 0; // awaiting its warehouse's decision — nothing issuable yet
  // Both close-short (the warehouse can't supply) and cancel-remaining (the engineer no longer wants
  // it) retire outstanding qty; neither will ever be issued, so both come off what's left to collect.
  return l.approvedQty - l.fulfilledQty - (l.closedShortQty ?? 0) - (l.cancelledQty ?? 0);
}

// …but an undecided line still HOLDS THE REQUEST OPEN, and this is derived from lineRemaining, so the
// rule above would otherwise report it complete and close the whole request while a warehouse had not
// yet looked at it. The two questions are genuinely different — "how much can be issued now" versus
// "is there anything left for anyone to do" — and only here do they diverge.
export function lineDone(l: LineMath): boolean {
  // Cancelled FIRST, and regardless of whether the line was ever approved: once the engineer has
  // withdrawn it nobody owes an answer, so an UNDECIDED line that was cancelled must not keep the
  // request open forever. Without this a request the engineer called off while one warehouse was
  // still deliberating carried a line that could never be finished by anyone.
  if ((l.cancelledQty ?? 0) > 0) return true;
  if (l.approvedQty == null) return false; // undecided — its warehouse still owes an answer
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
  // Which catalogue this line draws from. Defaults to "irm" at the DB level, so a caller that omits it
  // writes exactly the row it always did.
  source?: string; // irm | rental
  irmItemId?: string | null; // when source is irm
  rentalItemId?: string | null; // when source is rental — the CATALOGUE item, never a hire
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

export function findByCode(code: string): Promise<RequestWithLines | null> {
  if (!code) return Promise.resolve(null);
  return prisma.vanStockRequest.findFirst({ where: { code, deletedAt: null }, include: INCLUDE });
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
  createdVia?: string; // engineer_request | walk_in — a walk-in was never reviewed, so it reads differently
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
  const { status, type, engineerId, priority, createdVia, search, sort, page = 1, pageSize = 20, warehouseId, warehouseScope } = params;
  const and: Prisma.VanStockRequestWhereInput[] = [{ deletedAt: null }];
  // "collectible" is a composite the Engineer dashboard links to: the two states an engineer still has
  // stock to physically pick up in (approved + partially_fulfilled). It mirrors countCollectibleRestocks
  // so the "Field stock to collect" card's number and its filtered list agree. Any other value is exact.
  if (status === "collectible") and.push({ status: { in: ["approved", "partially_fulfilled"] } });
  else if (status) and.push({ status });
  if (type) and.push({ type });
  if (engineerId) and.push({ engineerId });
  // Matched against the STORED values, which still include the retired "high" on older rows — so the
  // queue's Urgent filter returns everything the queue actually shows as urgent.
  if (priority) and.push({ priority: { in: priorityFilterValues(priority) } });
  if (createdVia) and.push({ createdVia });
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

// Approved RETURN requests still to be scanned back in at the warehouse — the counterpart of
// countCollectibleRestocks (which is the engineer's side of an approved restock). Without this the
// returns half of the van flow has no warehouse-side signal at all.
export function countReturnsToScan(warehouseScope?: string[]): Promise<number> {
  return prisma.vanStockRequest.count({
    where: {
      AND: [
        { type: "return", status: { in: ["approved", "partially_fulfilled"] }, deletedAt: null },
        ...(warehouseScope ? [belongsToWarehouses(warehouseScope)] : []),
      ],
    },
  });
}

/**
 * The two van queues split PER WAREHOUSE, for the Warehouses list's per-row count.
 *
 * Deliberately NOT a groupBy: "belongs to warehouse X" is the three-armed OR above, not a column, so
 * there is nothing for Mongo to group on. Requests are read with only the four fields the rule needs
 * and attributed in memory — and a request attributed to two warehouses is COUNTED AT BOTH, exactly as
 * belongsToWarehouses already makes a split restock appear in every involved warehouse's queue. Row
 * counts can therefore add up to more than the flat count; that is the truth about the work (each
 * warehouse really does have something to do), not double counting to be netted away.
 *
 * Bounded by the open-request set, which is small by construction — these statuses are worked daily.
 */
async function attributeToWarehouses(
  where: Prisma.VanStockRequestWhereInput,
  warehouseScope?: string[],
): Promise<Record<string, number>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { AND: [where, ...(warehouseScope ? [belongsToWarehouses(warehouseScope)] : [])] },
    select: { status: true, warehouseId: true, preferredWarehouseId: true, lines: { select: { sourceWarehouseId: true } } },
  });
  const out: Record<string, number> = {};
  const allowed = warehouseScope ? new Set(warehouseScope) : null;
  for (const r of rows) {
    // A set, so a request whose final warehouse ALSO sources a line cannot count twice at that one.
    const ids = new Set<string>();
    if (r.warehouseId) ids.add(r.warehouseId);
    if (r.status === "pending" && r.preferredWarehouseId) ids.add(r.preferredWarehouseId);
    for (const l of r.lines) if (l.sourceWarehouseId) ids.add(l.sourceWarehouseId);
    for (const id of ids) {
      if (allowed && !allowed.has(id)) continue; // a scoped actor never sees a sibling warehouse's share
      out[id] = (out[id] ?? 0) + 1;
    }
  }
  return out;
}

export function countPendingByWarehouse(warehouseScope?: string[]): Promise<Record<string, number>> {
  return attributeToWarehouses({ status: "pending", deletedAt: null }, warehouseScope);
}

export function countReturnsToScanByWarehouse(warehouseScope?: string[]): Promise<Record<string, number>> {
  return attributeToWarehouses(
    { type: "return", status: { in: ["approved", "partially_fulfilled"] }, deletedAt: null },
    warehouseScope,
  );
}

// Open (pending/approved/partially_fulfilled) line items for one engineer + type — powers the
// non-blocking duplicate warning in the composer.
export async function findOpenLineItems(
  engineerId: string,
  type: string,
): Promise<Array<{ source: string; irmItemId: string | null; rentalItemId: string | null; code: string }>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { engineerId, type, deletedAt: null, status: { in: ["pending", "approved", "partially_fulfilled"] } },
    select: { code: true, lines: { select: { source: true, irmItemId: true, rentalItemId: true } } },
  });
  // The source rides along so the composer can warn on a duplicate HIRE as well as a duplicate IRM
  // item. Matching on a bare item id across two catalogues would both miss real duplicates and invent
  // false ones — the id spaces are independent.
  return rows.flatMap((r) => r.lines.map((l) => ({ source: l.source, irmItemId: l.irmItemId, rentalItemId: l.rentalItemId, code: r.code })));
}

/**
 * Requests still in flight against a warehouse — the delete guard for it.
 *
 * Same shape as a live job's kit line naming its pickup point: an open restock says where the
 * engineer collects, and an approved-but-unscanned one is stock the warehouse has already committed
 * (it credits the van when the warehouse finally scans it out). Deleting the warehouse under either
 * leaves the request pointing at an id every read filters away.
 */
export function countOpenByWarehouse(warehouseId: string): Promise<number> {
  return prisma.vanStockRequest.count({
    where: { warehouseId, deletedAt: null, status: { in: ["pending", "approved", "partially_fulfilled"] } },
  });
}

// How many requests are still in flight for a group of engineers — pending, approved, or partly
// fulfilled. An approved-but-unscanned restock credits the engineer's van when the warehouse
// finally scans it out, so a role that loses the field capability while one is open would end up
// holding stock it can never return. Used by the role-capability guard.
export function countOpenForEngineers(engineerIds: string[]): Promise<number> {
  if (engineerIds.length === 0) return Promise.resolve(0);
  return prisma.vanStockRequest.count({
    where: {
      engineerId: { in: engineerIds },
      deletedAt: null,
      status: { in: ["pending", "approved", "partially_fulfilled"] },
    },
  });
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

// Review (restock) — each source warehouse decides ITS OWN lines, so this claims LINES, not the
// request. Every line is claimed with `approvedQty: null` in the WHERE, so two warehouses reviewing
// at the same moment can't overwrite each other: the loser's updateMany matches 0 rows for a line
// already decided and that line is left exactly as the winner set it.
//
// The request row is only dragged forward: pending → approved on the FIRST approval (so the engineer
// can start collecting from that warehouse while others are still deciding), and → declined only when
// every line has been decided and none survived. Its reviewedBy/reviewedAt/decisionNote are the FIRST
// decision's; per-warehouse detail lives on the line, because one set of request-level fields can
// only ever record one manager's call.
export interface LineDecision {
  lineId: string;
  approvedQty: number;
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  reviewedByEmail: string | null;
  decisionNote: string | null;
}

export async function claimLinesForReview(
  id: string,
  decisions: LineDecision[],
  requestPatch: { warehouseId: string | null; warehouseName: string | null; warehouseCode: string | null; reviewedByUserId: string | null; reviewedByEmail: string | null; decisionNote: string | null },
): Promise<RequestWithLines> {
  return withTransaction(async (tx) => {
    const now = new Date();
    let claimed = 0;
    for (const d of decisions) {
      const res = await tx.vanStockRequestLine.updateMany({
        // "Still undecided" is the claim: an already-decided line is another warehouse's answer, and
        // matching 0 rows is how the loser of a concurrent review is detected.
        //
        // MONGO TRAP: this MUST be `isSet: false` OR `null`, never `approvedQty: null` alone. A line
        // is created without approvedQty, so the field is ABSENT from the document — and Prisma's
        // MongoDB connector treats `{ field: null }` as "explicitly null", which does NOT match a
        // missing field. With the bare null filter every claim matched 0 rows and EVERY approval
        // failed with "just handled by someone else". Reads are unaffected (Prisma hydrates a missing
        // optional as null), so `l.approvedQty === null` in TS stays correct — the trap is filters only.
        where: { id: d.lineId, requestId: id, OR: [{ approvedQty: null }, { approvedQty: { isSet: false } }] },
        data: {
          approvedQty: d.approvedQty,
          sourceWarehouseId: d.sourceWarehouseId,
          sourceWarehouseName: d.sourceWarehouseName,
          sourceWarehouseCode: d.sourceWarehouseCode,
          reviewedByEmail: d.reviewedByEmail,
          reviewedAt: now,
          decisionNote: d.decisionNote,
        },
      });
      claimed += res.count;
    }
    if (claimed === 0) throw conflict("Those lines were just handled by someone else.");

    // Derive the request's own status from the lines. Deliberately never moves a request BACKWARDS
    // and never touches one that is already terminal.
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId: id } });
    const anyApproved = fresh.some((l) => (l.approvedQty ?? 0) > 0);
    const allDecided = fresh.every((l) => l.approvedQty !== null);
    const req = await tx.vanStockRequest.findUniqueOrThrow({ where: { id } });

    if (req.status === "pending") {
      if (anyApproved) {
        await tx.vanStockRequest.update({
          where: { id },
          data: {
            status: "approved",
            // Only the FIRST decision stamps the request; later warehouses record on their lines.
            warehouseId: req.warehouseId ?? requestPatch.warehouseId,
            warehouseName: req.warehouseName ?? requestPatch.warehouseName,
            warehouseCode: req.warehouseCode ?? requestPatch.warehouseCode,
            reviewedByUserId: requestPatch.reviewedByUserId,
            reviewedByEmail: requestPatch.reviewedByEmail,
            reviewedAt: now,
            decisionNote: requestPatch.decisionNote,
          },
        });
      } else if (allDecided) {
        // Every warehouse answered and nobody approved anything — that is a decline, not an approval
        // with an empty kit, and the engineer's list must read it as one.
        await tx.vanStockRequest.update({
          where: { id },
          data: { status: "declined", reviewedByUserId: requestPatch.reviewedByUserId, reviewedByEmail: requestPatch.reviewedByEmail, reviewedAt: now, decisionNote: requestPatch.decisionNote },
        });
      }
    }

    // Nothing left for anyone to do (every line fulfilled / excluded / closed short) ⇒ complete. Only
    // reachable once every warehouse has decided: lineDone is false while a line is undecided.
    const after = await tx.vanStockRequestLine.findMany({ where: { requestId: id } });
    const status = (await tx.vanStockRequest.findUniqueOrThrow({ where: { id } })).status;
    if (status === "approved" && linesAllDone(after)) {
      await tx.vanStockRequest.update({ where: { id }, data: { status: "fulfilled", completionType: "complete", lastFulfilledAt: now } });
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
  cancelledBy?: string | null; // stamped on each still-open line, so the record names who gave up on it
}

// Cancel remaining (engineer): partially_fulfilled → fulfilled, STAMPING each still-open line with
// what was given up on.
//
// It used to update the request row alone, which left the two disagreeing: the request read
// `fulfilled` while a line still reported its full approved qty outstanding. That is what made the
// engineer's own view say "Awaiting" for stock they had just cancelled, and left the warehouse with a
// "Fulfilled" request it had issued nothing against and no reason why. Mirrors closeShortLines, which
// has always stamped per line — this was the last request-level-only completion left.
export async function finishRemaining(id: string, patch: FinishRemainingPatch): Promise<number> {
  return withTransaction(async (tx) => {
    const res = await tx.vanStockRequest.updateMany({
      // APPROVED counts too, not just partially_fulfilled. Under per-warehouse review a request flips
      // to `approved` the moment ONE warehouse answers, so it can sit there for hours while another
      // deliberates — and the engineer, who could cancel it while it was pending, suddenly couldn't.
      // "Cancel the remainder" reads perfectly well when the remainder happens to be everything.
      where: { id, status: { in: ["approved", "partially_fulfilled"] }, deletedAt: null, ...(patch.engineerId ? { engineerId: patch.engineerId } : {}) },
      data: {
        status: "fulfilled",
        completionType: patch.completionType,
        ...(patch.completionType === "closed_short"
          ? { closedShortBy: patch.closedShortBy ?? null, closedShortAt: new Date(), closeShortNote: patch.closeShortNote ?? null }
          : { cancelledAt: new Date() }),
      },
    });
    if (res.count === 0) return 0; // lost the race / not the owner — leave the lines untouched
    const now = new Date();
    const lines = await tx.vanStockRequestLine.findMany({ where: { requestId: id } });
    for (const l of lines) {
      // An UNDECIDED line reads 0 from lineRemaining — nothing is ISSUABLE before its warehouse
      // answers — but everything requested is still outstanding, and once the engineer has cancelled
      // no warehouse will ever answer it. Cancel what was ASKED for, or the line is left dangling on
      // a closed request and the engineer is told "Awaiting" for stock they withdrew themselves.
      // Reachable because cancel now accepts `approved`, which is where a split request waits.
      const outstanding = l.approvedQty == null ? l.requestedQty : lineRemaining(l);
      if (outstanding <= 0) continue; // already issued, excluded, closed short or cancelled
      await tx.vanStockRequestLine.update({
        where: { id: l.id },
        // approvedQty stays null on purpose: it never WAS decided, and recording a 0 there would read
        // as "the warehouse excluded it" — someone else's decision, and it would label the line
        // Excluded instead of Cancelled.
        data: { cancelledQty: outstanding, cancelledBy: patch.cancelledBy ?? null, cancelledAt: now },
      });
    }
    return res.count;
  });
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
  source: string; // irm | rental — mirrors the request line's own discriminator
  irmItemId?: string | null;
  rentalItemId?: string | null;
  // THE BOUND HIRE, on rental entries only. The service resolves it before the transaction (soonest
  // deadline first) and the posting re-asserts it atomically. One request line can span several hires,
  // so the service may hand over SEVERAL entries for one lineId — the remaining-qty guard below sums
  // per line, so that splits correctly without any special case.
  purchaseOrderRentalLineId?: string | null;
  // Snapshotted onto the posted row so the reviewer's detail view can name the order and the deadline
  // without loading the order chain — the same reason EngineerRentalHolding snapshots them.
  poCode?: string | null;
  hireEndDate?: Date | null;
  itemName: string;
  qty: number;
  condition: string; // good | damaged
  damagePhotoUrl?: string | null;
  damageReason?: string | null;
  scannedCode?: string | null;
}

// One atomic posting: re-read + guard inside the tx, append the VanStockFulfilment document, run the
// caller's ledger writes (apply), accumulate fulfilledQty, recompute status. Mirrors GM's
// createMovementWithCode(header, lines, apply) shape — everything commits or nothing does.
//
// THE FULFILMENT IS WRITTEN BEFORE `apply`, and that ordering is load-bearing rather than incidental.
// `apply` needs the POSTING's id: a damaged hire opens a HireCustodyExit keyed
// [sourceType, sourceId, hire, kind], and only the posting is a correct `sourceId` there. Keying on
// the REQUEST would make a second posting's damage on the same hire collide with the first — and
// createExitTx reads a collision as an idempotent retry and hands back the earlier row, so the second
// posting's units would be drained from custody with no exit row holding them down, quietly returning
// a damaged tester to the issuable pool. Splitting a Field Stock return across several postings is
// ordinary, so that is a live hazard, not a theoretical one.
//
// Nothing else changes by moving it: the whole body is one transaction, so a sequence collision now
// fails before the ledger writes instead of after, and either way the transaction rolls back whole.
export async function postFulfilment(
  requestId: string,
  allowedStatuses: string[],
  performedBy: string,
  entries: FulfilEntry[],
  apply: (tx: Prisma.TransactionClient, req: RequestWithLines, fulfilmentId: string) => Promise<void>,
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

    // Derive the sequence from the CURRENT max inside the tx — combined with the
    // @@unique([requestId, sequence]), a concurrent poster either sees our row (and takes the next
    // number) or loses the insert with P2002 and retries the posting.
    const last = await tx.vanStockFulfilment.findFirst({ where: { requestId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    const seq = (last?.sequence ?? 0) + 1;
    const fulfilment = await tx.vanStockFulfilment.create({
      data: {
        requestId,
        sequence: seq,
        performedBy,
        lines: {
          create: entries.map((e) => ({
            lineId: e.lineId,
            irmItemId: e.irmItemId ?? null,
            rentalItemId: e.rentalItemId ?? null,
            // The hire these units actually moved on — the record that makes a Field Stock issue
            // traceable and, later, returnable.
            purchaseOrderRentalLineId: e.purchaseOrderRentalLineId ?? null,
            poCode: e.poCode ?? null,
            hireEndDate: e.hireEndDate ?? null,
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

    await apply(tx, req, fulfilment.id);

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
    priority: readPriority(r.priority), // legacy "high" rows read as urgent, same as everywhere else
    createdAt: r.createdAt,
    targetWarehouseCode: r.warehouseCode ?? r.preferredWarehouseCode,
  }));
}

// Restocks the engineer still has to physically collect: approved or partially fulfilled.
// Returns are excluded — the warehouse scans those in; only restocks are collected by the engineer.
export function countCollectibleRestocks(engineerId: string): Promise<number> {
  return prisma.vanStockRequest.count({
    where: { engineerId, type: "restock", deletedAt: null, status: { in: ["approved", "partially_fulfilled"] } },
  });
}
