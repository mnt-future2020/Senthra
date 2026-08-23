import * as jobService from "#modules/job/job.service.js";
import { startOfDayIn } from "../../utils/filter-date.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import * as engineerTransferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as vanStockRequestService from "#modules/van-stock-request/van-stock-request.service.js";
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerRepo from "./engineer.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import type { MovementFilters } from "#modules/inventory/movement.service.js";
import * as movementService from "#modules/inventory/movement.service.js";
import type { MovementCursor } from "#modules/inventory/movement.js";
import type { CompleteJobInput } from "#modules/job/job.validation.js";

// The Engineer Portal surface, scoped to the signed-in engineer. Every function takes the engineer's
// own User.id (resolved from the authenticated principal by the controller — never a route param).
// Reads consume existing primitives (EngineerStockBalance/Transaction, the shared job service); the
// job write path (accept/reject/start/complete) is delegated to the job service, which owns the
// status machine, realtime emits and audit.

export interface EngineerStockItem {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
  lastMovedAt: string | null; // balance updatedAt — the last time this line moved (dispatch/return)
}

export interface EngineerActivity {
  id: string;
  type: string; // goods_out (future: usage | return | transfer_in | transfer_out)
  label: string; // human label for the type
  itemCode: string;
  itemName: string;
  quantityDelta: number;
  balanceAfter: number;
  sourceCode: string | null; // e.g. GDN-0001
  notes: string | null;
  createdAt: string;
}

// A slim job row for the dashboard's "next up" list — enough to render and deep-link, nothing more.
export interface EngineerOverviewJob {
  id: string;
  jobNumber: string;
  name: string;
  customerName: string | null;
  completionDate: string | null;
  priority: string;
  status: string;
}

export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  // Held customer-consignment stock and misc (free-text) items — the two secondary pools the dashboard
  // shows (a Customer-stock card + the misc count in the Stock card's hint).
  customerStock: { lines: number; totalQuantity: number };
  misc: { lines: number; totalQuantity: number };
  // HIRED kit in the van. Its own card rather than a line on the stock one, because the number that
  // matters here is not how much is held but how much is LATE: hired kit bills by the day and is owed
  // to someone else, so `overdue` and `dueSoon` are the figures the badge is built from.
  rentals: { lines: number; totalQuantity: number; overdue: number; dueSoon: number };
  // The engineer's live workload — the numbers a field engineer actually plans their day around.
  jobs: {
    toAccept: number; // assigned, awaiting the engineer's accept/reject
    accepted: number; // accepted but not yet started
    inProgress: number;
    overdue: number; // active jobs whose completion date has passed
    dueThisWeek: number; // active jobs due within the next 7 days
    next: EngineerOverviewJob[]; // active jobs, soonest due first (undated last)
  };
  // Incoming = transfers awaiting this engineer's acceptance; toSign = delivered transfers awaiting their signature.
  transfers: { incomingPending: number; toSign: number };
  // Restocks approved/partially-fulfilled and waiting to be collected from a warehouse.
  vanStock: { toCollect: number };
  // The engineer's own kit requests still awaiting a planner decision (across all jobs).
  kitRequests: { pending: number };
  recentActivity: EngineerActivity[];
}

// Friendly labels for the engineer-stock ledger `type`. Only `goods_out` is written today; the rest
// are the reserved future verbs (usage / returns / transfers) so the portal reads correctly later.
const ACTIVITY_LABELS: Record<string, string> = {
  goods_out: "Collected",
  usage: "Used on site",
  return: "Returned",
  transfer_in: "Received (transfer)",
  transfer_out: "Transferred out",
};

export async function getOwnStock(engineerId: string): Promise<EngineerStockItem[]> {
  const rows = await engineerRepo.findBalancesByEngineer(engineerId);
  return rows.map((b) => ({
    irmItemId: b.irmItemId,
    itemCode: b.irmItem.code,
    itemName: b.irmItem.name,
    baseUnit: b.irmItem.baseUnit ?? null,
    quantityOnHand: b.quantityOnHand,
    lastMovedAt: b.updatedAt.toISOString(),
  }));
}

export async function getOwnActivity(engineerId: string, limit = 15): Promise<EngineerActivity[]> {
  const rows = await engineerRepo.findRecentTransactions(engineerId, limit);
  return rows.map((t) => ({
    id: t.id,
    type: t.type,
    label: ACTIVITY_LABELS[t.type] ?? t.type,
    itemCode: t.irmItem.code,
    itemName: t.irmItem.name,
    quantityDelta: t.quantityDelta,
    balanceAfter: t.balanceAfter,
    sourceCode: t.sourceCode,
    notes: t.notes,
    createdAt: t.createdAt.toISOString(),
  }));
}

// The engineer's own Stock Movement History — the unified ledger, hard-scoped by the movement service
// to this engineer's two van ledgers (company + customer consignment). Warehouse/damaged movements are
// never reachable here. The engineerId is the signed-in user's id (resolved in the controller), the
// filters/cursor/limit are parsed in the controller (like inventory.controller), and the movement
// service ignores any client-supplied engineer filter regardless.
export function getOwnMovements(engineerId: string, filters: MovementFilters, cursor: MovementCursor | null, limit?: number) {
  return movementService.listEngineerMovements(engineerId, filters, cursor, limit);
}

