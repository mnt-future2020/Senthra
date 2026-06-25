import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as goodsManagementRepo from "./goods-management.repository.js";
import type { ScanLookupInput } from "./goods-management.validation.js";

export interface ScanMatch {
  source: "irm" | "customer";
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string;
  itemName: string;
  uom?: string | null;
  plannedQty: number;
  alreadyIssued: number;
  remainingIssuable: number;
  available: number; // current warehouse availability of this item
}

// Sum the qty already issued for a kit line (issue lines minus return lines pointing at it).
function issuedForKitLine(movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>, kitLineId: string): number {
  let n = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "issue") n += l.qty;
      if (m.direction === "return") n -= l.qty; // a return frees the planned allocation back
    }
  }
  return n;
}

export async function scanLookup(input: ScanLookupInput, actor?: AuditActor): Promise<ScanMatch> {
  const job = await jobRepo.findById(input.jobId);
  if (!job) throw notFound("Job not found.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const code = input.code.trim();

  // 1) IRM lookup by code/barcode/sku.
  const irmItem = await irmService.findActiveByCodeOrBarcode(code);
  if (irmItem) {
    if (irmItem.trackSerialNumbers || irmItem.trackBatchNumbers) {
      throw conflict(`${irmItem.name} is serial/batch-tracked — those items can't be moved here yet.`);
    }
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === irmItem.id);
    if (!kit) throw badRequest(`${irmItem.name} is not on this job's kit list.`);
    const already = issuedForKitLine(movements, kit.id);
    const bal = await inventoryRepo.findBalancePair(irmItem.id, kit.warehouseId!);
    const available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    if (kit.warehouseId) assertWarehouseAccess(actor, kit.warehouseId);
    return {
      source: "irm", irmItemId: irmItem.id, jobKitLineId: kit.id, itemName: irmItem.name, uom: irmItem.baseUnit,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available,
    };
  }

  // 2) Customer stock entry lookup by barcode.
  const entry = await goodsManagementRepo.findCustomerStockEntryByBarcode(code);
  if (entry) {
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id);
    if (!kit) throw badRequest(`${entry.itemName} is not on this job's kit list.`);
    const already = issuedForKitLine(movements, kit.id);
    if (entry.warehouseId) assertWarehouseAccess(actor, entry.warehouseId);
    return {
      source: "customer", customerStockEntryId: entry.id, jobKitLineId: kit.id, itemName: entry.itemName, uom: entry.uom,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available: entry.quantity,
    };
  }

  throw notFound(`No item matches "${code}".`);
}

export { warehouseScopeFilter }; // re-export for the queue task
