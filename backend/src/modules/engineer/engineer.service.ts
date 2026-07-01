import * as jobService from "#modules/job/job.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerRepo from "./engineer.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as movementService from "#modules/inventory/movement.service.js";
import { decodeCursor } from "#modules/inventory/movement.js";
import type { CompleteJobInput } from "#modules/job/job.validation.js";

// The Engineer Portal READ surface. Every function takes the engineer's own User.id (resolved from
// the authenticated principal by the controller — never a route param) and reads existing primitives:
// EngineerStockBalance/Transaction (own held stock + activity). No writes, no new stock logic —
// consumes what already exists.

export interface EngineerStockItem {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
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

export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
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
// never reachable here. The engineerId is the signed-in user's id (resolved in the controller), and the
// movement service ignores any client-supplied engineer filter.
export function getOwnMovements(engineerId: string, query: Record<string, unknown>) {
  const filters = movementService.movementFiltersFrom(query);
  const cursor = decodeCursor(typeof query.cursor === "string" ? query.cursor : undefined);
  const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
  return movementService.listEngineerMovements(engineerId, filters, cursor, limit);
}

export async function getOwnOverview(engineerId: string): Promise<EngineerOverview> {
  const [stock, recentActivity] = await Promise.all([
    getOwnStock(engineerId),
    getOwnActivity(engineerId, 8),
  ]);
  return {
    stock: { lines: stock.length, totalQuantity: stock.reduce((sum, i) => sum + i.quantityOnHand, 0) },
    recentActivity,
  };
}

// --- Engineer's own jobs -----------------------------------------------------
// Delegates entirely to the job service (the single source of truth for the job status machine,
// realtime emits, and audit). The engineer id is always the signed-in user's id, never a route param.

export function getOwnJobs(engineerId: string) {
  return jobService.listJobsForEngineer(engineerId);
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
