import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import { jobCommittedByEngineer } from "#modules/goods-management/goods-management.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitToRoom, emitToUser, VAN_STOCK_REVIEWERS_ROOM } from "../../lib/realtime.js";
import { assertWarehouseAccess, getAccessibleWarehouseIds, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as vsrRepo from "./van-stock-request.repository.js";
import type { CreateRequestData, CreateRequestLineData, FulfilEntry, RequestWithLines } from "./van-stock-request.repository.js";
import type {
  ApproveVanStockRequestInput,
  CloseShortInput,
  CreateVanStockRequestInput,
  DeclineVanStockRequestInput,
  FulfilVanStockRequestInput,
  ScanLookupInput,
  WalkInInput,
} from "./van-stock-request.validation.js";

// Non-job engineer ↔ warehouse stock flow. Restock: pending → approved (reviewer fixes warehouse,
// may trim) → scan-out postings. Return: pending → scan-in postings directly (scan IS acceptance).
// All ledger writes ride the existing primitives inside ONE transaction per posting.

const SOURCE_TYPE = "van_stock_request";
const DAMAGED_SOURCE_TYPE = "van_stock_return";

// A 24-hex string is a Mongo ObjectId; anything else is a VSR code ("VSR-0030"). Mirrors the
// id-or-code reads on purchase-request / goods-in / customer.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Stale indicator (derived; no scheduler — spec §9) ─────────────────────────────────────────
export const STALE_PENDING_DAYS = 7;
export const STALE_ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(req: { status: string; createdAt: Date; reviewedAt: Date | null; lastFulfilledAt: Date | null }, now: Date): boolean {
  if (req.status === "pending") return now.getTime() - req.createdAt.getTime() > STALE_PENDING_DAYS * DAY_MS;
  if (req.status === "approved" || req.status === "partially_fulfilled") {
    const anchor = req.lastFulfilledAt ?? req.reviewedAt ?? req.createdAt;
    return now.getTime() - anchor.getTime() > STALE_ACTIVE_DAYS * DAY_MS;
  }
  return false;
}

// ── DTOs ───────────────────────────────────────────────────────────────────────────────────────

export interface PublicVanStockLine {
  id: string;
  irmItemId: string;
  itemName: string;
  code: string | null; // IRM item code snapshot (e.g. IRM-0002) — shown + copyable in the UI
  sku: string | null;
  uom: string | null;
  requestedQty: number;
  approvedQty: number | null;
  fulfilledQty: number;
  remainingQty: number; // (approvedQty ?? requestedQty) − fulfilledQty − closedShortQty
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  // The source warehouse's LIVE address — the engineer has no warehouse-module access, so on a split
  // request this is the only way they can find where to collect each line. Null until approve sets the
  // line's source (and for a line whose warehouse was since removed).
  sourceWarehouse: PublicVanStockLineWarehouse | null;
  isMine: boolean; // sourceWarehouseId ∈ the reading actor's warehouse scope (false for the engineer's own read)
}

export interface PublicVanStockLineWarehouse {
  id: string;
  name: string;
  code: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  contactPhone: string | null;
}

export interface PublicVanStockFulfilmentLine {
  id: string;
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: string;
  damagePhotoUrl: string | null;
  damageReason: string | null;
  scannedCode: string | null;
}

export interface PublicVanStockFulfilment {
  id: string;
  sequence: number;
  performedBy: string;
  postedAt: string;
  lines: PublicVanStockFulfilmentLine[];
}

export interface PublicVanStockRequest {
  id: string;
  code: string;
  type: string;
  status: string;
  priority: string;
  createdVia: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId: string | null;
  preferredWarehouseName: string | null;
  preferredWarehouseCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  lastFulfilledAt: string | null;
  completionType: string | null;
  closedShortBy: string | null;
  closedShortAt: string | null;
  closeShortNote: string | null;
  cancelledAt: string | null;
  stale: boolean;
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: { warehouseIds: string[]; lines: number; linesDone: number; qty: number; qtyFulfilled: number; allMineDone: boolean } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PublicVanStockLine[];
  fulfilments: PublicVanStockFulfilment[];
}

export interface PagedVanStockRequests {
  requests: PublicVanStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ── Progress / ownership (server-computed; spec §5b/§5c) ────────────────────────────────────────
// `scope` has three modes: undefined = unrestricted reviewer (admin — everything is mine); a string[]
// = that reviewer's warehouse ids; null = engineer read (nothing is mine, myProgress null).
// Carries requestedQty because the canonical math needs it: an unapproved line's ceiling is what was
// REQUESTED (approvedQty is null until the reviewer approves).
type LineForProgress = { approvedQty: number | null; requestedQty: number; fulfilledQty: number; closedShortQty: number | null; sourceWarehouseId: string | null };

// Done-ness is NOT re-implemented here — it delegates to the repository's canonical lineDone(), the
// single source of truth that also drives the authoritative status recompute (postFulfilment /
// closeShortLines / claimPendingForApproval). The read-model MUST agree with stored status: an inline
// copy read a pending line's null approvedQty as "approved 0 ⇒ done", so an untouched pending request
// rendered as fully complete. Keep this a delegation.
const lineIsDone = vsrRepo.lineDone;
function lineIsExcluded(l: LineForProgress): boolean {
  return l.approvedQty === 0; // explicitly dropped at approval (null = not yet approved, not excluded)
}
function lineIsMine(l: LineForProgress, scope: string[] | undefined | null): boolean {
  if (scope === null) return false; // engineer read — no warehouse role
  if (scope === undefined) return true; // unrestricted reviewer (admin)
  return l.sourceWarehouseId !== null && scope.includes(l.sourceWarehouseId);
}

interface ProgressBlock {
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: { warehouseIds: string[]; lines: number; linesDone: number; qty: number; qtyFulfilled: number; allMineDone: boolean } | null;
}
export function computeProgress(lines: LineForProgress[], scope: string[] | undefined | null): ProgressBlock {
  const counted = lines.filter((l) => !lineIsExcluded(l)); // excluded (approvedQty 0) drop out of counts
  const agg = (ls: LineForProgress[]) =>
    ls.reduce(
      // qty ceiling mirrors lineRemaining()'s: approved once reviewed, else what was requested — a
      // pending line must contribute its requested qty, not 0.
      (acc, l) => ({ lines: acc.lines + 1, linesDone: acc.linesDone + (lineIsDone(l) ? 1 : 0), qty: acc.qty + (l.approvedQty ?? l.requestedQty), qtyFulfilled: acc.qtyFulfilled + l.fulfilledQty }),
      { lines: 0, linesDone: 0, qty: 0, qtyFulfilled: 0 },
    );
  const progress = agg(counted);
  if (scope === null) return { progress, myProgress: null };
  const mine = counted.filter((l) => lineIsMine(l, scope));
  const warehouseIds = [...new Set(mine.map((l) => l.sourceWarehouseId).filter((x): x is string => x !== null))];
  return { progress, myProgress: { warehouseIds, ...agg(mine), allMineDone: mine.length > 0 && mine.every(lineIsDone) } };
}

// Lines the warehouse being acted FROM may write off on close-short: sourced to THAT one warehouse
// (the tab the reviewer is in) and still outstanding (not yet fulfilled/excluded/closed). Scoped to a
// single warehouseId — even an admin closes short only the warehouse they're viewing, never another
// warehouse's lines on a split request. Mirrors the scan/fulfil per-tab scoping; the caller asserts the
// actor may act for `warehouseId` (assertWarehouseAccess) before this runs.
export function pickCloseShortLines<T extends LineForProgress & { id: string }>(lines: T[], warehouseId: string): T[] {
  return lines.filter((l) => {
    if (lineIsDone(l)) return false; // already fulfilled / excluded / fully closed-short
    return l.sourceWarehouseId === warehouseId; // this warehouse's own outstanding line only
  });
}
// The whole request is done (→ fulfilled) once every line is fulfilled / excluded / closed-short.
// Delegates to the repository's canonical linesAllDone — same rule the posting tx recomputes status by.
export const requestDoneAfter = vsrRepo.linesAllDone;

// NOTE: `scope` has NO default — it is a three-state sentinel (undefined = unrestricted admin,
// null = engineer read, string[] = scoped reviewer). A default value would let JS coerce an
// explicitly-passed `undefined` (admin) into the default, collapsing admin→engineer and making every
// line read isMine=false for full-access admins. Every caller passes scope explicitly.
export function toPublic(r: RequestWithLines, now: Date, scope: string[] | undefined | null): PublicVanStockRequest {
  const prog = computeProgress(r.lines, scope);
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    status: r.status,
    priority: r.priority,
    createdVia: r.createdVia,
    engineerId: r.engineerId,
    engineerName: r.engineerName,
    engineerEmail: r.engineerEmail,
    preferredWarehouseId: r.preferredWarehouseId,
    preferredWarehouseName: r.preferredWarehouseName,
    preferredWarehouseCode: r.preferredWarehouseCode,
    warehouseId: r.warehouseId,
    warehouseName: r.warehouseName,
    warehouseCode: r.warehouseCode,
    reason: r.reason,
    notes: r.notes,
    attachments: r.attachments,
    reviewedByUserId: r.reviewedByUserId,
    reviewedByEmail: r.reviewedByEmail,
    reviewedAt: iso(r.reviewedAt),
    decisionNote: r.decisionNote,
    lastFulfilledAt: iso(r.lastFulfilledAt),
    completionType: r.completionType,
    closedShortBy: r.closedShortBy,
    closedShortAt: iso(r.closedShortAt),
    closeShortNote: r.closeShortNote,
    cancelledAt: iso(r.cancelledAt),
    stale: isStale(r, now),
    progress: prog.progress,
    myProgress: prog.myProgress,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: r.lines.map((l) => ({
      id: l.id,
      irmItemId: l.irmItemId,
      itemName: l.itemName,
      code: l.code,
      sku: l.sku,
      uom: l.uom,
      requestedQty: l.requestedQty,
      approvedQty: l.approvedQty,
      fulfilledQty: l.fulfilledQty,
      remainingQty: vsrRepo.lineRemaining(l), // canonical: subtracts fulfilled AND closed-short (so a closed-short line reads as 0 left, not still open)
      sourceWarehouseId: l.sourceWarehouseId,
      sourceWarehouseName: l.sourceWarehouseName,
      sourceWarehouseCode: l.sourceWarehouseCode,
      sourceWarehouse: l.sourceWarehouse,
      isMine: lineIsMine(l, scope),
    })),
    fulfilments: r.fulfilments.map((f) => ({
      id: f.id,
      sequence: f.sequence,
      performedBy: f.performedBy,
      postedAt: f.postedAt.toISOString(),
      lines: f.lines.map((fl) => ({
        id: fl.id,
        lineId: fl.lineId,
        irmItemId: fl.irmItemId,
        itemName: fl.itemName,
        qty: fl.qty,
        condition: fl.condition,
        damagePhotoUrl: fl.damagePhotoUrl,
        damageReason: fl.damageReason,
        scannedCode: fl.scannedCode,
      })),
    })),
  };
}

// Fan a request's lifecycle change out to (a) the requesting engineer — their own portal list —
// and (b) every field-stock reviewer so their warehouse board live-refreshes (warehouse managers
// hold van_stock_request.review but NOT jobs.view, so the jobs room never reached them; the
// dedicated reviewers room does). The event is a scope-agnostic "refetch" signal — each client
// re-pulls through its own warehouse-scoped list, so the shared room leaks nothing.
function emitUpdate(engineerId: string, data: { id: string; code: string; status: string; type: string }): void {
  emitToUser(engineerId, "van_stock_request:updated", data);
  emitToRoom(VAN_STOCK_REVIEWERS_ROOM, "van_stock_request:updated", data);
}

// "Is this actor a WAREHOUSE REVIEWER (vs the requesting engineer)?" — used only by getOne to gate
// visibility + decide the toPublic scope. Gated on a REAL review capability. It must NOT treat an
// unrestricted actor (assignedWarehouseIds === null) as a reviewer: that is the DEFAULT for every
// non-warehouse-scoped role — including plain field engineers — so it would let any engineer open any
// other engineer's request (H2, cross-engineer disclosure). A true admin passes via type/"*"; a manager
// via the review perm; the requesting engineer reaches their OWN request via getOne's isOwner branch.
export function isReviewer(actor: AuditActor): boolean {
  const perms = actor.permissions ?? [];
  return actor.type === "admin" || perms.includes("*") || perms.includes("van_stock_request.review");
}

// The set of warehouse ids that grant a reviewer access to a request — MUST mirror the queue filter
// belongsToWarehouses(): the request's final warehouse, its pending collection (preferred) warehouse,
// AND every line's source warehouse. A split request appears in a warehouse's queue because it owns a
// LINE there, so that same warehouse's manager must be able to OPEN it (else queue shows it but getOne
// 403s). Nulls dropped.
export function requestAccessWarehouseIds(req: {
  status: string;
  warehouseId: string | null;
  preferredWarehouseId: string | null;
  lines: Array<{ sourceWarehouseId: string | null }>;
}): string[] {
  const ids = new Set<string>();
  if (req.warehouseId) ids.add(req.warehouseId);
  if (req.status === "pending" && req.preferredWarehouseId) ids.add(req.preferredWarehouseId);
  for (const l of req.lines) if (l.sourceWarehouseId) ids.add(l.sourceWarehouseId);
  return [...ids];
}

// The reviewer-side access gate for ONE request — every reviewer entry point that reads or mutates a
// request by id MUST call this before disclosing anything about it (getOne, scanLookup, closeShort).
// Fails CLOSED on an unowned request: when NO warehouse owns it (all ids null), a warehouse-SCOPED
// reviewer has no claim, so only an unrestricted actor (admin) may proceed. This mirrors decline()'s
// rule — a scoped reviewer's authority comes only from owning one of the request's warehouses, so an
// empty owner set can never be something they own.
export function assertRequestAccess(
  actor: AuditActor,
  req: { status: string; warehouseId: string | null; preferredWarehouseId: string | null; lines: Array<{ sourceWarehouseId: string | null }> },
): void {
  const scope = getAccessibleWarehouseIds(actor);
  if (scope === null) return; // unrestricted (admin) — no warehouse restriction
  const accessIds = requestAccessWarehouseIds(req);
  if (!accessIds.some((id) => scope.includes(id))) throw forbidden("You don't have access to this request.");
}

// Resolve + validate the request's IRM lines against the live catalogue (active, non-serial/batch).
// PERF (known, deferred): one findById per line — up to 100 concurrent reads on a max-size request.
// The reads run in parallel and create/walk-in are low-frequency, so this isn't hot; a batched
// findMany({ id: { in } }) is the fix (the return path below already batches its balance read) but it
// must keep the per-line error messages, which name the offending item.
async function resolveLines(lines: Array<{ irmItemId: string; itemName: string; qty: number }>): Promise<CreateRequestLineData[]> {
  return Promise.all(
    lines.map(async (l): Promise<CreateRequestLineData> => {
      const item = await irmRepo.findById(l.irmItemId);
      if (!item) throw badRequest(`The IRM item for "${l.itemName}" no longer exists.`);
      if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
      if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported on van stock requests.`);
      return { irmItemId: item.id, itemName: item.name, code: item.code ?? null, sku: item.sku ?? null, uom: item.baseUnit ?? null, requestedQty: l.qty };
    }),
  );
}

// ── create (engineer) ───────────────────────────────────────────────────────────────────────────

export async function create(input: CreateVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const engineerId = actor.id ?? "";
  const engineer = await userRepo.findById(engineerId);
  if (!engineer) throw forbidden("Could not determine engineer identity.");
  // Restock fulfilment credits this engineer's van, so the requester must actually be able to hold
  // stock (mirrors walkIn + engineer-transfer). The route perm already gates who can call this; this
  // fails closed if a non-stock-holding or deactivated role somehow carries engineer.van_stock.request.
  if (!engineer.role?.canHoldStock) throw forbidden("Your role can't hold field stock.");

  const lines = await resolveLines(input.lines);

  let warehouseId: string | null = null;
  let warehouseName: string | null = null;
  let warehouseCode: string | null = null;
  let preferred: { id: string; name: string; code: string | null } | null = null;
  if (input.type === "return") {
    const wh = await warehouseRepo.findById(input.warehouseId!);
    if (!wh) throw badRequest("The selected warehouse no longer exists.");
    // A return must post its stock into a LIVE warehouse — an inactive one would strand the request
    // pointing at a warehouse no reviewer works (mirrors the wh.status guard in walkIn + approve).
    if (wh.status !== "active") throw badRequest("The selected warehouse is no longer active.");
    warehouseId = wh.id;
    warehouseName = wh.name;
    warehouseCode = wh.code ?? null;
    // Free-stock guard: only the FREE portion of the van holding — global on-hand MINUS stock committed
    // to active jobs — may be field-returned; job stock goes back through the job's Close & Reconcile,
    // never here (else it'd be stranded). This runs at CREATE (and mirrors the composer's my-holdings
    // display); it is advisory. The binding guard at posting time is the tx zero-floor on RAW on-hand
    // (upsertEngineerBalanceTx), which prevents over-draining below zero but does NOT re-subtract the
    // job-committed split — so a create→(new job issue)→fulfil race can't corrupt balances, and any
    // resulting job shortfall self-heals as a job_lost write-off at that job's reconcile. Both reads
    // (whole holding set + all job commitments) are batched to keep create off N round-trips.
    const [balanceRows, committed] = await Promise.all([
      engineerStockRepo.findEngineerBalances(engineerId),
      jobCommittedByEngineer(engineerId),
    ]);
    const balances = new Map(balanceRows.map((b) => [b.irmItemId, b.quantityOnHand]));
    for (const l of lines) {
      const free = Math.max(0, (balances.get(l.irmItemId) ?? 0) - (committed.get(l.irmItemId) ?? 0));
      if (free < l.requestedQty) {
        throw badRequest(`You only have ${free} of "${l.itemName}" free to return — the rest is committed to a job (return it through that job).`);
      }
    }
  } else {
    // REQUIRED on restock (validation enforces): the collection warehouse routes the pending
    // request to that warehouse manager's queue. Snapshot name/code for lists + worklist links.
    const wh = await warehouseRepo.findById(input.preferredWarehouseId!);
    if (!wh) throw badRequest("The selected collection warehouse no longer exists.");
    // Route only to a live warehouse — an inactive collection warehouse has no active reviewer queue.
    if (wh.status !== "active") throw badRequest("The selected collection warehouse is no longer active.");
    preferred = { id: wh.id, name: wh.name, code: wh.code ?? null };
  }

  const data: CreateRequestData = {
    code: "",
    type: input.type,
    status: "pending",
    priority: input.priority,
    createdVia: "engineer_request",
    engineerId,
    engineerName: `${engineer.firstName} ${engineer.lastName}`.trim() || (engineer.email ?? ""),
    engineerEmail: engineer.email ?? null,
    preferredWarehouseId: preferred?.id ?? null,
    preferredWarehouseName: preferred?.name ?? null,
    preferredWarehouseCode: preferred?.code ?? null,
    warehouseId,
    warehouseName,
    warehouseCode,
    reason: input.reason,
    notes: input.notes ?? null,
    attachments: input.attachments ?? [],
    createdBy: actor.email ?? null,
  };
  // Returns are auto-approved conceptually (approvedQty = requestedQty) AND single-warehouse, so their
  // lines are sourced to the return warehouse up front — mirroring walkIn(). Without this the fulfil
  // path (resolveFulfilWarehouses) throws on the null source and NO return can ever be scanned in (C2).
  const withApproved =
    input.type === "return"
      ? lines.map((l) => ({ ...l, approvedQty: l.requestedQty, sourceWarehouseId: warehouseId, sourceWarehouseName: warehouseName, sourceWarehouseCode: warehouseCode }))
      : lines;

  const req = await vsrRepo.createRequest(data, withApproved);
  audit.record({ actor, action: "van_stock_request.created", targetType: "van_stock_request", targetId: req.id, targetLabel: req.code, metadata: { type: req.type, lineCount: lines.length, priority: req.priority } });
  emitUpdate(engineerId, { id: req.id, code: req.code, status: req.status, type: req.type });
  return toPublic(req, new Date(), null); // engineer's own create — no warehouse role
}

// ── walk-in (reviewer creates pre-approved for an engineer at the counter) ──────────────────────

// Walk-in availability hard-block (pure + injectable, mirroring resolveLineApprovals' second pass).
// A walk-in opens ALREADY-approved and is scanned out immediately, so every line must be fulfillable
// from THIS warehouse right now. Unlike the engineer-request path — which is guarded at approve() —
// NOTHING else checks a walk-in's stock before the scan-out ledger write. Without this the counter
// composes a pre-approved request it can never scan, then hits the raw zero-floor error
// ("Insufficient stock: this movement would take on-hand below zero") at the gun. Advisory UI caps
// help, but on-hand is live (another posting can drain it between compose and submit) so the block
// MUST be authoritative here, not just client-side.
export function assertWalkInAvailability(
  lines: Array<{ irmItemId: string; itemName: string; requestedQty: number }>,
  warehouseName: string,
  onHandByItem: Map<string, number>,
): void {
  for (const l of lines) {
    const have = onHandByItem.get(l.irmItemId) ?? 0;
    if (have < l.requestedQty) {
      throw badRequest(`"${l.itemName}": only ${have} in stock at ${warehouseName} — adjust the quantity.`);
    }
  }
}

export async function walkIn(input: WalkInInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const engineer = await userRepo.findById(input.engineerId);
  if (!engineer) throw notFound("Engineer not found.");
  // The target MUST be an active stock-holding engineer — engineerId is caller-supplied here, so
  // without this a reviewer could credit company stock onto a non-engineer's (or inactive user's) van,
  // stranding an EngineerStockBalance no portal surfaces and no return flow can drain. Mirrors the
  // canHoldStock gate in engineer-transfer.assertEngineer and job.service issue flow.
  if (engineer.status !== "active") throw badRequest("That engineer account is not active.");
  if (!engineer.role?.canHoldStock) throw badRequest("That user is not a stock-holding engineer.");
  const wh = await warehouseRepo.findById(input.warehouseId);
  if (!wh) throw notFound("Warehouse not found.");
  if (wh.status !== "active") throw badRequest("That warehouse is no longer active."); // M1: walk-in warehouse must be active
  assertWarehouseAccess(actor, wh.id);

  const lines = await resolveLines(input.lines);
  // Authoritative availability gate — this warehouse must physically hold every line NOW (see
  // assertWalkInAvailability). One batched balance read over the request's items keeps it off N
  // round-trips; the map defaults a missing (item, warehouse) balance to 0 on-hand.
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(lines.map((l) => l.irmItemId), [wh.id]);
  assertWalkInAvailability(lines, wh.name, new Map(balances.map((b) => [b.irmItemId, b.quantityOnHand])));

  const data: CreateRequestData = {
    code: "",
    type: "restock",
    status: "approved",
    priority: input.priority,
    createdVia: "walk_in",
    engineerId: engineer.id,
    engineerName: `${engineer.firstName} ${engineer.lastName}`.trim() || (engineer.email ?? ""),
    engineerEmail: engineer.email ?? null,
    warehouseId: wh.id,
    warehouseName: wh.name,
    warehouseCode: wh.code ?? null,
    reason: input.reason,
    notes: input.notes ?? null,
    attachments: [],
    reviewedByUserId: actor.id ?? null,
    reviewedByEmail: actor.email ?? null,
    reviewedAt: new Date(),
    createdBy: actor.email ?? null,
  };
  // Walk-in is single-warehouse — issued at this counter — so every line is sourced here up front.
  const req = await vsrRepo.createRequest(
    data,
    lines.map((l) => ({ ...l, approvedQty: l.requestedQty, sourceWarehouseId: wh.id, sourceWarehouseName: wh.name, sourceWarehouseCode: wh.code ?? null })),
  );
  audit.record({ actor, action: "van_stock_request.walk_in_created", targetType: "van_stock_request", targetId: req.id, targetLabel: req.code, metadata: { engineerId: engineer.id, warehouseId: wh.id } });
  emitUpdate(engineer.id, { id: req.id, code: req.code, status: req.status, type: req.type });
  notify(engineer.id, { title: "Field stock ready", body: `Pre-approved stock ${req.code} is ready for you at the counter.`, data: { type: "vanstock", requestId: req.id } });
  return toPublic(req, new Date(), warehouseScopeFilter(actor));
}

// ── approve / decline (reviewer; restock only) ─────────────────────────────────────────────────

// Resolve each line's approved qty + source warehouse for approval, enforcing the hard-block: every
// INCLUDED line's chosen source must currently hold ≥ approvedQty. Excluded lines (approvedQty 0)
// carry no source and skip availability. Warehouse lookups + balance reads are injected so this is
// unit-testable without a DB.
export interface ResolvedLineApproval {
  lineId: string;
  approvedQty: number;
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
}
export async function resolveLineApprovals(
  reqLines: Array<{ id: string; irmItemId: string; itemName: string; requestedQty: number }>,
  lineApprovals: Array<{ lineId: string; approvedQty: number; sourceWarehouseId?: string }>,
  primary: { id: string; name: string; code: string | null },
  findWarehouse: (id: string) => Promise<{ id: string; name: string; code: string | null } | null>,
  findBalances: (irmItemIds: string[], warehouseIds: string[]) => Promise<Array<{ irmItemId: string; warehouseId: string; quantityOnHand: number }>>,
): Promise<ResolvedLineApproval[]> {
  const byLine = new Map(lineApprovals.map((a) => [a.lineId, a]));

  // First pass: resolve qty + chosen source per line, validating the trim ceiling + active warehouse.
  const resolved = await Promise.all(
    reqLines.map(async (l): Promise<ResolvedLineApproval & { irmItemId: string; itemName: string }> => {
      const a = byLine.get(l.id);
      const approvedQty = a?.approvedQty ?? l.requestedQty;
      if (approvedQty > l.requestedQty) throw badRequest(`"${l.itemName}": approved quantity can't exceed the requested ${l.requestedQty}.`);
      if (approvedQty === 0) {
        return { lineId: l.id, approvedQty: 0, sourceWarehouseId: null, sourceWarehouseName: null, sourceWarehouseCode: null, irmItemId: l.irmItemId, itemName: l.itemName };
      }
      const sourceId = a?.sourceWarehouseId ?? primary.id;
      const sw = sourceId === primary.id ? primary : await findWarehouse(sourceId);
      if (!sw) throw badRequest(`"${l.itemName}": the chosen source warehouse no longer exists or isn't active.`);
      return { lineId: l.id, approvedQty, sourceWarehouseId: sw.id, sourceWarehouseName: sw.name, sourceWarehouseCode: sw.code, irmItemId: l.irmItemId, itemName: l.itemName };
    }),
  );

  // Second pass: batched availability re-check over the distinct (item, source) pairs of INCLUDED lines.
  const included = resolved.filter((r) => r.approvedQty > 0 && r.sourceWarehouseId);
  const itemIds = [...new Set(included.map((r) => r.irmItemId))];
  const whIds = [...new Set(included.map((r) => r.sourceWarehouseId as string))];
  const balances = await findBalances(itemIds, whIds);
  const onHand = new Map(balances.map((b) => [`${b.warehouseId}:${b.irmItemId}`, b.quantityOnHand]));
  for (const r of included) {
    const have = onHand.get(`${r.sourceWarehouseId}:${r.irmItemId}`) ?? 0;
    if (have < r.approvedQty) {
      throw badRequest(`"${r.itemName}": only ${have} in stock at ${r.sourceWarehouseName ?? "the chosen warehouse"} — refresh and adjust.`);
    }
  }

  return resolved.map(({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }) => ({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }));
}

export async function approve(id: string, input: ApproveVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.type !== "restock") throw conflict("Returns don't need approval — scan them in to accept.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const wh = await warehouseRepo.findById(input.warehouseId);
  if (!wh) throw badRequest("The chosen warehouse no longer exists.");
  if (wh.status !== "active") throw badRequest("The chosen warehouse is no longer active."); // M1: primary must be active too
  assertWarehouseAccess(actor, wh.id);

  // Resolve per-line source + hard-block on live availability (authoritative — never trust the UI).
  const lineApprovals = await resolveLineApprovals(
    req.lines,
    input.lineApprovals ?? [],
    { id: wh.id, name: wh.name, code: wh.code ?? null },
    async (whId) => {
      const w = await warehouseRepo.findById(whId);
      return w && w.status === "active" ? { id: w.id, name: w.name, code: w.code ?? null } : null;
    },
    (itemIds, whIds) => inventoryRepo.findBalancesByItemsAndWarehouses(itemIds, whIds),
  );

  const updated = await vsrRepo.claimPendingForApproval(
    id,
    { warehouseId: wh.id, warehouseName: wh.name, warehouseCode: wh.code ?? null, reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null },
    lineApprovals,
  );

  audit.record({ actor, action: "van_stock_request.approved", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { warehouseId: wh.id, decisionNote: input.decisionNote ?? null, lineApprovals: lineApprovals.map((l) => ({ lineId: l.lineId, approvedQty: l.approvedQty, sourceWarehouseId: l.sourceWarehouseId })) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: "approved", type: req.type });
  notify(req.engineerId, { title: "Restock approved", body: `Your field stock request ${req.code} was approved — collect it from the warehouse.`, data: { type: "vanstock", requestId: id } });
  return toPublic(updated, new Date(), warehouseScopeFilter(actor));
}

export async function decline(id: string, input: DeclineVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);
  // Ownership guard: a pending request belongs to its final warehouse (returns) or the engineer's
  // collection warehouse (restocks) — only that warehouse's reviewers may decline it.
  const owningWarehouseId = req.warehouseId ?? req.preferredWarehouseId;
  if (owningWarehouseId) {
    assertWarehouseAccess(actor, owningWarehouseId);
  } else if (getAccessibleWarehouseIds(actor) !== null) {
    // No owning warehouse resolved (legacy/edge request) — a warehouse-SCOPED reviewer has no claim
    // to it, so fail closed. Only an unrestricted actor (admin, scope null) may decline such a request.
    throw forbidden("You don't have access to this request.");
  }

  const count = await vsrRepo.declinePending(id, { reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote });
  if (count === 0) throw conflict("This request was just handled by someone else.");
  const updated = await vsrRepo.findById(id);

  audit.record({ actor, action: "van_stock_request.declined", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { decisionNote: input.decisionNote } });
  emitUpdate(req.engineerId, { id, code: req.code, status: "declined", type: req.type });
  notify(req.engineerId, { title: "Field stock declined", body: `Your field stock request ${req.code} was declined.`, data: { type: "vanstock", requestId: id } });
  return toPublic(updated!, new Date(), warehouseScopeFilter(actor)); // reviewer action
}

// ── cancel / cancel-remaining (engineer) + close-short (reviewer) ───────────────────────────────

export async function cancel(id: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);
  const count = await vsrRepo.cancelPending(id, actor.id ?? "");
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel it, and only while it's pending.");
  const updated = await vsrRepo.findById(id);
  audit.record({ actor, action: "van_stock_request.cancelled", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: {} });
  emitUpdate(req.engineerId, { id, code: req.code, status: "cancelled", type: req.type });
  return toPublic(updated!, new Date(), null); // engineer action
}

