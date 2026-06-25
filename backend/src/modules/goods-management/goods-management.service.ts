import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import * as goodsManagementRepo from "./goods-management.repository.js";
import type { PostMovementInput, ScanLookupInput } from "./goods-management.validation.js";

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
    if (kit.warehouseId) assertWarehouseAccess(actor, kit.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    const bal = await inventoryRepo.findBalancePair(irmItem.id, kit.warehouseId!);
    const available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    return {
      source: "irm", irmItemId: irmItem.id, jobKitLineId: kit.id, itemName: irmItem.name, uom: irmItem.baseUnit,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available,
    };
  }

  // 2) Customer stock entry lookup by barcode.
  const entry = await goodsManagementRepo.findCustomerStockEntryByBarcode(code);
  if (entry) {
    if (entry.warehouseId) assertWarehouseAccess(actor, entry.warehouseId);
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id);
    if (!kit) throw badRequest(`${entry.itemName} is not on this job's kit list.`);
    const already = issuedForKitLine(movements, kit.id);
    return {
      source: "customer", customerStockEntryId: entry.id, jobKitLineId: kit.id, itemName: entry.itemName, uom: entry.uom,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available: entry.quantity,
    };
  }

  throw notFound(`No item matches "${code}".`);
}

export { warehouseScopeFilter }; // re-export for the queue task

// ── Public shape returned to callers ───────────────────────────────────────────────────────────
export interface PublicMovement {
  id: string;
  code: string;
  jobId: string;
  direction: string;
  status: string;
  engineerId: string;
  engineerName: string;
  warehouseId: string | null;
  lines: { source: string; irmItemId: string | null; customerStockEntryId: string | null; itemName: string; qty: number; condition: string }[];
}

function toPublic(m: goodsManagementRepo.JobStockMovementWithRelations): PublicMovement {
  return {
    id: m.id,
    code: m.code,
    jobId: m.jobId,
    direction: m.direction,
    status: m.status,
    engineerId: m.engineerId,
    engineerName: m.engineerName,
    warehouseId: m.warehouseId,
    lines: m.items.map((l) => ({
      source: l.source,
      irmItemId: l.irmItemId,
      customerStockEntryId: l.customerStockEntryId,
      itemName: l.itemName,
      qty: l.qty,
      condition: l.condition,
    })),
  };
}

async function loadJobOrThrow(jobId: string) {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");
  if (!job.assignedEngineerId) throw conflict("This job has no assigned engineer.");
  return job;
}

