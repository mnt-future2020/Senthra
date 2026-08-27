import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import { committedByEngineer, getOpenDemand } from "#modules/goods-management/goods-management.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import * as rentalPool from "#modules/purchase-order/rentalHire.pool.js";
import { allocateFromHires } from "#modules/purchase-order/rentalHire.allocation.js";
import { emitHireUpdated } from "#modules/purchase-order/rentalHire.realtime.js";
import { getCloudinaryCreds, getCompanyTimezone } from "#modules/settings/settings.service.js";
import { startOfDayIn } from "../../utils/filter-date.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitAttentionChanged, emitToRoom, emitToUser, VAN_STOCK_REVIEWERS_ROOM } from "../../lib/realtime.js";
import { assertWarehouseAccess, getAccessibleWarehouseIds, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as vsrRepo from "./van-stock-request.repository.js";
import type { CreateRequestData, CreateRequestLineData, FulfilEntry, RequestWithLines } from "./van-stock-request.repository.js";
import { randomUUID } from "node:crypto";
import { readPriority } from "./van-stock-request.validation.js";
import type {
  ApproveVanStockRequestInput,
  CloseShortInput,
  CreateVanStockRequestInput,
  DeclineVanStockRequestInput,
  FulfilVanStockRequestInput,
  ScanLookupInput,
  VanStockLineSource,
  VanStockPriority,
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
  // Which catalogue this line draws from. The UI keys its "Rental" badge off this rather than off a
  // null id, so a rental line can never read as a broken IRM one.
  source: string; // irm | rental
  irmItemId: string | null; // set when source is irm
  rentalItemId: string | null; // set when source is rental — the CATALOGUE item, never a hire
  itemName: string;
  code: string | null; // item code snapshot (IRM-0002 / RNT-0007) — shown + copyable in the UI
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
  // PER-LINE close-short: the source warehouse that owns this line writing off what it can't supply.
  // The request-level closedShort* fields predate close-short being per warehouse — on a split request
  // they name one warehouse's write-off while another's is invisible — so the line has to carry its
  // own. Without these a written-off line is indistinguishable from an untouched one (approved 6,
  // fulfilled 0), and the engineer's view calls it "Awaiting" stock that is never coming.
  closedShortQty: number | null;
  closedShortBy: string | null;
  closedShortNote: string | null;
  closedShortAt: string | null;
  // Per-line cancellation by the ENGINEER (cancel remaining) — kept apart from closedShort*, which is
  // the WAREHOUSE saying it can't supply. Same effect on the arithmetic, different story and actor.
  cancelledQty: number | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
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
  source: string; // irm | rental
  irmItemId: string | null;
  rentalItemId: string | null;
  // ── The ACTUAL hire these units moved on (rental postings only) ────────────────────────────────
  // The request names a catalogue item; this names the physical hire the warehouse reached for. The
  // reviewer's detail view shows it so nobody has to infer which order a Field Stock issue drew from,
  // and so the return can be reconciled against the same hire.
  purchaseOrderRentalLineId: string | null;
  poCode: string | null; // resolved for display, e.g. PO-0042
  hireEndDate: string | null; // the deadline these units have to be back by
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
  priority: VanStockPriority; // normalised on the way out — see readPriority()
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
    // Read through readPriority, not straight off the row: requests raised before "high" was retired
    // still hold it, and every client-side priority type is now the two-value scale.
    priority: readPriority(r.priority),
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
      source: l.source,
      irmItemId: l.irmItemId,
      rentalItemId: l.rentalItemId,
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
      closedShortQty: l.closedShortQty,
      closedShortBy: l.closedShortBy,
      closedShortNote: l.closedShortNote,
      closedShortAt: iso(l.closedShortAt),
      cancelledQty: l.cancelledQty,
      cancelledBy: l.cancelledBy,
      cancelledAt: iso(l.cancelledAt),
    })),
    fulfilments: r.fulfilments.map((f) => ({
      id: f.id,
      sequence: f.sequence,
      performedBy: f.performedBy,
      postedAt: f.postedAt.toISOString(),
      lines: f.lines.map((fl) => ({
        id: fl.id,
        lineId: fl.lineId,
        // Legacy postings predate the column and are all IRM, so an absent value reads as "irm"
        // rather than as an unknown third thing the UI would have no branch for.
        source: fl.rentalItemId ? "rental" : "irm",
        irmItemId: fl.irmItemId,
        rentalItemId: fl.rentalItemId,
        purchaseOrderRentalLineId: fl.purchaseOrderRentalLineId,
        poCode: fl.poCode,
        hireEndDate: iso(fl.hireEndDate),
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
  emitAttentionChanged("van_stock");
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
interface IncomingLine {
  source?: VanStockLineSource;
  irmItemId?: string;
  rentalItemId?: string;
  itemName: string;
  qty: number;
  warehouseId?: string;
}

async function resolveLines(
  lines: IncomingLine[],
  // Restock only: resolves each line's chosen collection warehouse. Omitted for returns/walk-in,
  // where one warehouse governs the whole request and the caller sets the source itself.
  sourceFor?: (warehouseId: string) => { id: string; name: string; code: string | null },
): Promise<CreateRequestLineData[]> {
  return Promise.all(
    lines.map(async (l): Promise<CreateRequestLineData> => {
      const src = sourceFor && l.warehouseId ? sourceFor(l.warehouseId) : null;
      // Set at CREATE for a restock now that the engineer picks per line — this is what routes the
      // request (belongsToWarehouses matches any line's source), so each warehouse sees only its own.
      const warehouse = src ? { sourceWarehouseId: src.id, sourceWarehouseName: src.name, sourceWarehouseCode: src.code } : {};

      if (l.source === "rental") {
        // The CATALOGUE item only. Which hire supplies it is decided at the warehouse scan — see the
        // schema note on the column — so nothing about a specific hire is resolved or trusted here.
        const item = await rentalItemRepo.findById(l.rentalItemId!);
        if (!item) throw badRequest(`The rental item for "${l.itemName}" no longer exists.`);
        // Refused rather than allowed-through-with-a-warning: a retired hire master is one the company
        // has stopped hiring, so a request for it can only ever be declined later, after the engineer
        // has already driven somewhere.
        if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
        return {
          source: "rental",
          rentalItemId: item.id,
          itemName: item.name,
          // A rental master carries no SKU by design; its `code` is the identifier AND the thing its
          // printed Code128 label encodes, which is what the warehouse scan resolves against.
          code: item.code ?? null,
          sku: null,
          uom: item.baseUnit ?? null,
          requestedQty: l.qty,
          ...warehouse,
        };
      }

      const item = await irmRepo.findById(l.irmItemId!);
      if (!item) throw badRequest(`The IRM item for "${l.itemName}" no longer exists.`);
      if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
      if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported on van stock requests.`);
      return {
        source: "irm",
        irmItemId: item.id,
        itemName: item.name,
        code: item.code ?? null,
        sku: item.sku ?? null,
        uom: item.baseUnit ?? null,
        requestedQty: l.qty,
        ...warehouse,
      };
    }),
  );
}

/**
 * Start of TODAY in the company timezone — the one date every hire-window comparison in a request is
 * judged against, resolved ONCE per request and passed down.
 *
 * Mirrors Goods Management's helper of the same name, and exists for the same correctness reason: a
 * multi-line approval evaluated at 23:59:59.9 that re-derived the date per line could judge line one
 * against yesterday and line two against today, and approve half a hire it had just refused.
 */
async function companyTodayStart(): Promise<Date> {
  return startOfDayIn(await getCompanyTimezone(), new Date());
}

// Load + validate every DISTINCT warehouse the restock's lines collect from, in one read per
// warehouse rather than one per line. An inactive warehouse can't be collected from, and its
// manager's queue is gone, so it's rejected here rather than surfacing at approve.
async function resolveLineWarehouses(
  lines: Array<{ warehouseId?: string }>,
): Promise<Map<string, { id: string; name: string; code: string | null }>> {
  const ids = [...new Set(lines.map((l) => l.warehouseId).filter((id): id is string => Boolean(id)))];
  const found = new Map<string, { id: string; name: string; code: string | null }>();
  await Promise.all(
    ids.map(async (id) => {
      const wh = await warehouseRepo.findById(id);
      if (!wh) throw badRequest("One of the selected collection warehouses no longer exists.");
      if (wh.status !== "active") throw badRequest(`"${wh.name}" is no longer active — pick another warehouse for that item.`);
      found.set(id, { id: wh.id, name: wh.name, code: wh.code ?? null });
    }),
  );
  return found;
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

  // Restock: every line names its own collection warehouse (validation enforces), so load them first
  // and stamp each line's source at create. Returns resolve with no per-line source — one destination
  // governs the whole request.
  const lineWarehouses = input.type === "restock" ? await resolveLineWarehouses(input.lines) : null;
  const lines = await resolveLines(
    input.lines,
    lineWarehouses ? (id) => lineWarehouses.get(id) ?? (() => { throw badRequest("That collection warehouse is no longer available."); })() : undefined,
  );

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
    // The RENTAL pool is read alongside, and subtracts its own job commitment for exactly the same
    // reason: hired kit issued against a job goes back through that job's scan-in, which is what
    // clears the job's awaiting_return and releases the units to the provider. Let it leave through
    // this door instead and the custody row drains while the job still believes the kit is out.
    //
    // Held per CATALOGUE item, summed across however many hires the units sit on — which hire each
    // unit goes back on is resolved later, at the warehouse scan, by the shared returnable-hire policy.
    // ONE read of the engineer's active jobs and their movements for BOTH pools — see
    // committedByEngineer. Resolved separately these two walked the same job set and the same
    // movement set twice for one request.
    const [balanceRows, jobCommitted, rentalHoldings] = await Promise.all([
      engineerStockRepo.findEngineerBalances(engineerId),
      committedByEngineer(engineerId),
      rentalCustodyRepo.findRentalHoldingsByEngineer(engineerId),
    ]);
    const committed = jobCommitted.irm;
    const rentalCommitted = jobCommitted.rental;
    const balances = new Map(balanceRows.map((b) => [b.irmItemId, b.quantityOnHand]));
    const rentalHeld = new Map<string, number>();
    for (const h of rentalHoldings) {
      if (!h.rentalItemId) continue;
      rentalHeld.set(h.rentalItemId, (rentalHeld.get(h.rentalItemId) ?? 0) + h.quantityOnHand);
    }
    for (const l of lines) {
      if (l.source === "rental") {
        const free = Math.max(0, (rentalHeld.get(l.rentalItemId!) ?? 0) - (rentalCommitted.get(l.rentalItemId!) ?? 0));
        if (free < l.requestedQty) {
          throw badRequest(`You only have ${free} of "${l.itemName}" free to return — the rest is out on a job (return it through that job).`);
        }
        continue;
      }
      const free = Math.max(0, (balances.get(l.irmItemId!) ?? 0) - (committed.get(l.irmItemId!) ?? 0));
      if (free < l.requestedQty) {
        throw badRequest(`You only have ${free} of "${l.itemName}" free to return — the rest is committed to a job (return it through that job).`);
      }
    }
  } else {
    // Restock. The collection point is DERIVED from the lines, never taken from the client: when every
    // line collects from the same warehouse that warehouse is the request's single pickup (and the
    // lists can name it); when they differ this is a split, and naming any one of them would send the
    // engineer to the wrong place — so it stays null and the per-line sources speak for themselves.
    // Routing does not depend on it either way: belongsToWarehouses() already matches a request by any
    // line's sourceWarehouseId, so each source warehouse sees this request from the moment it exists.
    const distinct = [...lineWarehouses!.values()];
    preferred = distinct.length === 1 ? distinct[0]! : null;
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
  // IRM only — walkInSchema refuses rental lines outright (hired kit is not issued over the counter
  // in this phase), so every line here has an irmItemId. The filter is what proves that to the type
  // system rather than asserting it.
  const walkInItemIds = lines.map((l) => l.irmItemId).filter((x): x is string => Boolean(x));
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(walkInItemIds, [wh.id]);
  assertWalkInAvailability(
    lines.map((l) => ({ irmItemId: l.irmItemId as string, itemName: l.itemName, requestedQty: l.requestedQty })),
    wh.name,
    new Map(balances.map((b) => [b.irmItemId, b.quantityOnHand])),
  );

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

// ── Rental availability: free-on-hire, net of what jobs have already planned ────────────────────
//
// Keyed `${rentalItemId}|${warehouseId}`, the same shape the shared pool returns.
//
// TWO subtractions, and both are load-bearing:
//
//   FREE ON HIRE — `rentalPoolByItemAndWarehouse`, which is `received − returned − lost − issued`
//   minus anything reported damaged, over the hires that are ISSUABLE today. An expired hire
//   contributes nothing however many units of it stand on the shelf; that is the whole point of the
//   issuable-vs-live split, and it is why this must never be used to answer a RETURN question.
//
//   OPEN JOB DEMAND — hired units active jobs have planned but not yet collected. Without this a
//   Field Stock request could be approved for the last tester a job was counting on, and the job
//   would discover it only when its engineer arrived at the counter. The job planner has always shown
//   its own figure net of demand, so this is the same physical equipment answering the same question
//   the same way. `getOpenDemand` already emits rental demand under a `rental|item|warehouse` key.
//
// Floored at zero per depot: demand can legitimately exceed what is free, and "−2 available" helps
// nobody. Floored PER DEPOT rather than on the total, so one over-committed site cannot wipe out
// hires standing at another.
async function rentalFreeByItemAndWarehouse(
  rentalItemIds: string[],
  warehouseIds: string[],
  todayStart: Date,
  // The caller's ALREADY-LOADED demand snapshot, when it has one.
  //
  // `getOpenDemand()` walks every active job and every movement on them. Both callers that pair this
  // helper with an IRM pool were computing that twice for one logical request — once here and once
  // for their own arithmetic — and on `searchRequestableItems` that is a per-keystroke path. Passing
  // the snapshot in makes it one scan per request; omitting it keeps the helper usable on its own.
  //
  // A PARAMETER, not a cache: nothing is memoised across requests, users or warehouses, so the figure
  // is exactly as fresh as it was before. The only thing that changed is how many times one request
  // asks for it.
  preloadedDemand?: Awaited<ReturnType<typeof getOpenDemand>>,
): Promise<Map<string, number>> {
  if (rentalItemIds.length === 0) return new Map();
  const [pool, demand] = await Promise.all([
    rentalPool.rentalPoolByItemAndWarehouse(rentalItemIds, warehouseIds, todayStart),
    preloadedDemand ?? getOpenDemand(),
  ]);
  const demandByKey = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.rentalItemId || !d.warehouseId) continue;
    const k = `${d.rentalItemId}|${d.warehouseId}`;
    demandByKey.set(k, (demandByKey.get(k) ?? 0) + d.demand);
  }
  const out = new Map<string, number>();
  for (const [key, free] of pool) out.set(key, Math.max(0, free - (demandByKey.get(key) ?? 0)));
  return out;
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
  // sourceWarehouseId is the warehouse the ENGINEER chose for this line at create. It is the default
  // now — the primary is only a fallback for legacy requests raised before per-line selection, and for
  // returns/walk-ins. Defaulting to the primary instead would silently re-point every line at whatever
  // warehouse the reviewer happens to be sitting in, quietly undoing the engineer's route.
  reqLines: Array<{ id: string; source: string; irmItemId: string | null; rentalItemId: string | null; itemName: string; requestedQty: number; sourceWarehouseId?: string | null; sourceWarehouseName?: string | null; sourceWarehouseCode?: string | null }>,
  lineApprovals: Array<{ lineId: string; approvedQty: number; sourceWarehouseId?: string }>,
  primary: { id: string; name: string; code: string | null },
  findWarehouse: (id: string) => Promise<{ id: string; name: string; code: string | null } | null>,
  findBalances: (irmItemIds: string[], warehouseIds: string[]) => Promise<Array<{ irmItemId: string; warehouseId: string; quantityOnHand: number }>>,
  // The RENTAL twin, injected the same way. A separate resolver rather than a flag on findBalances
  // because a hire has no InventoryBalance row to read at all — the figure is COMPUTED from the live
  // hires at that depot. Returns `${rentalItemId}|${warehouseId}` → free units.
  findRentalFree: (rentalItemIds: string[], warehouseIds: string[]) => Promise<Map<string, number>>,
): Promise<ResolvedLineApproval[]> {
  const byLine = new Map(lineApprovals.map((a) => [a.lineId, a]));

  type Resolved = ResolvedLineApproval & { source: string; irmItemId: string | null; rentalItemId: string | null; itemName: string };
  // First pass: resolve qty + chosen source per line, validating the trim ceiling + active warehouse.
  const resolved = await Promise.all(
    reqLines.map(async (l): Promise<Resolved> => {
      const identity = { source: l.source, irmItemId: l.irmItemId, rentalItemId: l.rentalItemId, itemName: l.itemName };
      const a = byLine.get(l.id);
      const approvedQty = a?.approvedQty ?? l.requestedQty;
      if (approvedQty > l.requestedQty) throw badRequest(`"${l.itemName}": approved quantity can't exceed the requested ${l.requestedQty}.`);
      if (approvedQty === 0) {
        // KEEP the source on an excluded line. Nulling it made sense when one approval covered the
        // whole request, but the source is now what says WHICH warehouse a line belongs to: a
        // sourceless line reads as unowned/legacy, so an item London excluded reappeared in every
        // other warehouse's queue — and blocked their Approve, because it had no source. The line is
        // still excluded (approvedQty 0 ⇒ done, nothing issuable); it just remembers whose call it was.
        return { lineId: l.id, approvedQty: 0, sourceWarehouseId: l.sourceWarehouseId ?? null, sourceWarehouseName: l.sourceWarehouseName ?? null, sourceWarehouseCode: l.sourceWarehouseCode ?? null, ...identity };
      }
      // Reviewer override → the engineer's own choice → the primary.
      const sourceId = a?.sourceWarehouseId ?? l.sourceWarehouseId ?? primary.id;
      const sw = sourceId === primary.id ? primary : await findWarehouse(sourceId);
      if (!sw) throw badRequest(`"${l.itemName}": the chosen source warehouse no longer exists or isn't active.`);
      return { lineId: l.id, approvedQty, sourceWarehouseId: sw.id, sourceWarehouseName: sw.name, sourceWarehouseCode: sw.code, ...identity };
    }),
  );

  // Second pass: batched availability re-check over the distinct (item, source) pairs of INCLUDED
  // lines. The two pools are read SEPARATELY because they are genuinely different questions asked of
  // different tables — company stock has a balance row, a hire is summed from the depot's live hires.
  const included = resolved.filter((r) => r.approvedQty > 0 && r.sourceWarehouseId);
  const irmIncluded = included.filter((r) => r.source !== "rental" && r.irmItemId);
  const rentalIncluded = included.filter((r) => r.source === "rental" && r.rentalItemId);
  const whIds = [...new Set(included.map((r) => r.sourceWarehouseId as string))];

  const [balances, rentalFree] = await Promise.all([
    irmIncluded.length > 0 ? findBalances([...new Set(irmIncluded.map((r) => r.irmItemId as string))], whIds) : Promise.resolve([]),
    rentalIncluded.length > 0 ? findRentalFree([...new Set(rentalIncluded.map((r) => r.rentalItemId as string))], whIds) : Promise.resolve(new Map<string, number>()),
  ]);

  const onHand = new Map(balances.map((b) => [`${b.warehouseId}:${b.irmItemId}`, b.quantityOnHand]));
  for (const r of irmIncluded) {
    const have = onHand.get(`${r.sourceWarehouseId}:${r.irmItemId}`) ?? 0;
    if (have < r.approvedQty) {
      throw badRequest(`"${r.itemName}": only ${have} in stock at ${r.sourceWarehouseName ?? "the chosen warehouse"} — refresh and adjust.`);
    }
  }
  for (const r of rentalIncluded) {
    // A depot holding no live hire of this item resolves to 0, which is the correct answer and the
    // one that produces a usable message — the reviewer is told this depot cannot supply it, rather
    // than the line silently passing because no row was found.
    const have = rentalFree.get(`${r.rentalItemId}|${r.sourceWarehouseId}`) ?? 0;
    if (have < r.approvedQty) {
      throw badRequest(`"${r.itemName}": only ${have} free on hire at ${r.sourceWarehouseName ?? "the chosen warehouse"} — refresh and adjust.`);
    }
  }

  return resolved.map(({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }) => ({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }));
}

export async function approve(id: string, input: ApproveVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.type !== "restock") throw conflict("Returns don't need approval — scan them in to accept.");
  // Terminal states only. `status !== "pending"` used to gate this, which is wrong now that each
  // warehouse decides separately: the FIRST approval moves the request to `approved`, and the second
  // warehouse must still be able to answer for its own lines.
  if (["declined", "cancelled", "fulfilled"].includes(req.status)) throw conflict(`This request has already been ${req.status}.`);
  assertRequestAccess(actor, req);

  const wh = await warehouseRepo.findById(input.warehouseId);
  if (!wh) throw badRequest("The chosen warehouse no longer exists.");
  if (wh.status !== "active") throw badRequest("The chosen warehouse is no longer active.");
  assertWarehouseAccess(actor, wh.id);

  // MY lines = the undecided ones sourced to THE WAREHOUSE BEING ACTED FOR — not to everything the
  // actor happens to have rights over. Scoping by the actor's permissions instead meant an
  // unrestricted actor (a super admin, who has no warehouse scope at all) reviewing from London's tab
  // silently answered for every other warehouse's lines too, so the warehouse that actually held the
  // stock never got to decide. assertWarehouseAccess above already proves they may act for this one.
  // Legacy lines carry no source and stay claimable by whichever warehouse opens them, else requests
  // raised before per-line selection would be approvable by nobody; the atomic claim settles ties.
  const mine = req.lines.filter((l) => l.approvedQty === null && (l.sourceWarehouseId === wh.id || l.sourceWarehouseId === null));
  if (mine.length === 0) throw conflict("There are no lines here for you to review — another warehouse has already answered for them.");

  // Resolve + hard-block on live availability, over MY lines only (authoritative — never trust the UI).
  const lineApprovals = await resolveLineApprovals(
    mine,
    input.lineApprovals ?? [],
    { id: wh.id, name: wh.name, code: wh.code ?? null },
    async (whId) => {
      const w = await warehouseRepo.findById(whId);
      return w && w.status === "active" ? { id: w.id, name: w.name, code: w.code ?? null } : null;
    },
    (itemIds, whIds) => inventoryRepo.findBalancesByItemsAndWarehouses(itemIds, whIds),
    // `todayStart` resolved once for this approval — every rental line on it is judged against the
    // same calendar date, so a multi-line approve at midnight cannot straddle two.
    async (rentalIds, whIds) => rentalFreeByItemAndWarehouse(rentalIds, whIds, await companyTodayStart()),
  );

  const updated = await vsrRepo.claimLinesForReview(
    id,
    lineApprovals.map((l) => ({ ...l, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null })),
    { warehouseId: wh.id, warehouseName: wh.name, warehouseCode: wh.code ?? null, reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null },
  );

  audit.record({ actor, action: "van_stock_request.approved", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { warehouseId: wh.id, decisionNote: input.decisionNote ?? null, lineApprovals: lineApprovals.map((l) => ({ lineId: l.lineId, approvedQty: l.approvedQty, sourceWarehouseId: l.sourceWarehouseId })) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });

  // Notify per DECISION, not per request: this warehouse answered for its own lines, and another may
  // still be deciding. Naming the warehouse is what makes a second notification make sense.
  const sources = [...new Set(lineApprovals.filter((l) => l.approvedQty > 0 && l.sourceWarehouseName).map((l) => l.sourceWarehouseName as string))];
  const byId = new Map(req.lines.map((l) => [l.id, l]));
  const trimmed = lineApprovals.filter((l) => l.approvedQty > 0 && l.approvedQty < (byId.get(l.lineId)?.requestedQty ?? 0));
  const excluded = lineApprovals.filter((l) => l.approvedQty === 0);
  const changes = [
    ...trimmed.map((l) => `${byId.get(l.lineId)?.itemName ?? "an item"} cut to ${l.approvedQty}`),
    ...excluded.map((l) => `${byId.get(l.lineId)?.itemName ?? "an item"} excluded`),
  ];
  const stillWaiting = updated.lines.some((l) => l.approvedQty === null);
  const where = sources.length > 0 ? `ready to collect from ${sources.join(", ")}` : "no items approved here";
  notify(req.engineerId, {
    title: changes.length > 0 ? `${wh.name} approved with changes` : `${wh.name} approved your request`,
    body: `${req.code} — ${where}.${changes.length > 0 ? ` Changed: ${changes.join("; ")}.` : ""}${stillWaiting ? " Other warehouses are still reviewing their items." : ""}`,
    data: { type: "vanstock", requestId: id },
  });
  return toPublic(updated, new Date(), warehouseScopeFilter(actor));
}

export async function decline(id: string, input: DeclineVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (["declined", "cancelled", "fulfilled"].includes(req.status)) throw conflict(`This request has already been ${req.status}.`);
  // Ownership guard — the SAME rule every other reviewer entry point uses: a request belongs to its
  // final warehouse, its pending collection warehouse, AND every line's source. This used to read
  // `warehouseId ?? preferredWarehouseId` only, which predates the engineer choosing a collection
  // warehouse per line: on a SPLIT restock both of those are null, so the guard fell through to its
  // fail-closed branch and NO warehouse-scoped reviewer could decline a split request at all.
  assertRequestAccess(actor, req);

  // Declining is now "I can't supply MY lines", not "this whole request is refused". A warehouse
  // never speaks for stock it doesn't hold — the request is only marked declined once every line has
  // been answered and none survived (decided in claimLinesForReview). Scoped by the warehouse being
  // ACTED FOR, not the actor's rights: an unrestricted actor has no warehouse scope, so the old rule
  // let a super admin refuse every warehouse's lines from one tab.
  assertWarehouseAccess(actor, input.warehouseId);
  const mine = req.lines.filter((l) => l.approvedQty === null && (l.sourceWarehouseId === input.warehouseId || l.sourceWarehouseId === null));
  if (mine.length === 0) throw conflict("There are no lines here for you to decline — another warehouse has already answered for them.");

  const updated = await vsrRepo.claimLinesForReview(
    id,
    // Excluded, with THIS warehouse's reason recorded against its own lines.
    mine.map((l) => ({
      lineId: l.id,
      approvedQty: 0,
      sourceWarehouseId: l.sourceWarehouseId,
      sourceWarehouseName: l.sourceWarehouseName,
      sourceWarehouseCode: l.sourceWarehouseCode,
      reviewedByEmail: actor.email ?? null,
      decisionNote: input.decisionNote,
    })),
    { warehouseId: null, warehouseName: null, warehouseCode: null, reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote },
  );

  audit.record({ actor, action: "van_stock_request.declined", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { decisionNote: input.decisionNote, lineIds: mine.map((l) => l.id) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  const whName = mine[0]?.sourceWarehouseName ?? "A warehouse";
  const items = mine.map((l) => l.itemName).join(", ");
  notify(req.engineerId, {
    title: updated.status === "declined" ? "Field stock declined" : `${whName} can't supply some items`,
    body: updated.status === "declined"
      ? `Your field stock request ${req.code} was declined — ${input.decisionNote}`
      : `${req.code} — ${whName} declined: ${items}. ${input.decisionNote}`,
    data: { type: "vanstock", requestId: id },
  });
  return toPublic(updated, new Date(), warehouseScopeFilter(actor));
}

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
  // Approved-but-unissued counts: per-warehouse review moves a request to `approved` on the FIRST
  // warehouse's answer, so this is where a split request now spends most of its life.
  if (!["approved", "partially_fulfilled"].includes(req.status)) throw conflict("Only an approved or partly fulfilled request has a remainder to cancel.");
  const count = await vsrRepo.finishRemaining(id, { completionType: "cancelled_remaining", engineerId: actor.id ?? "", cancelledBy: actor.email ?? null });
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
  // Scoped to ONE warehouse (the tab) — the actor must hold it, and only ITS lines are closed short,
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
  // "closed short", not "written off" — write-off is this app's word for draining a real ledger
  // (goods-management job_lost). Nothing leaves a ledger here: the remainder was approved but never
  // issued, so it was never stock. See customers/CloseShortModal for the same distinction.
  notify(req.engineerId, { title: "Request closed short", body: `Request ${req.code} was closed short — the remaining items won't be supplied.`, data: { type: "vanstock", requestId: id } });
  return toPublic(updated, new Date(), warehouseScopeFilter(actor));
}

// ── scan-lookup (reviewer; spec §7 barcode rules) ───────────────────────────────────────────────

/** One hire a scanned rental line would bind to, and how many of its units. PREVIEW ONLY. */
export interface ScanLookupHire {
  purchaseOrderRentalLineId: string;
  poCode: string | null;
  hireEndDate: string | null;
  overdue: boolean;
  qty: number;
}

export interface ScanLookupResult {
  source: string; // irm | rental
  irmItemId: string | null;
  rentalItemId: string | null;
  lineId: string;
  itemName: string;
  uom: string | null;
  remainingQty: number;
  available: number | null; // restock: warehouse on-hand / free-on-hire; return: engineer on-hand
  // Rental only, and deliberately ADVISORY — the panel shows which hire the units are expected to
  // come off (and its deadline) so the warehouse can see what it is handing over or taking back.
  //
  // The client never sends these back. Accepting a hire id from a caller would let a crafted request
  // name a hire at another depot, or one this engineer never held, and bypass the warehouse and
  // custody checks entirely. `fulfil` re-resolves the binding server-side from the same shared policy,
  // so this preview can only ever be wrong in the direction of being re-derived correctly.
  hires: ScanLookupHire[];
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

  // IRM first, then rental — the SAME order Goods Management resolves a scan in, so one physical
  // label can never mean different things at the two guns. A rental item's printed label is
  // Code128 of its own `code`, which is why the rental lookup is by code alone: there is no
  // manufacturer barcode or SKU on a hire master to match against.
  const item = await irmService.findActiveByCodeOrBarcode(input.code);
  if (!item) return rentalScanLookup(req, input, actor);
  if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported here.`);

  const line = req.lines.find((l) => l.source !== "rental" && l.irmItemId === item.id);
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
  return { source: "irm", irmItemId: item.id, rentalItemId: null, lineId: line.id, itemName: item.name, uom: item.baseUnit ?? null, remainingQty, available, hires: [] };
}

/**
 * The RENTAL arm of the scan, reached when no IRM item matched the code.
 *
 * Structured as its own function rather than another branch inside `scanLookup` because the two ask
 * genuinely different questions of different tables — and because the ISSUE and RETURN legs of a hire
 * are themselves opposites: issue may only touch hires still inside their period, while a return must
 * be able to bind an EXPIRED one. That is the whole reason the repository has two finders, and mixing
 * the legs is what would leave overdue kit sitting in a van with nothing to scan it against.
 */
async function rentalScanLookup(req: RequestWithLines, input: ScanLookupInput, actor: AuditActor): Promise<ScanLookupResult> {
  const rentalItem = await rentalItemRepo.findActiveByCode(input.code);
  if (!rentalItem) throw badRequest("No active catalogue item matches that code.");

  const line = req.lines.find((l) => l.source === "rental" && l.rentalItemId === rentalItem.id);
  if (!line) throw badRequest(`"${rentalItem.name}" isn't on this request.`);
  // Same per-tab rule as the IRM arm: a line is only ever handled from the warehouse it belongs to.
  if (line.sourceWarehouseId && line.sourceWarehouseId !== input.warehouseId) {
    throw badRequest(`"${rentalItem.name}" is issued from ${line.sourceWarehouseName ?? "another warehouse"} — scan it from that warehouse.`);
  }
  const remainingQty = vsrRepo.lineRemaining(line);
  if (remainingQty <= 0) throw badRequest(`"${rentalItem.name}" is already fully fulfilled on this request.`);
  if (!line.sourceWarehouseId) throw conflict(`"${rentalItem.name}" has not been sourced to a warehouse yet.`);
  const scope = warehouseScopeFilter(actor);
  if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
    throw forbidden(`"${rentalItem.name}" is sourced to a warehouse you don't have access to.`);
  }

  const todayStart = await companyTodayStart();
  const base = { source: "rental" as const, irmItemId: null, rentalItemId: rentalItem.id, lineId: line.id, itemName: rentalItem.name, uom: rentalItem.baseUnit ?? null, remainingQty };

  if (req.type === "return") {
    // Every LIVE hire here, expired ones very much included — an expired hire is exactly what a
    // return needs to bind to. The custody rows say which hires the units actually came off; the
    // shared policy picks among them (soonest deadline first, this depot's hires preferred).
    const [liveHires, held] = await Promise.all([
      poRepo.findLiveHiresByRentalItems([rentalItem.id], [line.sourceWarehouseId]),
      rentalCustodyRepo.findRentalHoldingsByEngineer(req.engineerId),
    ]);
    const candidates = rentalPool.pickReturnableHoldings(held, rentalItem.id, new Set(liveHires.map((h) => h.id)));
    if (candidates.length === 0) throw badRequest(`${rentalItem.name} isn't currently out with this engineer.`);
    const hires = rentalPool.allocateAcrossHoldings(candidates, remainingQty).map(({ holding: h, qty }) => ({
      purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
      poCode: h.poCode,
      hireEndDate: h.hireEndDate?.toISOString() ?? null,
      // On a RETURN an overdue hire is not a warning, it is the good news — the kit is coming back.
      // Reported anyway so the panel can say which hire it clears.
      overdue: h.hireEndDate ? h.hireEndDate.getTime() < todayStart.getTime() : false,
      qty,
    }));
    return { ...base, available: candidates.reduce((s, h) => s + h.quantityOnHand, 0), hires };
  }

  // RESTOCK. Only hires we may still lend, so an expired one is not offered however many units of it
  // sit on the shelf. Netted against open job demand for the same reason approve is: the last tester a
  // job has planned is not free for a Field Stock collection.
  const free = (await rentalFreeByItemAndWarehouse([rentalItem.id], [line.sourceWarehouseId], todayStart)).get(`${rentalItem.id}|${line.sourceWarehouseId}`) ?? 0;
  if (free <= 0) {
    throw badRequest(
      `No ${rentalItem.name} is available to issue at this warehouse — every hired unit is already out, planned for a job, has gone back to the provider, or sits on a hire whose period has ended.`,
    );
  }
  const issuable = await poRepo.findIssuableHiresByRentalItems([rentalItem.id], todayStart, [line.sourceWarehouseId]);
  // Preview only, and capped at BOTH what the line still owes and what is genuinely free — so the
  // panel never stages a row the posting would then refuse.
  const allocation = allocateFromHires(issuable, Math.min(remainingQty, free)) ?? [];
  return {
    ...base,
    available: free,
    hires: allocation.map(({ hire, qty }) => ({
      purchaseOrderRentalLineId: hire.id,
      poCode: hire.poCode,
      hireEndDate: hire.hireEndDate?.toISOString() ?? null,
      overdue: false, // issuable hires are inside their period by definition
      qty,
    })),
  };
}

// ── fulfil (reviewer; one atomic posting — spec §5/§6) ─────────────────────────────────────────

// Map each fulfil entry to the warehouse that must issue it — its LINE's sourceWarehouseId — and
// enforce the actor may act for that warehouse. scope: undefined = unrestricted (admin); string[] =
// the actor's warehouse ids. Throws on an entry whose line is unsourced or out of the actor's scope.
export function resolveFulfilWarehouses(
  // Source-agnostic on purpose: which warehouse must issue a line is a property of the LINE, not of
  // the catalogue it draws from, so this rule is identical for company stock and hired kit.
  reqLines: Array<{ id: string; itemName: string; sourceWarehouseId: string | null; sourceWarehouseName?: string | null }>,
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

/**
 * Turn the reviewer's scanned entries into the rows that will actually be posted.
 *
 * An IRM entry passes through one-for-one. A RENTAL entry is EXPANDED: the units it covers are bound
 * to real hires here — one posted row per hire — because a request line names a catalogue item and
 * only a hire carries the deadline and the provider we owe the kit back to. Five testers may well
 * come off two orders, and each row has to say which.
 *
 * BINDING IS SERVER-SIDE, ALWAYS. The client sends an item and a quantity, never a hire id. Accepting
 * one would let a crafted request name a hire at another depot, or one this engineer never held, and
 * walk straight past the warehouse and custody checks. Everything below is re-derived from the
 * request's own lines and the engineer's own custody rows.
 *
 * Resolution happens BEFORE the transaction, mirroring Goods Management: the posting then re-asserts
 * every binding atomically (`adjustHireIssuedQtyTx` on the way out, the custody floor guard on the way
 * back), so a hire that moved between the two fails the write rather than corrupting a balance.
 */
async function expandFulfilEntries(
  req: RequestWithLines,
  input: FulfilVanStockRequestInput,
  byLine: Map<string, RequestWithLines["lines"][number]>,
): Promise<FulfilEntry[]> {
  const hasRental = input.entries.some((e) => byLine.get(e.lineId)?.source === "rental");
  const todayStart = hasRental ? await companyTodayStart() : new Date();
  // Loaded ONCE for the whole posting rather than per entry — a return posting can carry many lines,
  // and the engineer's custody set is the same set for all of them.
  const held = hasRental && req.type === "return" ? await rentalCustodyRepo.findRentalHoldingsByEngineer(req.engineerId) : [];
  // Units already spoken for by an EARLIER entry in this same posting. Without this, two entries
  // against one hire would each be allocated the hire's full free quantity and the posting would
  // commit more units than exist — the transaction's atomic guard would catch it, but only after
  // presenting the reviewer a posting that looked fine.
  const spent = new Map<string, number>();
  // A damaged return opens a custody exit keyed on (posting, hire), so a SECOND damaged row against
  // the same hire in one posting collides — and createExitTx reads a collision as an idempotent retry,
  // returning the first row while the second entry's units are still drained from custody with nothing
  // holding them down. Refusing is right rather than merging: two damage reports are two reasons and
  // two photographs, and picking one of each to keep is not a decision this layer can make.
  const damagedHires = new Set<string>();
  const out: FulfilEntry[] = [];

  // Hires for the WHOLE posting, in one query, keyed `rentalItemId|warehouseId`.
  //
  // This lookup used to sit inside the loop below — one round trip per entry, against a posting the
  // reviewer can scan up to a hundred lines into, and every one of those queries asking about the same
  // depot. The custody read above was already hoisted for exactly this reason; this is its other half.
  //
  // Keyed by the PAIR rather than fetched per item, because the two legs need different sets and both
  // are scoped per depot: the return leg wants every LIVE hire here (expired included — an expired hire
  // is precisely what a return binds to), the issue leg only ISSUABLE ones (expired excluded, which is
  // what `todayStart` inside the query does). Batching does not blur that: the two sets are built by
  // two different queries, exactly as before.
  const rentalPairs = new Map<string, { rentalItemId: string; warehouseId: string }>();
  for (const e of input.entries) {
    const line = byLine.get(e.lineId);
    if (!line || line.source !== "rental" || !line.rentalItemId || !line.sourceWarehouseId) continue;
    rentalPairs.set(`${line.rentalItemId}|${line.sourceWarehouseId}`, { rentalItemId: line.rentalItemId, warehouseId: line.sourceWarehouseId });
  }
  const pairItemIds = [...new Set([...rentalPairs.values()].map((p) => p.rentalItemId))];
  const pairWarehouseIds = [...new Set([...rentalPairs.values()].map((p) => p.warehouseId))];
  const hiresByPair = new Map<string, Awaited<ReturnType<typeof poRepo.findLiveHiresByRentalItems>>>();
  if (pairItemIds.length > 0) {
    // The repository returns every hire matching ANY of the items at ANY of the warehouses, so the
    // rows are re-grouped onto the exact pair each entry asks for. A hire at a depot no entry named
    // simply never gets looked up. Ordering (soonest deadline first) is the query's, and grouping
    // preserves it — which is what keeps earliest-deadline-first allocation intact.
    const rows = req.type === "return"
      ? await poRepo.findLiveHiresByRentalItems(pairItemIds, pairWarehouseIds)
      : await poRepo.findIssuableHiresByRentalItems(pairItemIds, todayStart, pairWarehouseIds);
    for (const h of rows) {
      const key = `${h.rentalItemId}|${h.warehouseId}`;
      const list = hiresByPair.get(key);
      if (list) list.push(h);
      else hiresByPair.set(key, [h]);
    }
  }

  for (const e of input.entries) {
    const line = byLine.get(e.lineId);
    if (!line) throw badRequest("An entry doesn't belong to this request.");
    const common = { lineId: e.lineId, condition: e.condition, damagePhotoUrl: e.damagePhotoUrl ?? null, damageReason: e.damageReason ?? null, scannedCode: e.scannedCode ?? null };

    if (line.source !== "rental") {
      out.push({ ...common, source: "irm", irmItemId: line.irmItemId, itemName: line.itemName, qty: e.qty });
      continue;
    }

    const rentalItemId = line.rentalItemId;
    // Defensive, not decorative: a rental line with no catalogue id could only come from a hand-edited
    // row, and silently posting it as IRM would move company stock for a hire.
    if (!rentalItemId) throw conflict(`"${line.itemName}" is a rental line with no catalogue item — it can't be fulfilled.`);
    const warehouseId = line.sourceWarehouseId;
    if (!warehouseId) throw conflict(`"${line.itemName}" has not been sourced to a warehouse yet — it can't be fulfilled.`);

    let allocations: Array<{ purchaseOrderRentalLineId: string; poCode: string | null; hireEndDate: Date | null; qty: number }>;

    if (req.type === "return") {
      // Every LIVE hire at this depot — expired ones INCLUDED, which is the opposite of the issue leg
      // and deliberately so: an expired hire is precisely what a return needs to bind to, and
      // narrowing here would strand overdue kit in a van with nothing to scan it against.
      const liveHires = hiresByPair.get(`${rentalItemId}|${warehouseId}`) ?? [];
      const candidates = rentalPool
        .pickReturnableHoldings(held, rentalItemId, new Set(liveHires.map((h) => h.id)))
        // Net off what earlier entries in this posting already claimed.
        .map((h) => ({ ...h, quantityOnHand: h.quantityOnHand - (spent.get(h.purchaseOrderRentalLineId) ?? 0) }))
        .filter((h) => h.quantityOnHand > 0);
      const picked = rentalPool.allocateAcrossHoldings(candidates, e.qty);
      const total = picked.reduce((s, p) => s + p.qty, 0);
      if (total < e.qty) {
        throw conflict(`"${line.itemName}": this engineer is only holding ${total} of that hire — refresh and scan again.`);
      }
      allocations = picked.map(({ holding: h, qty }) => ({ purchaseOrderRentalLineId: h.purchaseOrderRentalLineId, poCode: h.poCode, hireEndDate: h.hireEndDate, qty }));
    } else {
      const issuable = (hiresByPair.get(`${rentalItemId}|${warehouseId}`) ?? [])
        .map((h) => ({ ...h, issuedQuantity: h.issuedQuantity + (spent.get(h.id) ?? 0) }));
      const picked = allocateFromHires(issuable, e.qty);
      if (!picked) {
        throw conflict(`"${line.itemName}": there aren't ${e.qty} free on hire at this warehouse any more — its period may have ended, or the stock changed. Refresh and scan again.`);
      }
      allocations = picked.map(({ hire, qty }) => ({ purchaseOrderRentalLineId: hire.id, poCode: hire.poCode, hireEndDate: hire.hireEndDate, qty }));
    }

    for (const a of allocations) {
      if (e.condition === "damaged") {
        if (damagedHires.has(a.purchaseOrderRentalLineId)) {
          throw badRequest(`"${line.itemName}": only one damaged entry per hire in a single posting — combine them into one entry with the qty and a single reason.`);
        }
        damagedHires.add(a.purchaseOrderRentalLineId);
      }
      spent.set(a.purchaseOrderRentalLineId, (spent.get(a.purchaseOrderRentalLineId) ?? 0) + a.qty);
      out.push({
        ...common,
        source: "rental",
        rentalItemId,
        purchaseOrderRentalLineId: a.purchaseOrderRentalLineId,
        poCode: a.poCode,
        hireEndDate: a.hireEndDate,
        itemName: line.itemName,
        qty: a.qty,
      });
    }
  }
  return out;
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
  const entries = await expandFulfilEntries(req, input, byLine);

  const createdBy = actor.email ?? null;
  // Resolved ONCE for the whole posting and re-asserted inside the hire's conditional write, so every
  // rental line on this posting is judged against the same calendar date. Only meaningful on the issue
  // leg — a return never asserts the hire window.
  const postingTodayStart = entries.some((e) => e.source === "rental") ? await companyTodayStart() : new Date();

  // Purchase orders whose hire counters this posting moved, collected from the hire rows the legs
  // below already read. Emitted AFTER the transaction commits (see the end of this function): an
  // event fired from inside would announce a change a rollback then undid, and every consumer of it
  // re-reads from the database. Keyed by PO id, so a posting that split one line across two hires on
  // the same order refreshes it once.
  const hiresTouched = new Map<string, string>();

  const updated = await vsrRepo.postFulfilment(id, allowed, actor.email ?? "", entries, async (tx, fresh, fulfilmentId) => {
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
      // ── HIRED KIT ─────────────────────────────────────────────────────────────────────────────
      // Never touches InventoryBalance. A hire is the provider's equipment: it has no stock balance
      // of its own (deliberately — see the RentalItem model), so the two ledgers it moves are the
      // hire's own issued counter and the engineer's rental custody.
      if (e.source === "rental") {
        const hireId = e.purchaseOrderRentalLineId as string;
        if (fresh.type === "restock") {
          const lineWarehouseId = entryWarehouses.get(e.lineId) as string;
          // The PAPERWORK re-check the quantity guard below cannot make. adjustHireIssuedQtyTx is
          // atomic about how MANY but reads only the counters, so an order cancelled between the
          // resolve and this commit still satisfies it — and units lent against a dead order are
          // stranded, because the supplier-return path loads the order and refuses. Cheap to ask;
          // impossible to undo if we don't.
          const liveHire = await poRepo.findHireStockByIdTx(tx, hireId);
          if (!liveHire || !liveHire.orderLive || liveHire.hireStatus !== "on_hire") {
            throw conflict(`${e.itemName}: that hire is no longer live — its order was cancelled, or it has already gone back. Refresh and scan again.`);
          }
          // IDENTITY, on both axes. The hire was resolved from this line's own catalogue item and
          // warehouse, but re-asserting it here is what makes a stale resolve fail loudly instead of
          // draining the wrong provider's kit.
          if (liveHire.rentalItemId !== e.rentalItemId) throw conflict(`${e.itemName}: that hire is for a different rental item.`);
          if (liveHire.warehouseId !== lineWarehouseId) throw conflict(`${e.itemName}: that hire belongs to a different warehouse.`);
          hiresTouched.set(liveHire.purchaseOrderId, liveHire.poCode ?? "");
          // The availability check and the commitment are ONE conditional write on the hire row.
          // `todayStart` re-asserts the hire window INSIDE it, which is what makes a stale tab's post
          // fail rather than succeed against a hire that expired while the tab sat open.
          const ok = await poRepo.adjustHireIssuedQtyTx(tx, hireId, e.qty, postingTodayStart);
          if (!ok) throw conflict(`${e.itemName}: those units are no longer available on this hire — its period may have ended, or the stock changed. Refresh and scan again.`);
          const heldNow = await rentalCustodyRepo.upsertRentalHoldingTx(tx, hireId, fresh.engineerId, e.qty, {
            rentalItemId: e.rentalItemId ?? null,
            itemName: e.itemName,
            poCode: e.poCode ?? null,
            hireEndDate: e.hireEndDate ?? null,
          });
          await rentalCustodyRepo.insertRentalTxnTx(tx, {
            purchaseOrderRentalLineId: hireId,
            engineerId: fresh.engineerId,
            quantityDelta: e.qty,
            type: "van_restock",
            sourceType: SOURCE_TYPE,
            sourceId: fresh.id,
            sourceCode: fresh.code,
            balanceAfter: heldNow.quantityOnHand,
            createdBy,
          });
        } else {
          // IDENTITY, on both axes — the same guard the restock leg above makes, and the same one
          // Goods Management's return leg makes.
          //
          // It is needed MORE here than there. `pickReturnableHoldings` deliberately falls back to a
          // holding that is not live at this depot, because kit whose order was cancelled still has to
          // be able to come home; but EngineerRentalHolding carries no warehouse, so that fallback
          // cannot tell "this depot's cancelled hire" from "another depot's hire entirely". An
          // engineer holding the same tester on hires from two depots would then hand it in at one
          // and have the OTHER depot's hire credited: its pool inflates by a unit that is not on its
          // shelf, and this depot stays short one it is holding.
          //
          // Re-read inside the transaction rather than trusting the pre-transaction resolve, so a
          // hire moved between the two fails the write instead of corrupting a balance.
          const returnHire = await poRepo.findHireStockByIdTx(tx, hireId);
          if (!returnHire) throw conflict(`${e.itemName}: that hire no longer exists.`);
          if (returnHire.rentalItemId !== e.rentalItemId) {
            throw conflict(`${e.itemName}: that hire is for a different rental item.`);
          }
          if (returnHire.warehouseId !== returnWarehouseId) {
            throw conflict(`${e.itemName}: that hire was collected from a different depot — it has to go back there, not here.`);
          }
          // NO `orderLive` / `hireStatus` guard, deliberately, and NO `todayStart`. Kit already in an
          // engineer's hands has to be able to come back whatever happened to the paperwork behind it
          // — refusing here would strand it in the van with nothing to scan it against. Getting the
          // paperwork WRONG (the two checks above) is a different thing from the paperwork having
          // moved on. Mirrors goods-management's return leg exactly.
          hiresTouched.set(returnHire.purchaseOrderId, returnHire.poCode ?? "");

          // Drain custody first — its floor guard is what refuses a return of units the engineer was
          // never holding, and it rolls the whole posting back rather than persisting a negative
          // custody row.
          const heldRow = await rentalCustodyRepo.findRentalHoldingTx(tx, hireId, fresh.engineerId);
          const backTo = await rentalCustodyRepo.upsertRentalHoldingTx(tx, hireId, fresh.engineerId, -e.qty, {
            rentalItemId: e.rentalItemId ?? heldRow?.rentalItemId ?? null,
            itemName: e.itemName,
            poCode: e.poCode ?? heldRow?.poCode ?? null,
            hireEndDate: e.hireEndDate ?? heldRow?.hireEndDate ?? null,
          });
          await rentalCustodyRepo.insertRentalTxnTx(tx, {
            purchaseOrderRentalLineId: hireId,
            engineerId: fresh.engineerId,
            quantityDelta: -e.qty,
            type: "van_return",
            sourceType: SOURCE_TYPE,
            sourceId: fresh.id,
            sourceCode: fresh.code,
            balanceAfter: backTo.quantityOnHand,
            notes: e.condition === "damaged" ? (e.damageReason ?? "Returned damaged") : null,
            createdBy,
          });
          // Release the units back into the hire's pool. This must NOT be skipped when the kit came
          // back damaged: a damaged tester is still physically on our shelf, still ours to give back
          // to the provider, and still counting against the hire's deadline. Leaving it "issued"
          // would make the hire un-returnable and park it on the overdue badge forever.
          //
          // No `todayStart` on the way back, deliberately — the hire window is never asserted on a
          // return, or overdue kit could not come home.
          const released = await poRepo.adjustHireIssuedQtyTx(tx, hireId, -e.qty);
          if (!released) throw conflict(`${e.itemName}: this hire's numbers moved while the return was posting. Refresh and scan again.`);

          // DAMAGE IS EVIDENCE, NOT A QUANTITY MOVE — and deliberately NOT DamagedStockBalance.
          //
          // That pool is for stock WE own, where a damaged unit is our loss to write off or reclaim.
          // A hire is the provider's equipment: the damage is a LIABILITY to them, settled through
          // the hire's own damage note with their charge on it. Posting it to the damaged pool as
          // well would double-count one event against a charge the supplier bills once.
          //
          // The custody-exit row is what takes the unit out of the issuable pool: the tester is still
          // on our shelf and still going back, but it must never be handed to the next engineer.
          if (e.condition === "damaged") {
            // `returnHire`, not a second read: the identity guard above already fetched this row
            // inside this transaction, and re-reading it here was both a wasted round trip and a
            // chance for the two to disagree.
            const hireForExit = returnHire;
            await custodyExitRepo.createExitTx(tx, {
              purchaseOrderRentalLineId: hireId,
              purchaseOrderId: hireForExit.purchaseOrderId,
              poCode: hireForExit.poCode ?? e.poCode ?? null,
              // The HIRE's own depot, not the scanning warehouse. The damage belongs to the order it
              // came off — that is the warehouse whose settle worklist owns it, and the scope every
              // rental permission check on it resolves against.
              warehouseId: hireForExit.warehouseId,
              kind: "damage",
              qty: e.qty,
              itemName: e.itemName,
              custodyState: custodyExitRepo.CUSTODY_HELD_DAMAGED,
              reason: e.damageReason ?? "Returned damaged from field stock",
              notes: null,
              photoUrl: e.damagePhotoUrl ?? null,
              // No job — that is the whole point of this flow, and the column is nullable for it.
              engineerId: fresh.engineerId,
              engineerName: fresh.engineerName,
              declaredBy: createdBy,
              // THE POSTING, never the request. A Field Stock return is fulfilled in as many postings
              // as the warehouse needs, so keying on the request would make a second posting's damage
              // on the same hire collide with the first — and createExitTx reads a collision as an
              // idempotent retry, handing back the earlier row while these units drain from custody
              // with no exit holding them down.
              sourceType: DAMAGED_SOURCE_TYPE,
              sourceId: fulfilmentId,
            });
          }
        }
        continue;
      }

      // ── COMPANY STOCK ─────────────────────────────────────────────────────────────────────────
      // Only reachable once the rental arm above has `continue`d, so the id is present by
      // construction — asserted rather than assumed, because posting a null item id would write a
      // corrupt balance row instead of failing.
      const irmItemId = e.irmItemId;
      if (!irmItemId) throw conflict(`"${e.itemName}" has no catalogue item — it can't be fulfilled.`);
      if (fresh.type === "restock") {
        const lineWarehouseId = entryWarehouses.get(e.lineId) as string;
        // Warehouse − (zero-floor guarded) → van + → engineer ledger row.
        await inventoryService.applyOutbound(tx, { irmItemId, warehouseId: lineWarehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, irmItemId, fresh.engineerId, e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId, engineerId: fresh.engineerId, quantityDelta: e.qty, type: "van_restock", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
      } else {
        // Van − (floor guarded) → good: warehouse + | damaged: damaged pool.
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, irmItemId, fresh.engineerId, -e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId, engineerId: fresh.engineerId, quantityDelta: -e.qty, type: "van_return", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
        if (e.condition === "good") {
          await inventoryService.applyInbound(tx, { irmItemId, warehouseId: returnWarehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        } else {
          const key: goodsManagementRepo.DamagedKey = { warehouseId: returnWarehouseId, ownerType: "company", irmItemId, customerStockEntryId: null, customerId: null, itemName: e.itemName };
          const dmg = await goodsManagementRepo.upsertDamagedBalanceTx(tx, key, e.qty);
          await goodsManagementRepo.insertDamagedTxnTx(tx, { warehouseId: returnWarehouseId, ownerType: "company", irmItemId, customerStockEntryId: null, customerId: null, quantityDelta: e.qty, reason: e.damageReason ?? "Damaged on van return", notes: null, photoUrl: e.damagePhotoUrl ?? null, sourceType: DAMAGED_SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: dmg.quantity, createdBy });
        }
      }
    }
  });

  audit.record({ actor, action: "van_stock_request.fulfilment_posted", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { entries: entries.map((e) => ({ item: e.itemName, qty: e.qty, condition: e.condition, sourceWarehouseId: entryWarehouses.get(e.lineId) ?? null })) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  // The hire counters this posting moved are the same ones the order page, the on-hire pane and the
  // deadline badges render. Every other writer of `issuedQuantity` announces it — Goods Management,
  // hireLoss, rental receipts, the PO service — and Field Stock was the one that did not, so those
  // screens sat stale until someone reloaded. AFTER the commit, once per PO, and only for a posting
  // that actually touched a hire (the map stays empty on an IRM-only one).
  for (const [purchaseOrderId, poCode] of hiresTouched) emitHireUpdated(purchaseOrderId, poCode);
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
export async function openLineItems(
  engineerId: string,
  type: string,
): Promise<Array<{ source: string; irmItemId: string | null; rentalItemId: string | null; code: string }>> {
  return vsrRepo.findOpenLineItems(engineerId, type);
}

// Engineer's on-hand (return composer source). Serial/batch never reach the van via supported flows,
// but filter defensively.
export interface HoldingOption {
  source: string; // irm | rental
  irmItemId: string | null;
  rentalItemId: string | null;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
  // ── Rental only ────────────────────────────────────────────────────────────────────────────────
  // The soonest deadline among the hires these units sit on, and whether that date has passed. This
  // is the ONE fact that makes hired kit different from a cable in a van: it keeps billing and it is
  // owed to a third party, so the engineer's return list has to lead with it.
  //
  // The individual hire ids are deliberately NOT exposed. The engineer picks a catalogue item and a
  // quantity; which hire each unit goes back on is the warehouse's scan to resolve, and offering the
  // choice here would be asking them to answer an accounting question they have no basis for.
  hireEndDate: string | null;
  overdue: boolean;
  poCodes: string[]; // the orders these units sit on, for reference only
}
export async function myHoldings(engineerId: string): Promise<HoldingOption[]> {
  // Show only the FREE (field) portion: global van holding MINUS what's committed to active jobs. Job
  // stock returns via the job's Close & Reconcile, so it must never appear as field-returnable here — an
  // item wholly committed to a job drops out (free 0). Same subtraction the create guard enforces, and
  // it applies to BOTH pools: hired kit out on a job goes back through that job's own scan-in.
  // Both committed pools from ONE job + movement read — see committedByEngineer.
  const [rows, jobCommitted, rentalRows] = await Promise.all([
    engineerStockRepo.findEngineerBalances(engineerId),
    committedByEngineer(engineerId),
    rentalCustodyRepo.findRentalHoldingsByEngineer(engineerId),
  ]);
  const committed = jobCommitted.irm;
  const rentalCommitted = jobCommitted.rental;

  const irm: HoldingOption[] = rows
    .filter((b) => !b.irmItem.trackSerialNumbers && !b.irmItem.trackBatchNumbers)
    .map((b) => ({
      source: "irm",
      irmItemId: b.irmItemId,
      rentalItemId: null,
      code: b.irmItem.code,
      name: b.irmItem.name,
      uom: b.irmItem.baseUnit ?? null,
      quantityOnHand: Math.max(0, b.quantityOnHand - (committed.get(b.irmItemId) ?? 0)),
      hireEndDate: null,
      overdue: false,
      poCodes: [],
    }))
    .filter((h) => h.quantityOnHand > 0);

  // Rolled up per CATALOGUE item, summed across however many hires the units sit on — that is the
  // unit the engineer requests in, and the unit the free-vs-committed subtraction is expressed in.
  const byItem = new Map<string, { qty: number; soonest: Date | null; poCodes: Set<string>; name: string; uom: string | null }>();
  for (const h of rentalRows) {
    if (!h.rentalItemId) continue;
    const cur = byItem.get(h.rentalItemId);
    const soonest =
      !cur?.soonest ? h.hireEndDate
      : !h.hireEndDate ? cur.soonest
      : h.hireEndDate < cur.soonest ? h.hireEndDate
      : cur.soonest;
    const poCodes = cur?.poCodes ?? new Set<string>();
    if (h.poCode) poCodes.add(h.poCode);
    byItem.set(h.rentalItemId, { qty: (cur?.qty ?? 0) + h.quantityOnHand, soonest, poCodes, name: cur?.name ?? h.itemName, uom: cur?.uom ?? null });
  }
  // COMPANY midnight, not the process clock. A hire deadline is a calendar day stored at UTC
  // midnight, so `hireEndDate < Date.now()` calls a hire due TODAY overdue from one minute past
  // midnight onwards — this picker would show it red and "was due back today" all day while the scan
  // panel, which judges the same date against companyTodayStart, said it was fine. Same hire, two
  // screens, opposite answers, on the one number this feature exists to get right.
  const todayStart = (await companyTodayStart()).getTime();
  const rentalIds = [...byItem.keys()];
  // One batched read for the catalogue codes — the holding snapshots the NAME but not the code, and
  // the code is what the warehouse's scanner resolves against.
  const catalogue = rentalIds.length > 0 ? await rentalItemRepo.findManyByIds(rentalIds) : [];
  const codeById = new Map(catalogue.map((r) => [r.id, { code: r.code, name: r.name, uom: r.baseUnit ?? null }]));

  const rental: HoldingOption[] = rentalIds
    .map((rentalItemId) => {
      const h = byItem.get(rentalItemId)!;
      const meta = codeById.get(rentalItemId);
      return {
        source: "rental",
        irmItemId: null,
        rentalItemId,
        code: meta?.code ?? "",
        name: meta?.name ?? h.name,
        uom: meta?.uom ?? h.uom,
        quantityOnHand: Math.max(0, h.qty - (rentalCommitted.get(rentalItemId) ?? 0)),
        hireEndDate: h.soonest ? h.soonest.toISOString() : null,
        overdue: h.soonest ? h.soonest.getTime() < todayStart : false,
        poCodes: [...h.poCodes],
      };
    })
    .filter((h) => h.quantityOnHand > 0);

  // HIRED KIT FIRST, soonest deadline at the top.
  //
  // Not a cosmetic preference. The return picker is a fixed-height scrolling list, and with company
  // stock first a hire lands below the fold — an engineer holding six IRM lines had to scroll 432px
  // past them to discover the tester they were actually there to hand back. Every visible row said
  // "IRM", so the honest reading of that screen was "I have no hire to return", and the units stayed
  // in the van accruing charges.
  //
  // Hired kit is the only thing in this list with a deadline, a running cost and a third party
  // waiting for it. It belongs where it cannot be missed. Within the group, soonest due (and anything
  // already overdue) sorts first — the same rule the allocator and the return binder use, so the
  // whole module puts the most urgent hire in front of the engineer.
  const byDeadline = [...rental].sort((a, b) => {
    // No date sorts LAST, not first — a missing snapshot must never outrank a real deadline.
    const av = a.hireEndDate ? Date.parse(a.hireEndDate) : Infinity;
    const bv = b.hireEndDate ? Date.parse(b.hireEndDate) : Infinity;
    return av - bv || a.name.localeCompare(b.name);
  });
  return [...byDeadline, ...irm];
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
  // Both catalogues, one search box. The engineer thinks in terms of "the thing I need", not "which
  // ledger owns it", so making them choose a tab first would be asking them to know the answer before
  // they can look it up. The `source` on each hit is what the composer badges, and what routes the
  // line server-side — the two can never disagree because they are the same field.
  // ONE demand scan for this keystroke, shared by both pools below.
  //
  // Same arithmetic as availability(), and for the same reason. This search decides which items are
  // SELECTABLE, so on raw on-hand it would pass an item the very next screen then showed as "0 free"
  // — the gate and the guidance disagreeing about the same stock. Netted per warehouse and floored
  // there, so one over-committed site can't wipe out stock standing at another.
  //
  // Hoisted to here because the rental branch nets against the same figure: resolved separately, the
  // two walked every active job and its movements twice per keystroke, and sequentially at that (the
  // rental options were awaited before the IRM demand was even requested).
  const [rows, rentalHits, demand] = await Promise.all([
    irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name").then((r) => r.filter((x) => !x.trackSerialNumbers && !x.trackBatchNumbers)),
    rentalItemRepo.findMany({ search: term, status: "active", page: 1, pageSize: 20 }),
    getOpenDemand(),
  ]);
  const rentalItems = rentalHits.items ?? [];
  const rentalOptions = await rentalRequestableOptions(rentalItems, demand);
  if (rows.length === 0) return rentalOptions;
  const warehouses = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  const balances = await inventoryRepo.findBalancesByItemsAndWarehouses(rows.map((r) => r.id), warehouses.map((w) => w.id));
  const demandByKey = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.irmItemId || !d.warehouseId) continue;
    const k = `${d.warehouseId}:${d.irmItemId}`;
    demandByKey.set(k, (demandByKey.get(k) ?? 0) + d.demand);
  }
  const totalByItem = new Map<string, number>();
  for (const b of balances) {
    const free = Math.max(0, b.quantityOnHand - (demandByKey.get(`${b.warehouseId}:${b.irmItemId}`) ?? 0));
    totalByItem.set(b.irmItemId, (totalByItem.get(b.irmItemId) ?? 0) + free);
  }
  // Company stock first, then hired kit — a stable order so the list does not reshuffle as counts
  // change, and the pool an engineer reaches for most often stays at the top.
  return [
    ...rows.map((r) => ({
      source: "irm",
      irmItemId: r.id,
      rentalItemId: null,
      code: r.code,
      name: r.name,
      sku: r.sku ?? null,
      uom: r.baseUnit ?? null,
      quantityOnHand: totalByItem.get(r.id) ?? 0, // network-wide total; 0 ⇒ shown disabled in the composer
      reorderLevel: r.reorderLevel ?? null,
    })),
    ...rentalOptions,
  ];
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
  // Which catalogue this hit came from. The composer badges it, and sends it back as the line's
  // discriminator — so what the engineer saw and what the server stores are the same value.
  source: string; // irm | rental
  irmItemId: string | null;
  rentalItemId: string | null;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
  quantityOnHand: number;
  reorderLevel: number | null; // GLOBAL IRM policy threshold — advisory only, never blocks issuance
}

/**
 * Rental hits for the engineer's composer, annotated with what is FREE across the network.
 *
 * Returned WITH zero rather than hidden when nothing is free anywhere, exactly as the IRM arm does:
 * hidden, the item just gets typed again; returned with a zero the row can be shown disabled and
 * explained ("nothing free on hire"). An engineer who cannot see why an item vanished assumes the
 * search is broken.
 */
async function rentalRequestableOptions(
  items: Array<{ id: string; code: string; name: string; baseUnit: string | null }>,
  // Threaded from the caller so one search resolves open demand once — see rentalFreeByItemAndWarehouse.
  preloadedDemand?: Awaited<ReturnType<typeof getOpenDemand>>,
): Promise<WarehouseItemOption[]> {
  if (items.length === 0) return [];
  // Network-wide: no warehouse filter, because the engineer picks their collection depot afterwards
  // and per-depot detail comes from availability(). Net of open job demand, so a tester a job has
  // already planned is not offered here as free.
  const free = await rentalFreeByItemAndWarehouse(items.map((i) => i.id), [], await companyTodayStart(), preloadedDemand);
  const totalByItem = new Map<string, number>();
  for (const [key, qty] of free) {
    const rentalItemId = key.split("|")[0]!;
    totalByItem.set(rentalItemId, (totalByItem.get(rentalItemId) ?? 0) + qty);
  }
  return items.map((i) => ({
    source: "rental",
    irmItemId: null,
    rentalItemId: i.id,
    code: i.code,
    name: i.name,
    sku: null, // a hire master carries no SKU by design; its code is the identifier
    uom: i.baseUnit ?? null,
    quantityOnHand: totalByItem.get(i.id) ?? 0,
    reorderLevel: null, // a hire never reaches the reorder engine — see the RentalItem model
  }));
}
const WALK_IN_BROWSE_LIMIT = 50;
export async function searchWarehouseItems(actor: AuditActor, warehouseId: string, q: string): Promise<WarehouseItemOption[]> {
  assertWarehouseAccess(actor, warehouseId);
  const term = (q ?? "").trim();
  if (term.length < 1) {
    // No query yet → BROWSE list: everything this warehouse physically holds (on-hand > 0), so the
    // counter can pick straight off the shelf without typing. Active + non-serial/batch, name-sorted, capped.
    const [balances, demand] = await Promise.all([
      inventoryRepo.findInStockBalancesByWarehouse(warehouseId, WALK_IN_BROWSE_LIMIT),
      // Same netting as the typed search below — the browse list is the same shelf answering the same
      // question, and if only one of them subtracted demand then typing a single letter would change
      // what the counter believes it can hand out.
      getOpenDemand(),
    ]);
    const browseDemand = new Map<string, number>();
    for (const d of demand.values()) {
      if (!d.irmItemId || d.warehouseId !== warehouseId) continue;
      browseDemand.set(d.irmItemId, (browseDemand.get(d.irmItemId) ?? 0) + d.demand);
    }
    return balances
      .filter((b) => !b.irmItem.trackSerialNumbers && !b.irmItem.trackBatchNumbers)
      // IRM only, and stated rather than implied: the walk-in counter does not hand out hired kit in
      // this phase (walkInSchema refuses it), so every hit here is company stock.
      .map((b) => ({ source: "irm", irmItemId: b.irmItemId, rentalItemId: null, code: b.irmItem.code, name: b.irmItem.name, sku: b.irmItem.sku ?? null, uom: b.irmItem.baseUnit ?? null, quantityOnHand: Math.max(0, b.quantityOnHand - (browseDemand.get(b.irmItemId) ?? 0)), reorderLevel: b.irmItem.reorderLevel ?? null }))
      .filter((it) => it.quantityOnHand > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // Typed search spans the catalogue (matches code/name/sku), then is narrowed to what THIS warehouse
  // actually holds: an item with no balance row here, or one depleted to 0, is dropped — a walk-in can
  // only hand out stock on the shelf. (This is why an item like a fibre panel that was never stocked at
  // this counter no longer appears as a phantom "out of stock" row.)
  const rows = (await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name")).filter((r) => !r.trackSerialNumbers && !r.trackBatchNumbers);
  if (rows.length === 0) return [];
  const [balances, demand] = await Promise.all([
    inventoryRepo.findBalancesByItemsAndWarehouses(rows.map((r) => r.id), [warehouseId]),
    // Netted like every other "what can leave this shelf" figure. The counter is the FASTEST way to
    // drain a warehouse, and it was the one door that ignored what jobs had planned — hand out the
    // last 3 units a kit is counting on and the job is stranded, discovered only when its engineer
    // turns up at this same counter. Scoped to THIS warehouse's demand: another site's commitments
    // are a different physical shelf.
    getOpenDemand(),
  ]);
  const demandHere = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.irmItemId || d.warehouseId !== warehouseId) continue;
    demandHere.set(d.irmItemId, (demandHere.get(d.irmItemId) ?? 0) + d.demand);
  }
  const onHand = new Map(balances.map((b) => [b.irmItemId, Math.max(0, b.quantityOnHand - (demandHere.get(b.irmItemId) ?? 0))]));
  return rows
    .map((r) => ({
      source: "irm", // walk-in is company stock only — see the browse arm above
      irmItemId: r.id,
      rentalItemId: null,
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
  // Hired kit at this depot, keyed by CATALOGUE item — free-on-hire net of open job demand. Kept as
  // its own list rather than merged into `items`: the two ids come from different catalogues and a
  // single list keyed by a bare id could not tell them apart.
  rentalItems: Array<{ rentalItemId: string; quantityOnHand: number }>;
}
export async function availability(irmItemIds: string[], rentalItemIds: string[] = []): Promise<WarehouseAvailability[]> {
  const ids = [...new Set(irmItemIds)].slice(0, 100);
  const rentalIds = [...new Set(rentalItemIds)].slice(0, 100);
  if (ids.length === 0 && rentalIds.length === 0) return [];
  const warehouses = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  const [balances, demand] = await Promise.all([
    inventoryRepo.findBalancesByItemsAndWarehouses(ids, warehouses.map((w) => w.id)),
    // Stock already PLANNED on active jobs but not yet issued. Subtracting it is what makes this
    // number mean the same thing as the job kit list's "N free" — the job planner has always shown
    // on-hand minus other jobs' demand, while this endpoint showed raw on-hand. An engineer could
    // therefore be told 2 were free, request both, and have them scanned onto their van out from
    // under a job that had already planned them. Same physical stock, so the same arithmetic.
    getOpenDemand(),
  ]);
  const byKey = new Map(balances.map((b) => [`${b.warehouseId}:${b.irmItemId}`, b.quantityOnHand]));
  const demandByKey = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.irmItemId || !d.warehouseId) continue;
    const k = `${d.warehouseId}:${d.irmItemId}`;
    demandByKey.set(k, (demandByKey.get(k) ?? 0) + d.demand);
  }
  // Hired kit at each depot, computed rather than read — a hire has no balance row. Already net of
  // open job demand inside the helper, so the two pools are advisory in exactly the same way.
  // `demand` is the snapshot already resolved above — passed in rather than re-resolved, so one
  // availability call walks the active jobs once instead of twice.
  const rentalFree = rentalIds.length > 0 ? await rentalFreeByItemAndWarehouse(rentalIds, warehouses.map((w) => w.id), await companyTodayStart(), demand) : new Map<string, number>();

  return warehouses.map((w) => ({
    warehouseId: w.id,
    warehouseName: w.name,
    warehouseCode: w.code ?? null,
    items: ids.map((irmItemId) => {
      const k = `${w.id}:${irmItemId}`;
      // Advisory, exactly like the job planner's: the authoritative gate is approve()'s hard-block
      // against live on-hand. Floored at 0 — demand can exceed stock, and "-3 free" helps nobody.
      return { irmItemId, quantityOnHand: Math.max(0, (byKey.get(k) ?? 0) - (demandByKey.get(k) ?? 0)) };
    }),
    // Note the key order: the rental pool is keyed `item|warehouse`, the IRM map `warehouse:item`.
    // Different separators and different orders, inherited from the two modules they come from —
    // worth reading twice before editing either.
    rentalItems: rentalIds.map((rentalItemId) => ({ rentalItemId, quantityOnHand: rentalFree.get(`${rentalItemId}|${w.id}`) ?? 0 })),
  }));
}

export async function uploadImage(image: string, kind: "attachment" | "damage"): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  const folder = kind === "damage" ? "senthra/damage-photos" : "senthra/van-stock-requests";
  // Unique per upload: `uploadToCloudinary` overwrites on a repeated publicId, so a timestamp meant
  // two engineers photographing the same kind of evidence in the same millisecond kept one photo.
  const { url } = await uploadToCloudinary(image, `vsr-${kind}-${randomUUID()}`, creds, folder);
  return { url };
}