export async function cancelRemaining(id: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request has a remainder to cancel.");
  const count = await vsrRepo.finishRemaining(id, { completionType: "cancelled_remaining", engineerId: actor.id ?? "" });
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel its remainder.");
  const updated = await vsrRepo.findById(id);
  audit.record({ actor, action: "van_stock_request.cancelled_remaining", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: {} });
  emitUpdate(req.engineerId, { id, code: req.code, status: "fulfilled", type: req.type });
  return toPublic(updated!, new Date(), null); // engineer action
}

export async function closeShort(id: string, input: CloseShortInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  // Gate BEFORE the status check — otherwise the 409s ("already fulfilled", "no outstanding lines")
  // disclose another warehouse's request existence + lifecycle state to an out-of-scope reviewer.
  assertRequestAccess(actor, req);
  // Scoped to ONE warehouse (the tab) — the actor must hold it, and only ITS lines are written off,
  // even for an admin. Mirrors the scan/fulfil warehouseId enforcement so the per-tab model is
  // consistent on this destructive path too.
  assertWarehouseAccess(actor, input.warehouseId);
  if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request can be closed short.");
  // Per-warehouse: this warehouse writes off only its OWN outstanding lines. The request finishes only
  // once every line across every warehouse is done (see repo closeShortLines status recompute).
  const targets = pickCloseShortLines(req.lines, input.warehouseId);
  if (targets.length === 0) throw conflict("This warehouse has no outstanding lines to close short on this request.");

  const { request: updated } = await vsrRepo.closeShortLines(id, targets.map((l) => l.id), input.note, actor.email ?? "");
  audit.record({ actor, action: "van_stock_request.closed_short", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { note: input.note, lineIds: targets.map((l) => l.id), warehouseIds: [...new Set(targets.map((l) => l.sourceWarehouseId))] } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  notify(req.engineerId, { title: "Request closed short", body: `Request ${req.code} was closed — the remaining items were written off.`, data: { type: "vanstock", requestId: id } });
  return toPublic(updated, new Date(), warehouseScopeFilter(actor));
}

// ── scan-lookup (reviewer; spec §7 barcode rules) ───────────────────────────────────────────────

export interface ScanLookupResult {
  irmItemId: string;
  lineId: string;
  itemName: string;
  uom: string | null;
  remainingQty: number;
  available: number | null; // restock: warehouse on-hand; return: engineer on-hand
}

export async function scanLookup(input: ScanLookupInput, actor: AuditActor): Promise<ScanLookupResult> {
  const req = await vsrRepo.findById(input.requestId);
  if (!req) throw notFound("Van stock request not found.");
  // Gate BEFORE any item/line disclosure: the per-line scope checks below only fire once an item has
  // been matched, so without this an out-of-scope reviewer could tell "isn't on this request" from
  // "already fully fulfilled" and enumerate another warehouse's request contents.
  assertRequestAccess(actor, req);
  // The scan is scoped to ONE warehouse tab — the actor must hold it (admin: always).
  assertWarehouseAccess(actor, input.warehouseId);

  const item = await irmService.findActiveByCodeOrBarcode(input.code);
  if (!item) throw badRequest("No active catalogue item matches that code.");
  if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported here.`);

  const line = req.lines.find((l) => l.irmItemId === item.id);
  if (!line) throw badRequest(`"${item.name}" isn't on this request.`);
  // The scanned line must be sourced to the warehouse tab the scan is happening in. Enforced even for an
  // admin (unrestricted scope) — a line is only ever issued from the warehouse it belongs to, not
  // whichever tab was opened. (Unsourced/null falls through to the per-type conflict below.)
  if (line.sourceWarehouseId && line.sourceWarehouseId !== input.warehouseId) {
    throw badRequest(`"${item.name}" is issued from ${line.sourceWarehouseName ?? "another warehouse"} — scan it from that warehouse.`);
  }
  const remainingQty = vsrRepo.lineRemaining(line); // canonical: subtracts fulfilled AND closed-short
  if (remainingQty <= 0) throw badRequest(`"${item.name}" is already fully fulfilled on this request.`);

  let available: number | null = null;
  if (req.type === "restock") {
    // The item issues from ITS line's source warehouse — read that shelf, and enforce the actor
    // may act for it (a split restock's lines may belong to warehouses the actor doesn't hold).
    if (!line.sourceWarehouseId) throw conflict(`"${item.name}" has not been sourced to a warehouse yet.`);
    const scope = warehouseScopeFilter(actor);
    if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
      throw forbidden(`"${item.name}" is sourced to a warehouse you don't have access to.`);
    }
    const bal = await inventoryRepo.findBalancePair(item.id, line.sourceWarehouseId);
    available = bal?.quantityOnHand ?? 0;
  } else if (req.type === "return") {
    // A return posts into its single warehouse (line.sourceWarehouseId = req.warehouseId at create).
    // Gate the lookup on the actor holding that warehouse — same rule as the restock branch above — so
    // a reviewer can't probe an engineer's on-hand for a return outside their warehouse scope.
    if (!line.sourceWarehouseId) throw conflict(`"${item.name}" has not been sourced to a warehouse yet.`);
    const scope = warehouseScopeFilter(actor);
    if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
      throw forbidden(`"${item.name}" returns to a warehouse you don't have access to.`);
    }
    const bal = await engineerStockRepo.findEngineerBalance(item.id, req.engineerId);
    available = bal?.quantityOnHand ?? 0;
  }
  return { irmItemId: item.id, lineId: line.id, itemName: item.name, uom: item.baseUnit ?? null, remainingQty, available };
}