// ── Issue flow: scan-out warehouse → engineer ─────────────────────────────────────────────────
export async function postIssue(jobId: string, input: PostMovementInput, actor?: AuditActor): Promise<PublicMovement> {
  if (input.direction !== "issue") throw badRequest("Wrong direction for issue.");
  const job = await loadJobOrThrow(jobId);
  if (!["accepted", "in_progress"].includes(job.status)) {
    throw conflict("Stock can only be issued for an accepted/in-progress job.");
  }
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);

  // Resolve + validate every line against the kit list BEFORE opening the tx.
  type Resolved = {
    line: (typeof input.lines)[number];
    kit: NonNullable<typeof job.kitLines>[number];
    itemName: string;
    uom: string | null;
    warehouseId: string;
  };
  const resolved: Resolved[] = [];
  for (const line of input.lines) {
    if (!line.jobKitLineId) throw badRequest("Each issued line must reference a kit line.");
    const kit = (job.kitLines ?? []).find((k) => k.id === line.jobKitLineId);
    if (!kit) throw badRequest("Kit line not found on this job.");
    const already = issuedForKitLine(movements, kit.id);
    if (line.qty > kit.qty - already) {
      throw conflict(`${kit.itemName}: only ${kit.qty - already} remaining on the kit list.`);
    }
    if (line.source === "irm") {
      const irm = await irmService.requireActiveIrmItem(line.irmItemId!);
      if (irm.trackSerialNumbers || irm.trackBatchNumbers) {
        throw conflict(`${irm.name} is serial/batch-tracked and can't be moved here.`);
      }
      resolved.push({ line, kit, itemName: irm.name, uom: irm.baseUnit, warehouseId: kit.warehouseId! });
    } else {
      const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId!);
      if (!entry) throw badRequest("Customer stock item not found.");
      resolved.push({ line, kit, itemName: entry.itemName, uom: entry.uom, warehouseId: entry.warehouseId! });
    }
    assertWarehouseAccess(actor, resolved[resolved.length - 1].warehouseId);
  }

  const warehouseId = resolved[0].warehouseId;
  const actorEmail = actor?.email ?? null;
  // derive engineerName from snapshot fields (set at assign-time)
  const engineerName = job.assignedEngineerName ?? "";
  const engineerEmail = job.assignedEngineerEmail ?? null;
  // derive warehouseName/warehouseCode from the first kit line's snapshots
  const warehouseName = resolved[0].kit.warehouseName ?? null;
  const warehouseCode = resolved[0].kit.warehouseCode ?? null;

  const lines = resolved.map((r) => ({
    source: r.line.source,
    irmItemId: r.line.source === "irm" ? r.line.irmItemId! : null,
    customerStockEntryId: r.line.source === "customer" ? r.line.customerStockEntryId! : null,
    itemName: r.itemName,
    sku: null,
    uom: r.uom,
    qty: r.line.qty,
    condition: "good",
    jobKitLineId: r.kit.id,
    scannedCode: r.line.scannedCode ?? null,
    damagePhotoUrl: null,
    damageReason: null,
    notes: r.line.notes ?? null,
  }));

  const created = await goodsManagementRepo.createMovementWithCode(
    {
      jobId: job.id,
      direction: "issue",
      engineerId: job.assignedEngineerId!,
      engineerName,
      engineerEmail,
      warehouseId,
      warehouseName,
      warehouseCode,
      status: "posted",
      postedAt: new Date(),
      performedBy: actorEmail,
      createdBy: actorEmail,
    },
    lines,
    async (tx, movementId, code) => {
      for (const r of resolved) {
        if (r.line.source === "irm") {
          const live = await inventoryRepo.findBalancePairTx(tx, r.line.irmItemId!, r.warehouseId);
          const available = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
          if (r.line.qty > available) {
            throw conflict(`${r.itemName}: only ${available} available — stock changed.`);
          }
          await inventoryService.applyOutbound(tx, {
            irmItemId: r.line.irmItemId!,
            warehouseId: r.warehouseId,
            quantity: r.line.qty,
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            createdBy: actorEmail,
          });
          const eng = await goodsOutRepo.upsertEngineerBalanceTx(tx, r.line.irmItemId!, job.assignedEngineerId!, r.line.qty);
          await goodsOutRepo.insertEngineerTxnTx(tx, {
            irmItemId: r.line.irmItemId!,
            engineerId: job.assignedEngineerId!,
            quantityDelta: r.line.qty,
            type: "job_issue",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });
        } else {
          const liveEntry = await goodsManagementRepo.findCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!);
          if (r.line.qty > (liveEntry?.quantity ?? 0)) {
            throw conflict(`${r.itemName}: only ${liveEntry?.quantity ?? 0} available — customer stock changed.`);
          }
          const entry = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!, -r.line.qty);
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, r.line.customerStockEntryId!, job.assignedEngineerId!, r.line.qty, { customerId: entry.customerId, itemName: entry.itemName });
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId: r.line.customerStockEntryId!,
            engineerId: job.assignedEngineerId!,
            quantityDelta: r.line.qty,
            type: "job_issue",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });
        }
      }
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "issued" });
    },
  );

  audit.record({ actor, action: "goods_management.issued", targetType: "job", targetId: job.id, targetLabel: created.code });
  return toPublic(created);
}

// ── Queue: planned vs available ───────────────────────────────────────────────────────────────

export interface QueueKitLine {
  kitLineId: string;
  lineType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  planned: number;
  issued: number;
  available: number; // warehouse pool (no cost/value exposed)
}

export interface QueueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  customerId: string;
  customerName: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  status: string;
  goodsStatus: string; // from JobStockSummary (default not_issued)
  kitLines: QueueKitLine[];
}

export interface JobGoodsDetail {
  job: {
    id: string;
    jobNumber: string;
    name: string;
    customerId: string;
    customerName: string | null;
    assignedEngineerId: string | null;
    assignedEngineerName: string | null;
    status: string;
  };
  summary: { goodsStatus: string; workSummary: string | null; lastMovementAt: Date | null } | null;
  movements: PublicMovement[];
  /** Per-kit-line tallies (plan spec key: `lines`). */
  lines: QueueKitLine[];
}