const NEXT_JOBS_LIMIT = 5;

// The engineer's dashboard read-model. Derives ALL its numbers (status counts, due maths, "next up")
// from ONE bounded, kit-line-free query of the engineer's active jobs — the active set is small by
// nature (the unbounded history is completed/cancelled). Replaces three paged withRelations fetches
// that hydrated up to 300 jobs with every kit line + warehouse address just to show 4 counts + 5 rows.
export async function getOwnOverview(engineerId: string): Promise<EngineerOverview> {
  const [stock, recentActivity, active, pendingIncoming, toCollect, kitPending, toSign, customer, misc, rentals] = await Promise.all([
    getOwnStock(engineerId),
    getOwnActivity(engineerId, 8),
    jobService.listActiveJobsForEngineer(engineerId),
    // Count only — incoming transfers still awaiting this engineer's acceptance.
    engineerTransferService.listMine(engineerId, { role: "incoming", status: "pending", pageSize: 1 }),
    // Restocks approved/partially-fulfilled and waiting for the engineer to collect.
    vanStockRequestService.countCollectible(engineerId),
    // The engineer's own kit requests still awaiting a planner decision (all jobs).
    kitRequestService.listMine(engineerId, { status: "pending", pageSize: 1 }),
    // Delivered transfers awaiting the engineer's receipt signature.
    engineerTransferService.countAwaitingSignature(engineerId),
    // Held customer-consignment stock + misc items (secondary pools, aggregated here so the dashboard
    // reads them in the same round-trip instead of two extra client calls).
    getOwnCustomerStock(engineerId),
    getOwnMiscStock(engineerId),
    // Hired kit the engineer is carrying — same round-trip as the other two held pools.
    getOwnRentals(engineerId),
  ]);

  // Status counts + due maths over the active set (assigned + accepted + in_progress).
  //
  // "Today" comes from the COMPANY timezone, shared with the dashboard's overdue card, the engineer's
  // Overdue job filter and the warehouse Due filter — all four answer "is this job overdue?" and must
  // answer it identically. Computing it from UTC (as this did) is a day behind for the first hour of
  // every BST day, so an engineer opening the portal early saw yesterday's counts.
  const dayStart = startOfDayIn(await getCompanyTimezone(), new Date()).getTime();
  const weekEnd = dayStart + 7 * 86_400_000;
  let toAccept = 0;
  let accepted = 0;
  let inProgress = 0;
  let overdue = 0;
  let dueThisWeek = 0;
  for (const j of active) {
    if (j.status === "assigned") toAccept++;
    else if (j.status === "accepted") accepted++;
    else if (j.status === "in_progress") inProgress++;
    if (!j.completionDate) continue;
    const due = Date.parse(j.completionDate);
    if (Number.isNaN(due)) continue;
    if (due < dayStart) overdue++;
    else if (due < weekEnd) dueThisWeek++;
  }

  // "Next up": soonest due first, undated jobs last — the order an engineer works in.
  const next: EngineerOverviewJob[] = [...active]
    .sort((a, b) => {
      const da = a.completionDate ? Date.parse(a.completionDate) : Number.POSITIVE_INFINITY;
      const db = b.completionDate ? Date.parse(b.completionDate) : Number.POSITIVE_INFINITY;
      return da - db;
    })
    .slice(0, NEXT_JOBS_LIMIT)
    .map((j) => ({
      id: j.id,
      jobNumber: j.jobNumber,
      name: j.name,
      customerName: j.customerName ?? null,
      completionDate: j.completionDate,
      priority: j.priority,
      status: j.status,
    }));

  return {
    stock: { lines: stock.length, totalQuantity: stock.reduce((sum, i) => sum + i.quantityOnHand, 0) },
    customerStock: { lines: customer.length, totalQuantity: customer.reduce((sum, h) => sum + h.quantityOnHand, 0) },
    misc: { lines: misc.length, totalQuantity: misc.reduce((sum, m) => sum + m.quantityOnHand, 0) },
    rentals: {
      lines: rentals.length,
      totalQuantity: rentals.reduce((sum, r) => sum + r.quantityOnHand, 0),
      overdue: rentals.filter((r) => r.overdue).length,
      // "Soon" is a week: long enough that an engineer can plan a depot trip around it, short enough
      // that it still reads as urgent. Matches the dueThisWeek window used for jobs just below.
      dueSoon: rentals.filter((r) => !r.overdue && r.dueInDays !== null && r.dueInDays <= 7).length,
    },
    jobs: { toAccept, accepted, inProgress, overdue, dueThisWeek, next },
    transfers: { incomingPending: pendingIncoming.total, toSign },
    vanStock: { toCollect },
    kitRequests: { pending: kitPending.total },
    recentActivity,
  };
}

