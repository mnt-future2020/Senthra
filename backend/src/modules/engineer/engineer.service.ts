import * as goodsOutService from "#modules/goods-out/goods-out.service.js";
import * as jobService from "#modules/job/job.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerRepo from "./engineer.repository.js";

// The Engineer Portal READ surface. Every function takes the engineer's own User.id (resolved from
// the authenticated principal by the controller — never a route param) and reads existing primitives:
// EngineerStockBalance/Transaction (own held stock + activity) and the Goods Out service (own
// dispatches received). No writes, no new dispatch/stock logic — consumes what already exists.

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
  dispatches: { total: number };
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

export async function getOwnOverview(engineerId: string): Promise<EngineerOverview> {
  const [stock, recentActivity, dispatched] = await Promise.all([
    getOwnStock(engineerId),
    getOwnActivity(engineerId, 8),
    // Reuse Goods Out — the engineer's dispatched GDNs. pageSize:1 because we only need the count here.
    goodsOutService.listGoodsOut({ engineer: engineerId, status: "dispatched", pageSize: 1 }),
  ]);
  return {
    stock: { lines: stock.length, totalQuantity: stock.reduce((sum, i) => sum + i.quantityOnHand, 0) },
    dispatches: { total: dispatched.total },
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