// ── fulfil (reviewer; one atomic posting — spec §5/§6) ─────────────────────────────────────────

// Map each fulfil entry to the warehouse that must issue it — its LINE's sourceWarehouseId — and
// enforce the actor may act for that warehouse. scope: undefined = unrestricted (admin); string[] =
// the actor's warehouse ids. Throws on an entry whose line is unsourced or out of the actor's scope.
export function resolveFulfilWarehouses(
  reqLines: Array<{ id: string; irmItemId: string; itemName: string; sourceWarehouseId: string | null; sourceWarehouseName?: string | null }>,
  entries: Array<{ lineId: string; qty: number }>,
  scope: string[] | undefined,
): Array<{ lineId: string; warehouseId: string }> {
  const byLine = new Map(reqLines.map((l) => [l.id, l]));
  return entries.map((e) => {
    const line = byLine.get(e.lineId);
    if (!line) throw badRequest("An entry doesn't belong to this request.");
    if (!line.sourceWarehouseId) throw conflict(`"${line.itemName}" has not been sourced to a warehouse yet — it can't be fulfilled.`);
    if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
      throw forbidden(`"${line.itemName}" is fulfilled by ${line.sourceWarehouseName ?? "another warehouse"} — you don't have access to that warehouse.`);
    }
    return { lineId: e.lineId, warehouseId: line.sourceWarehouseId };
  });
}

