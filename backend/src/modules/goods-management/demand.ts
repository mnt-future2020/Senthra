// ── Planned demand — THE single cross-job "open demand" number ─────────────────────────────────
// Extracted as a LEAF module (imports repositories only, never services) so BOTH consumers can use it
// without an import cycle: goods-management.service (Warehouse Demand board, planner caps) already
// imports inventory.service, and inventory.service (Reorder workbench) needs this — so the seam lives
// below both. ONE calculation, one bug-fix, one source of truth; the Demand board and the workbench
// can never disagree.
//
// CONSUMER CONTRACT (the Reorder workbench's projection — do not "optimize" this away):
//
//   Projected = Available + Incoming PO + Open PRFs − Planned Demand
//
//   Planned Demand is the remaining UNISSUED quantity of active jobs' kit lines:
//     Σ max(0, kitLine.qty − grossIssued)
//   It must NEVER include already-issued quantities — posting an issue decrements the warehouse's
//   quantityOnHand at that moment, so an issued unit already left "Available"; counting it here too
//   would double-subtract the same demand. Likewise, returns must NEVER reduce grossIssued — a
//   returned unit re-credits quantityOnHand on the SUPPLY side; netting it off demand as well would
//   double-count it. (Contrast: the goods-STATUS refresh nets returns, because "is everything back?"
//   is a different question to "what will still be drawn?").
//
// Why `completed` jobs still count: job status ≠ goods lifecycle. A job can be operationally complete
// while its goods are only partially issued — the warehouse queue treats accepted/in_progress/
// completed as its active set, and the REAL demand gate is goodsStatus below (issued/awaiting_return/
// reconciled ⇒ no future warehouse draw). Reconcile — not job completion — is the business action
// that ends a job's goods story.
//
// Warehouse changes can never go stale: there is NO stored demand snapshot — every call re-reads the
// live kit lines and keys by the LINE's warehouseId (not the job header). Once stock is issued the
// kit list locks (changing it would orphan movements), so an issued line's warehouse can't be
// repointed out from under the gross-issued matching.

import * as jobRepo from "#modules/job/job.repository.js";
import * as goodsManagementRepo from "./goods-management.repository.js";

export interface DemandEntry {
  irmItemId: string | null;
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  itemName: string;
  warehouseName: string | null;
  demand: number;
}

// Keyed by item+warehouse (irm) / entry (customer). excludeJobId drops the job being edited.
export async function getOpenDemand(excludeJobId?: string): Promise<Map<string, DemandEntry>> {
  const jobs = await jobRepo.findActiveWithKitLines(excludeJobId);
  const out = new Map<string, DemandEntry>();
  if (jobs.length === 0) return out;

  const ids = jobs.map((j) => j.id);
  const [summaries, movements] = await Promise.all([
    goodsManagementRepo.getSummariesByJobs(ids),
    goodsManagementRepo.findMovementsByJobs(ids),
  ]);
  const goodsStatusOf = new Map(summaries.map((s) => [s.jobId, s.goodsStatus]));
  // Gross issued (issue movements only) per kit line — the part already drawn from the warehouse.
  const issuedByLine = new Map<string, number>();
  for (const m of movements) {
    if (m.status !== "posted" || m.direction !== "issue") continue;
    for (const l of m.items) {
      if (l.jobKitLineId) issuedByLine.set(l.jobKitLineId, (issuedByLine.get(l.jobKitLineId) ?? 0) + l.qty);
    }
  }

  for (const job of jobs) {
    const gs = goodsStatusOf.get(job.id) ?? "not_issued";
    // Once goods are fully issued/returned/reconciled there's no future warehouse draw left.
    if (gs === "issued" || gs === "awaiting_return" || gs === "reconciled") continue;
    for (const kl of job.kitLines ?? []) {
      if (kl.lineType === "misc") continue; // misc isn't stock-tracked
      const demand = Math.max(0, kl.qty - (issuedByLine.get(kl.id) ?? 0));
      if (demand <= 0) continue;
      // Key by item + warehouse for BOTH sources (customer stock too) so the per-warehouse demand
      // board attributes each line to its own warehouse — never collapses two warehouses' demand onto
      // whichever kit line happened to land in the map first.
      // THREE pools, not two. The old two-arm ternary keyed anything without an IRM id as
      // `cse|<id>|<wh>`, so every rental line in the system collapsed onto the single key
      // `cse|null|<warehouse>` — one bucket per warehouse, shared by every hired item AND by any
      // customer line whose entry id was missing, with all their demand summed into it.
      const key = kl.irmItemId
        ? `irm|${kl.irmItemId}|${kl.warehouseId}`
        : kl.rentalItemId
          ? `rental|${kl.rentalItemId}|${kl.warehouseId}`
          : `cse|${kl.customerStockEntryId}|${kl.warehouseId}`;
      const e = out.get(key);
      if (e) e.demand += demand;
      else out.set(key, {
        irmItemId: kl.irmItemId ?? null,
        rentalItemId: kl.rentalItemId ?? null,
        customerStockEntryId: kl.customerStockEntryId ?? null,
        warehouseId: kl.warehouseId ?? null,
        itemName: kl.itemName,
        warehouseName: kl.warehouseName ?? null,
        demand,
      });
    }
  }
  return out;
}