export async function listQueue(actor?: AuditActor): Promise<QueueRow[]> {
  const scopeIds = warehouseScopeFilter(actor);
  const jobs = await jobRepo.findActiveForGoodsManagement(scopeIds);

  // TODO(perf): N+1 pattern — for each job we issue 2 DB calls (findMovementsByJob +
  // getSummary) then 1 call per kit line (findBalancePair / findCustomerStockEntryById).
  // At scale (e.g. 50 jobs × 10 lines) this produces 600+ serial Mongo round-trips per
  // request. Fix: batch movements via a single findMany({ where: { jobId: { in: jobIds } } })
  // and batch balance lookups; defer until the queue endpoint shows measurable latency.
  const rows: QueueRow[] = [];
  for (const job of jobs) {
    const movements = await goodsManagementRepo.findMovementsByJob(job.id);
    const summary = await goodsManagementRepo.getSummary(job.id);

    // Build per-kit-line tallies. Only include lines that belong to accessible warehouses.
    const kitLineRows: QueueKitLine[] = [];
    for (const kl of job.kitLines ?? []) {
      // For warehouse-scoped actors, skip lines outside their scope.
      if (scopeIds !== undefined && kl.warehouseId && !scopeIds.includes(kl.warehouseId)) continue;

      const issued = issuedForKitLine(movements, kl.id);
      let available = 0;
      if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
        const bal = await inventoryRepo.findBalancePair(kl.irmItemId, kl.warehouseId);
        available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
      } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
        const entry = await goodsManagementRepo.findCustomerStockEntryById(kl.customerStockEntryId);
        available = entry?.quantity ?? 0;
        // NOTE: no cost/value exposed — only qty
      }
      kitLineRows.push({
        kitLineId: kl.id,
        lineType: kl.lineType,
        irmItemId: kl.irmItemId,
        customerStockEntryId: kl.customerStockEntryId,
        itemName: kl.itemName,
        warehouseId: kl.warehouseId,
        warehouseName: kl.warehouseName,
        warehouseCode: kl.warehouseCode,
        planned: kl.qty,
        issued,
        available,
      });
    }

    rows.push({
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobName: job.name,
      customerId: job.customerId,
      customerName: job.customerName,
      assignedEngineerId: job.assignedEngineerId,
      assignedEngineerName: job.assignedEngineerName,
      status: job.status,
      goodsStatus: summary?.goodsStatus ?? "not_issued",
      kitLines: kitLineRows,
    });
  }
  return rows;
}

export async function getJobGoods(jobId: string, actor?: AuditActor): Promise<JobGoodsDetail> {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");

  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const summary = await goodsManagementRepo.getSummary(job.id);

  const lines: QueueKitLine[] = [];
  for (const kl of job.kitLines ?? []) {
    if (kl.warehouseId) assertWarehouseAccess(actor, kl.warehouseId);

    const issued = issuedForKitLine(movements, kl.id);
    let available = 0;
    if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
      const bal = await inventoryRepo.findBalancePair(kl.irmItemId, kl.warehouseId);
      available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
      const entry = await goodsManagementRepo.findCustomerStockEntryById(kl.customerStockEntryId);
      available = entry?.quantity ?? 0;
      // NOTE: no cost/value exposed
    }
    lines.push({
      kitLineId: kl.id,
      lineType: kl.lineType,
      irmItemId: kl.irmItemId,
      customerStockEntryId: kl.customerStockEntryId,
      itemName: kl.itemName,
      warehouseId: kl.warehouseId,
      warehouseName: kl.warehouseName,
      warehouseCode: kl.warehouseCode,
      planned: kl.qty,
      issued,
      available,
    });
  }

  return {
    job: {
      id: job.id,
      jobNumber: job.jobNumber,
      name: job.name,
      customerId: job.customerId,
      customerName: job.customerName,
      assignedEngineerId: job.assignedEngineerId,
      assignedEngineerName: job.assignedEngineerName,
      status: job.status,
    },
    summary: summary
      ? { goodsStatus: summary.goodsStatus, workSummary: summary.workSummary, lastMovementAt: summary.lastMovementAt }
      : null,
    movements: movements.map(toPublic),
    lines,
  };
}