// --- Engineer's own jobs -----------------------------------------------------
// Delegates entirely to the job service (the single source of truth for the job status machine,
// realtime emits, and audit). The engineer id is always the signed-in user's id, never a route param.

export function getOwnJobs(engineerId: string, params: jobService.ListEngineerJobsParams = {}) {
  return jobService.listJobsForEngineer(engineerId, params);
}

export function getOwnJob(engineerId: string, jobId: string) {
  return jobService.getJobForEngineer(engineerId, jobId);
}

export function acceptOwnJob(engineerId: string, jobId: string, actor?: AuditActor) {
  return jobService.acceptJobForEngineer(engineerId, jobId, actor);
}

export function rejectOwnJob(engineerId: string, jobId: string, reason: string | undefined, actor?: AuditActor) {
  return jobService.rejectJobForEngineer(engineerId, jobId, reason, actor);
}

export function startOwnJob(engineerId: string, jobId: string, actor?: AuditActor) {
  return jobService.startJobForEngineer(jobId, engineerId, actor);
}

export function completeOwnJob(engineerId: string, jobId: string, input: CompleteJobInput, actor?: AuditActor) {
  return jobService.completeJobForEngineer(jobId, engineerId, input, actor);
}

// --- Engineer held customer stock (no pricing exposed) ---------------------------------------

export interface CustomerHoldingItem {
  id: string;
  customerStockEntryId: string;
  customerId: string | null;
  customerName: string | null;
  itemName: string;
  quantityOnHand: number;
}

export async function getOwnCustomerStock(engineerId: string): Promise<CustomerHoldingItem[]> {
  const rows = await goodsManagementRepo.findCustomerHoldingsByEngineer(engineerId);
  // Backfill the customer label for holdings whose snapshot is null (legacy rows) — resolve by id.
  const missingIds = [...new Set(rows.filter((h) => !h.customerName && h.customerId).map((h) => h.customerId!))];
  const nameById = new Map<string, string>();
  if (missingIds.length) {
    for (const c of await goodsManagementRepo.findCustomerNamesByIds(missingIds)) nameById.set(c.id, c.name);
  }
  return rows.map((h) => ({
    id: h.id,
    customerStockEntryId: h.customerStockEntryId,
    customerId: h.customerId,
    customerName: h.customerName ?? (h.customerId ? nameById.get(h.customerId) ?? null : null),
    itemName: h.itemName,
    quantityOnHand: h.quantityOnHand,
  }));
}

// --- Engineer held HIRED kit (rental custody) -------------------------------------------------
//
// The one pool on this portal that is not ours. Everything else an engineer holds — van stock,
// customer consignment, misc — either gets used up or goes back at leisure; a hire is billed by the
// day and belongs to a third party, so the only question about it is WHEN IT GOES BACK. That is why
// this list exists at all, why it is sorted by deadline, and why `dueInDays` is computed rather than
// left to the client to work out from a date string.
//
// No PO code and no money. The purchase order is the office's handle on a hire; the engineer needs
// the item, the date, and which depot it came from.

export interface RentalHoldingItem {
  id: string;
  rentalItemId: string | null;
  itemName: string;
  quantityOnHand: number;
  hireEndDate: string | null;
  /** Whole days from today (company time) until the deadline. Negative ⇒ already overdue. */
  dueInDays: number | null;
  overdue: boolean;
}

export async function getOwnRentals(engineerId: string): Promise<RentalHoldingItem[]> {
  const rows = await rentalCustodyRepo.findRentalHoldingsByEngineer(engineerId);
  if (rows.length === 0) return [];
  // Company time, not the server's and never the browser's — the same day-boundary the scan panel,
  // the overdue badge and the engineer's job list all resolve against. Hire dates are calendar days
  // stored at UTC midnight, so both sides of this comparison are the same kind of thing.
  const todayStart = startOfDayIn(await getCompanyTimezone(), new Date()).getTime();
  return rows.map((h) => {
    const due = h.hireEndDate?.getTime() ?? null;
    return {
      id: h.id,
      rentalItemId: h.rentalItemId,
      itemName: h.itemName,
      quantityOnHand: h.quantityOnHand,
      hireEndDate: h.hireEndDate?.toISOString() ?? null,
      dueInDays: due === null ? null : Math.round((due - todayStart) / 86_400_000),
      overdue: due !== null && due < todayStart,
    };
  });
}

export interface MiscHeldItem {
  itemName: string;
  quantityOnHand: number;
}

// Misc items issued to the engineer (free-text kit lines, no stock balance) — summed by item name
// from their posted issue movements. Misc has no return flow, so held = total issued.
export async function getOwnMiscStock(engineerId: string): Promise<MiscHeldItem[]> {
  const lines = await goodsManagementRepo.findMiscIssueLinesByEngineer(engineerId);
  const agg = new Map<string, number>();
  for (const l of lines) agg.set(l.itemName, (agg.get(l.itemName) ?? 0) + l.qty);
  return [...agg.entries()].map(([itemName, quantityOnHand]) => ({ itemName, quantityOnHand }));
}