export async function fulfil(id: string, input: FulfilVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  const allowed = req.type === "restock" ? ["approved", "partially_fulfilled"] : ["pending", "partially_fulfilled"];
  if (!allowed.includes(req.status)) throw conflict(`This request is ${req.status} — it can't be fulfilled.`);
  if (req.type === "restock" && input.entries.some((e) => e.condition === "damaged")) {
    throw badRequest("Damaged condition only applies to returns.");
  }
  // This posting is scoped to ONE warehouse (the tab the reviewer is in) — the actor must hold it.
  assertWarehouseAccess(actor, input.warehouseId);

  // Resolve each entry to its line's source warehouse + enforce per-entry access (authoritative —
  // a split restock's lines may be owned by different warehouses; the actor only fulfils theirs).
  const scope = warehouseScopeFilter(actor);
  const entryWarehouses = new Map(resolveFulfilWarehouses(req.lines, input.entries, scope).map((r) => [r.lineId, r.warehouseId]));
  // Every entry must issue from the ONE warehouse this posting is scoped to. Enforced even for an admin
  // (scope undefined, so resolveFulfilWarehouses waves everything through): a line is only posted out of
  // the warehouse it's sourced to, never from whichever tab was opened. Mirrors the scan-lookup guard.
  for (const [lineId, whId] of entryWarehouses) {
    if (whId !== input.warehouseId) {
      const line = req.lines.find((l) => l.id === lineId);
      throw badRequest(`"${line?.itemName ?? "An item"}" is issued from ${line?.sourceWarehouseName ?? "another warehouse"} — post it from that warehouse.`);
    }
  }

  const byLine = new Map(req.lines.map((l) => [l.id, l]));
  const entries: FulfilEntry[] = input.entries.map((e) => {
    const line = byLine.get(e.lineId);
    if (!line) throw badRequest("An entry doesn't belong to this request.");
    return { lineId: e.lineId, irmItemId: line.irmItemId, itemName: line.itemName, qty: e.qty, condition: e.condition, damagePhotoUrl: e.damagePhotoUrl ?? null, damageReason: e.damageReason ?? null, scannedCode: e.scannedCode ?? null };
  });

  const createdBy = actor.email ?? null;

  const updated = await vsrRepo.postFulfilment(id, allowed, actor.email ?? "", entries, async (tx, fresh) => {
    // Returns/walk-in are single-warehouse — that leg issues from fresh.warehouseId. Restock lines
    // each issue from their own sourceWarehouseId (entryWarehouses).
    // warehouseId is nullable in the schema; create() always sets it for a return, but assert rather
    // than cast — an unchecked `as string` would hand undefined to applyInbound and post a corrupt
    // balance row instead of rolling back.
    if (fresh.type !== "restock" && !fresh.warehouseId) {
      throw conflict("This return has no destination warehouse — it can't be fulfilled.");
    }
    const returnWarehouseId = fresh.warehouseId as string;
    for (const e of entries) {
      if (fresh.type === "restock") {
        const lineWarehouseId = entryWarehouses.get(e.lineId) as string;
        // Warehouse − (zero-floor guarded) → van + → engineer ledger row.
        await inventoryService.applyOutbound(tx, { irmItemId: e.irmItemId, warehouseId: lineWarehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, e.irmItemId, fresh.engineerId, e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId: e.irmItemId, engineerId: fresh.engineerId, quantityDelta: e.qty, type: "van_restock", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
      } else {
        // Van − (floor guarded) → good: warehouse + | damaged: damaged pool.
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, e.irmItemId, fresh.engineerId, -e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId: e.irmItemId, engineerId: fresh.engineerId, quantityDelta: -e.qty, type: "van_return", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
        if (e.condition === "good") {
          await inventoryService.applyInbound(tx, { irmItemId: e.irmItemId, warehouseId: returnWarehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        } else {
          const key: goodsManagementRepo.DamagedKey = { warehouseId: returnWarehouseId, ownerType: "company", irmItemId: e.irmItemId, customerStockEntryId: null, customerId: null, itemName: e.itemName };
          const dmg = await goodsManagementRepo.upsertDamagedBalanceTx(tx, key, e.qty);
          await goodsManagementRepo.insertDamagedTxnTx(tx, { warehouseId: returnWarehouseId, ownerType: "company", irmItemId: e.irmItemId, customerStockEntryId: null, customerId: null, quantityDelta: e.qty, reason: e.damageReason ?? "Damaged on van return", notes: null, photoUrl: e.damagePhotoUrl ?? null, sourceType: DAMAGED_SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: dmg.quantity, createdBy });
        }
      }
    }
  });

  audit.record({ actor, action: "van_stock_request.fulfilment_posted", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { entries: entries.map((e) => ({ item: e.itemName, qty: e.qty, condition: e.condition, sourceWarehouseId: entryWarehouses.get(e.lineId) ?? null })) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  notify(req.engineerId, {
    title: req.type === "return" ? "Return received" : "Stock issued to your van",
    body: req.type === "return" ? `Your return ${req.code} was scanned in at the warehouse.` : `Items from ${req.code} were scanned out to your van.`,
    data: { type: "vanstock", requestId: id },
  });
  return toPublic(updated, new Date(), scope);
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

// `scope` has NO default — same three-state sentinel as toPublic (undefined=admin, null=engineer,
// string[]=scoped). A default would coerce an admin's explicit `undefined` into `null` and blank isMine.
function paged(result: { requests: RequestWithLines[]; total: number }, page: number, pageSize: number, scope: string[] | undefined | null): PagedVanStockRequests {
  const now = new Date();
  return { requests: result.requests.map((r) => toPublic(r, now, scope)), total: result.total, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) };
}

export async function listMine(engineerId: string, params: { status?: string; type?: string; createdVia?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedVanStockRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  // Engineer's own list — scope null ⇒ isMine false, myProgress null (they have no warehouse role).
  return paged(await vsrRepo.listRequests({ ...params, engineerId, page, pageSize }), page, pageSize, null);
}

export async function listAll(actor: AuditActor, params: { status?: string; type?: string; priority?: string; createdVia?: string; search?: string; sort?: string; warehouseId?: string; page?: number; pageSize?: number }): Promise<PagedVanStockRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  if (params.warehouseId) assertWarehouseAccess(actor, params.warehouseId);
  const scope = warehouseScopeFilter(actor);
  return paged(await vsrRepo.listRequests({ ...params, warehouseScope: scope, page, pageSize }), page, pageSize, scope);
}

export function countPending(actor: AuditActor): Promise<number> {
  return vsrRepo.countPending(warehouseScopeFilter(actor));
}

// Count of the engineer's restocks awaiting collection — for the Engineer dashboard "Field stock to collect" card.
export function countCollectible(engineerId: string): Promise<number> {
  return vsrRepo.countCollectibleRestocks(engineerId);
}

// Accepts a db id OR a code ("VSR-0030") — the reviewer workspace deep-links by code, so a shared URL
// is readable. Resolution happens BEFORE any access check; every gate below runs on the resolved
// request, so which key opened it grants nothing.
export async function getOne(idOrCode: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = OBJECT_ID_RE.test(idOrCode) ? await vsrRepo.findById(idOrCode) : await vsrRepo.findByCode(idOrCode);
  if (!req) throw notFound("Van stock request not found.");
  const isOwner = (actor.id ?? "") === req.engineerId;
  if (!isReviewer(actor) && !isOwner) throw forbidden("You don't have access to this request.");
  // Warehouse-scoped reviewers may open a request if their scope covers ANY warehouse that owns it —
  // the final warehouse, the pending collection warehouse, OR any line's source warehouse. This mirrors
  // belongsToWarehouses() (the queue filter): a split request appears in a warehouse's queue because it
  // owns a line there, so that manager must be able to open it. The requesting engineer always sees theirs.
  if (!isOwner) assertRequestAccess(actor, req);
  // Reviewers get their warehouse scope (drives isMine/myProgress); the owner-engineer reading their
  // own request gets null (no warehouse role) so nothing reads as "mine to fulfil".
  const scope = isReviewer(actor) ? warehouseScopeFilter(actor) : null;
  return toPublic(req, new Date(), scope);
}

// Open line items on the engineer's own open requests — powers the composer's duplicate warning (spec §8).
export async function openLineItems(engineerId: string, type: string): Promise<Array<{ irmItemId: string; code: string }>> {
  return vsrRepo.findOpenLineItems(engineerId, type);
}

// Engineer's on-hand (return composer source). Serial/batch never reach the van via supported flows,
// but filter defensively.
export interface HoldingOption {
  irmItemId: string;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
}
export async function myHoldings(engineerId: string): Promise<HoldingOption[]> {
  // Show only the FREE (field) portion: global van holding MINUS what's committed to active jobs. Job
  // stock returns via the job's Close & Reconcile, so it must never appear as field-returnable here — an
  // item wholly committed to a job drops out (free 0). Same subtraction the create guard enforces.
  const [rows, committed] = await Promise.all([
    engineerStockRepo.findEngineerBalances(engineerId),
    jobCommittedByEngineer(engineerId),
  ]);
  return rows
    .filter((b) => !b.irmItem.trackSerialNumbers && !b.irmItem.trackBatchNumbers)
    .map((b) => ({ irmItemId: b.irmItemId, code: b.irmItem.code, name: b.irmItem.name, uom: b.irmItem.baseUnit ?? null, quantityOnHand: Math.max(0, b.quantityOnHand - (committed.get(b.irmItemId) ?? 0)) }))
    .filter((h) => h.quantityOnHand > 0);
}

// IRM catalogue search for the restock composer (active, non-serial/batch; capped; blank ⇒ empty).
export interface VanStockItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}
export async function searchItems(q: string): Promise<VanStockItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];
  const rows = await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name");
  return rows
    .filter((r) => !r.trackSerialNumbers && !r.trackBatchNumbers)
    .map((r) => ({ irmItemId: r.id, code: r.code, name: r.name, sku: r.sku ?? null, uom: r.baseUnit ?? null }));
}

// Catalogue search for the ENGINEER's restock composer. Warehouse-independent — the engineer picks a
// collect-from warehouse later and the reviewer confirms it — so every hit is annotated with the item's
// TOTAL on-hand across all active warehouses (network-wide availability). An item that is out of stock
// EVERYWHERE (total 0) can never be fulfilled by anyone — the reviewer's approve() availability hard-
// block rejects it from any source, so requesting it only rots in the queue and finally surfaces as a
// raw scan-time "below zero" error. Rather than hide it (the engineer wouldn't know why their item
// vanished), it's returned WITH quantityOnHand: 0 so the composer can show it disabled/"out of stock",
// non-selectable. Per-warehouse guidance (which warehouse has how many) still comes from availability()
// once items are added, and the reviewer re-checks authoritatively at approve.
export async function searchRequestableItems(q: string): Promise<WarehouseItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];
  const rows = (await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name")).filter((r) => !r.trackSerialNumbers && !r.trackBatchNumbers);
  if (rows.length === 0) return [];
  const warehouses = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(rows.map((r) => r.id), warehouses.map((w) => w.id));
  const totalByItem = new Map<string, number>();
  for (const b of balances) totalByItem.set(b.irmItemId, (totalByItem.get(b.irmItemId) ?? 0) + b.quantityOnHand);
  return rows.map((r) => ({
    irmItemId: r.id,
    code: r.code,
    name: r.name,
    sku: r.sku ?? null,
    uom: r.baseUnit ?? null,
    quantityOnHand: totalByItem.get(r.id) ?? 0, // network-wide total; 0 ⇒ shown disabled in the composer
    reorderLevel: r.reorderLevel ?? null,
  }));
}

// Warehouse-scoped catalogue search for the WALK-IN composer. A walk-in is issued at ONE counter and
// scanned out immediately, so — unlike the engineer's warehouse-independent restock composer — the
// search only ever surfaces stock THIS warehouse can actually hand out: every hit is annotated with
// that warehouse's live on-hand (and reorder level), and an item the warehouse doesn't physically hold
// (no balance row, or depleted to 0) is dropped entirely rather than shown disabled — the counter has
// no use for it. quantityOnHand mirrors what the scan-out ledger guards on (raw on-hand, not
// on-hand−reserved), so the figure the reviewer sees is exactly the one that would block at the gun.
// Access is gated on the actor owning the warehouse — a scoped reviewer can't probe another's shelf.
export interface WarehouseItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
  quantityOnHand: number;
  reorderLevel: number | null; // GLOBAL IRM policy threshold — advisory only, never blocks issuance
}
const WALK_IN_BROWSE_LIMIT = 50;
export async function searchWarehouseItems(actor: AuditActor, warehouseId: string, q: string): Promise<WarehouseItemOption[]> {
  assertWarehouseAccess(actor, warehouseId);
  const term = (q ?? "").trim();
  if (term.length < 1) {
    // No query yet → BROWSE list: everything this warehouse physically holds (on-hand > 0), so the
    // counter can pick straight off the shelf without typing. Active + non-serial/batch, name-sorted, capped.
    const balances = await inventoryRepo.findInStockBalancesByWarehouse(warehouseId, WALK_IN_BROWSE_LIMIT);
    return balances
      .filter((b) => !b.irmItem.trackSerialNumbers && !b.irmItem.trackBatchNumbers)
      .map((b) => ({ irmItemId: b.irmItemId, code: b.irmItem.code, name: b.irmItem.name, sku: b.irmItem.sku ?? null, uom: b.irmItem.baseUnit ?? null, quantityOnHand: b.quantityOnHand, reorderLevel: b.irmItem.reorderLevel ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // Typed search spans the catalogue (matches code/name/sku), then is narrowed to what THIS warehouse
  // actually holds: an item with no balance row here, or one depleted to 0, is dropped — a walk-in can
  // only hand out stock on the shelf. (This is why an item like a fibre panel that was never stocked at
  // this counter no longer appears as a phantom "out of stock" row.)
  const rows = (await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name")).filter((r) => !r.trackSerialNumbers && !r.trackBatchNumbers);
  if (rows.length === 0) return [];
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(rows.map((r) => r.id), [warehouseId]);
  const onHand = new Map(balances.map((b) => [b.irmItemId, b.quantityOnHand]));
  return rows
    .map((r) => ({
      irmItemId: r.id,
      code: r.code,
      name: r.name,
      sku: r.sku ?? null,
      uom: r.baseUnit ?? null,
      quantityOnHand: onHand.get(r.id) ?? 0,
      reorderLevel: r.reorderLevel ?? null,
    }))
    .filter((it) => it.quantityOnHand > 0);
}

// Active warehouses for the composer's preference picker (engineers hold no warehouse.view).
export interface WarehouseLite {
  id: string;
  name: string;
  code: string | null;
}
export async function listWarehousesLite(): Promise<WarehouseLite[]> {
  const rows = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  return rows.map((w) => ({ id: w.id, name: w.name, code: w.code ?? null }));
}

// Per-warehouse on-hand for the composer's cart items — lets the engineer pick a warehouse that can
// actually serve them and enter sensible quantities. ADVISORY only (stock moves before they arrive;
// the reviewer can still trim); quantities only, no cost/value.
export interface WarehouseAvailability {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  items: Array<{ irmItemId: string; quantityOnHand: number }>;
}
export async function availability(irmItemIds: string[]): Promise<WarehouseAvailability[]> {
  const ids = [...new Set(irmItemIds)].slice(0, 100);
  if (ids.length === 0) return [];
  const warehouses = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(ids, warehouses.map((w) => w.id));
  const byKey = new Map(balances.map((b) => [`${b.warehouseId}:${b.irmItemId}`, b.quantityOnHand]));
  return warehouses.map((w) => ({
    warehouseId: w.id,
    warehouseName: w.name,
    warehouseCode: w.code ?? null,
    items: ids.map((irmItemId) => ({ irmItemId, quantityOnHand: byKey.get(`${w.id}:${irmItemId}`) ?? 0 })),
  }));
}

export async function uploadImage(image: string, kind: "attachment" | "damage"): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  const folder = kind === "damage" ? "senthra/damage-photos" : "senthra/van-stock-requests";
  const url = await uploadToCloudinary(image, `vsr-${kind}-${Date.now()}`, creds, folder);
  return { url };
}
