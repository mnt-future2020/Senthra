import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import * as jobRepo from "#modules/job/job.repository.js";
import type { JobWithRelations } from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import * as goodsManagementRepo from "./goods-management.repository.js";
import type { CloseReconcileInput, PostMovementInput, RestoreDamagedInput, ScanLookupInput } from "./goods-management.validation.js";
import { withTransaction } from "../../lib/prisma.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";

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
  // Qty the engineer still holds for this line (issued − used − already-returned) — the cap for returns.
  heldByEngineer: number;
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

// Split a kit line's posted movements into GROSS issued / used (consumed, incl. lost) / returned.
// Powers the queue's per-item lifecycle status (issued → awaiting return → returned/used).
function kitLineSplit(movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>, kitLineId: string): { issued: number; used: number; returned: number } {
  let issued = 0;
  let used = 0;
  let returned = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "issue") issued += l.qty;
      else if (m.direction === "consume") used += l.qty;
      else if (m.direction === "return") returned += l.qty;
    }
  }
  return { issued, used, returned };
}

export interface KitLineTally {
  issued: number;
  used: number; // consumed/used on site (incl. lost write-offs)
  returned: number;
  remaining: number; // still held by the engineer = issued − used − returned
}

// Per-kit-line goods tallies for a single job, keyed by jobKitLineId. Used on the job-detail "job
// pack" views so the engineer/office can see issued / returned / remaining per item.
export async function getJobKitTallies(jobId: string): Promise<Record<string, KitLineTally>> {
  const job = await jobRepo.findById(jobId);
  const movements = await goodsManagementRepo.findMovementsByJob(jobId);
  const acc: Record<string, { issued: number; returned: number; consumed: number }> = {};
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      const e = (acc[l.jobKitLineId] ??= { issued: 0, returned: 0, consumed: 0 });
      if (m.direction === "issue") e.issued += l.qty;
      else if (m.direction === "return") e.returned += l.qty;
      else if (m.direction === "consume") e.consumed += l.qty;
    }
  }

  // "Remaining" must reflect what the engineer ACTUALLY still holds (global per item), not raw issued −
  // returned − used. A unit returned at another warehouse, or handed back under another job (a shared
  // customer-stock entry), correctly shows remaining 0 here too — matching the scan / queue / reconcile.
  const engId = job?.assignedEngineerId ?? null;
  const irmHeld = new Map<string, number>();
  const cseHeld = new Map<string, number>();
  if (engId) {
    for (const b of await engineerStockRepo.findEngineerBalances(engId)) irmHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(engId)) cseHeld.set(h.customerStockEntryId, h.quantityOnHand);
  }

  // Distribute each item's real held across its kit lines (capped at each line's raw remaining), so the
  // per-line "remaining" sums to the engineer's true holding. Misc lines aren't engineer-tracked, so
  // they keep their raw remaining. Keyed by current kit lines (orphaned movements are ignored).
  const out: Record<string, KitLineTally> = {};
  const groups = new Map<string, NonNullable<JobWithRelations["kitLines"]>>();
  for (const kl of job?.kitLines ?? []) {
    const key = kl.irmItemId ? `irm:${kl.irmItemId}` : kl.customerStockEntryId ? `cse:${kl.customerStockEntryId}` : `misc:${kl.id}`;
    const g = groups.get(key);
    if (g) g.push(kl);
    else groups.set(key, [kl]);
  }
  for (const group of groups.values()) {
    let remainingHeld = group[0].lineType === "misc"
      ? Number.MAX_SAFE_INTEGER // misc isn't engineer-tracked → keep its raw remaining
      : group[0].irmItemId ? irmHeld.get(group[0].irmItemId) ?? 0 : cseHeld.get(group[0].customerStockEntryId!) ?? 0;
    for (const kl of group) {
      const e = acc[kl.id] ?? { issued: 0, returned: 0, consumed: 0 };
      const rawRemaining = Math.max(0, e.issued - e.returned - e.consumed);
      const remaining = Math.min(rawRemaining, remainingHeld);
      remainingHeld -= remaining;
      out[kl.id] = { issued: e.issued, used: e.consumed, returned: e.returned, remaining };
    }
  }
  return out;
}

// Current goods-lifecycle status for a job ("not_issued" if no stock has moved yet). The job module
// uses this to lock the kit list once stock has been issued (changing it would orphan movements).
export async function getGoodsStatus(jobId: string): Promise<string> {
  const summary = await goodsManagementRepo.getSummary(jobId);
  return summary?.goodsStatus ?? "not_issued";
}

// Goods-lifecycle status for many jobs in ONE query, keyed by jobId (missing → "not_issued"). Lets
// the jobs list show each job's issuance state without an N+1 over the summary collection.
export async function getGoodsStatusByJobs(jobIds: string[]): Promise<Map<string, string>> {
  const summaries = await goodsManagementRepo.getSummariesByJobs(jobIds);
  return new Map(summaries.map((s) => [s.jobId, s.goodsStatus]));
}

// ── Open demand (cross-job stock commitments) ───────────────────────────────────────────────────
// "Open demand" = stock that ACTIVE jobs have planned but NOT yet issued. Issued stock has already
// left the warehouse (on-hand reflects it), so demand = Σ max(0, planned − grossIssued) over the kit
// lines of jobs whose goods aren't fully issued. This is the missing piece the per-job qty cap can't
// see: it lets the planner (and the warehouse demand board) work off TRUE free stock across ALL jobs,
// not just one — so the same units can't be silently promised to two jobs.
export interface DemandEntry {
  irmItemId: string | null;
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
      const key = kl.irmItemId ? `irm|${kl.irmItemId}|${kl.warehouseId}` : `cse|${kl.customerStockEntryId}|${kl.warehouseId}`;
      const e = out.get(key);
      if (e) e.demand += demand;
      else out.set(key, {
        irmItemId: kl.irmItemId ?? null,
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

export interface WarehouseDemandRow {
  source: "irm" | "customer";
  itemName: string;
  inStock: number; // current free warehouse stock (on-hand − reserved / customer entry qty)
  planned: number; // open demand across active jobs
  free: number; // inStock − planned (negative ⇒ short)
}

// Demand board for ONE warehouse: every item that active jobs plan to draw FROM this warehouse, with
// its current stock vs total planned, shortfalls first. Reuses getOpenDemand so the numbers always
// match the planner's "free" figure.
export async function getWarehouseDemand(warehouseId: string): Promise<WarehouseDemandRow[]> {
  const demand = [...(await getOpenDemand()).values()].filter((d) => d.warehouseId === warehouseId);
  if (demand.length === 0) return [];

  const irmIds = demand.filter((d) => d.irmItemId).map((d) => d.irmItemId!);
  const cseIds = demand.filter((d) => d.customerStockEntryId).map((d) => d.customerStockEntryId!);
  const balByItem = new Map(
    (await inventoryRepo.findBalancesByItemsAndWarehouses(irmIds, [warehouseId])).map((b) => [b.irmItemId, b]),
  );
  const cseQty = new Map((await goodsManagementRepo.findCustomerStockEntriesByIds(cseIds)).map((e) => [e.id, e.quantity]));

  return demand
    .map((d) => {
      const inStock = d.irmItemId
        ? (balByItem.get(d.irmItemId)?.quantityOnHand ?? 0) - (balByItem.get(d.irmItemId)?.quantityReserved ?? 0)
        : cseQty.get(d.customerStockEntryId!) ?? 0;
      return { source: d.irmItemId ? ("irm" as const) : ("customer" as const), itemName: d.itemName, inStock, planned: d.demand, free: inStock - d.demand };
    })
    .sort((a, b) => a.free - b.free); // shortfalls (most negative free) first
}

// Qty on a kit line that reached the engineer from another engineer's VAN (a completed job-scoped
// transfer), keyed by kit-line id. Pending transfers are excluded — nothing has physically moved yet.
async function completedVanQtyByKitLine(kitLineIds: string[]): Promise<Map<string, number>> {
  const byLine = await transferRepo.findVanSourcesByKitLines(kitLineIds);
  const out = new Map<string, number>();
  for (const [lineId, sources] of byLine) {
    out.set(lineId, sources.filter((s) => s.status === "completed").reduce((n, s) => n + s.quantity, 0));
  }
  return out;
}

// A return may normally only be scanned at the kit line's own warehouse: that warehouse released the
// stock, so it must be the one credited back, or its ledger gains units it never issued while the
// real issuer stays short.
//
// Van-sourced stock is different — it came engineer→engineer and NO warehouse ever released it, so
// none is owed it back. Handing it in anywhere is a clean gain for whichever warehouse receives it.
//
// Kit lines MERGE sources (2 collected from a warehouse + 3 from a van become one row), so a line can
// owe part of itself to its home warehouse and none of the rest. This computes how many units of ONE
// kit line may still be returned AWAY from its home. Only the van portion qualifies, and it's capped
// conservatively — consumption and any prior away-from-home returns are assumed to have used the van
// units first — so the running total of away-from-home returns can never exceed the van quantity.
// That guarantees the warehouse-owed part is always brought home, never mis-credited elsewhere. We
// can't tell one physical box from another; this is the safe accounting, not a per-unit truth.
function vanReturnableAwayFromHome(
  movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>,
  kitLineId: string,
  homeWarehouseId: string | null,
  vanQty: number,
): number {
  let used = 0;
  let awayReturned = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "consume") used += l.qty;
      else if (m.direction === "return" && m.warehouseId !== homeWarehouseId) awayReturned += l.qty;
    }
  }
  return Math.max(0, vanQty - used - awayReturned);
}

// For a return being scanned at a warehouse that ISN'T a kit line's home: find the kit line for the
// item that can still take a return here (its van portion), and how many units it may take. Picks the
// line with the most remaining allowance when the item is homed at several. Null ⇒ nothing here.
async function findAwayReturnKitLine<T extends { id: string; warehouseId: string | null }>(
  candidates: T[],
  movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>,
): Promise<{ kit: T; cap: number } | null> {
  if (candidates.length === 0) return null;
  const vanQty = await completedVanQtyByKitLine(candidates.map((c) => c.id));
  let best: { kit: T; cap: number } | null = null;
  for (const c of candidates) {
    const cap = vanReturnableAwayFromHome(movements, c.id, c.warehouseId, vanQty.get(c.id) ?? 0);
    if (cap > 0 && (!best || cap > best.cap)) best = { kit: c, cap };
  }
  return best;
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
    // Match the kit line for THIS item AT THIS warehouse — a job can list the same IRM item at more
    // than one warehouse, so picking the first by item id alone would resolve the wrong warehouse.
    let kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === irmItem.id && k.warehouseId === input.warehouseId);
    // When the item isn't homed at the scanning warehouse, a RETURN of its VAN portion may still land
    // here (van stock owes no warehouse). awayCap is that allowance; null ⇒ a normal same-warehouse
    // return, capped by the whole line. Issues are unaffected — you can only issue what's actually held.
    let awayCap: number | null = null;
    if (!kit && input.direction === "return") {
      const away = await findAwayReturnKitLine(
        (job.kitLines ?? []).filter((k) => k.lineType === "irm" && k.irmItemId === irmItem.id),
        movements,
      );
      if (away) { kit = away.kit; awayCap = away.cap; }
    }
    if (!kit) {
      const onJobElsewhere = (job.kitLines ?? []).some((k) => k.lineType === "irm" && k.irmItemId === irmItem.id);
      throw badRequest(onJobElsewhere
        ? `${irmItem.name} is on this job but assigned to a different warehouse — issue it from there.`
        : `${irmItem.name} is not on this job's kit list.`);
    }
    assertWarehouseAccess(actor, input.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    // Availability is always read at the warehouse being scanned — for a van return that's where the
    // stock is actually landing, not the line's nominal home.
    const bal = await inventoryRepo.findBalancePair(irmItem.id, input.warehouseId);
    const available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    // Return cap, bounded by the engineer's REAL global holding. At the line's HOME warehouse that's
    // the whole line still out (issued − used − returned) — an item issued from two warehouses must
    // only allow back at each what actually left it, else one is over-credited and the other short.
    // Away from home, only the van portion may land (awayCap). The global bound also covers the
    // cross-job case (item handed back under another job → global lower).
    const split = kitLineSplit(movements, kit.id);
    const lineOutstanding = Math.max(0, split.issued - split.used - split.returned);
    const globalHeld = job.assignedEngineerId
      ? (await engineerStockRepo.findEngineerBalance(irmItem.id, job.assignedEngineerId))?.quantityOnHand ?? 0
      : 0;
    const held = Math.min(awayCap ?? lineOutstanding, globalHeld);
    return {
      source: "irm", irmItemId: irmItem.id, jobKitLineId: kit.id, itemName: irmItem.name, uom: irmItem.baseUnit,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already,
      heldByEngineer: held, available,
    };
  }

  // 2) Customer stock entry lookup by barcode.
  const entry = await goodsManagementRepo.findCustomerStockEntryByBarcode(code);
  if (entry) {
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id && k.warehouseId === input.warehouseId);
    if (!kit) {
      const onJobElsewhere = (job.kitLines ?? []).some((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id);
      throw badRequest(onJobElsewhere
        ? `${entry.itemName} is on this job but assigned to a different warehouse.`
        : `${entry.itemName} is not on this job's kit list.`);
    }
    assertWarehouseAccess(actor, input.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    // Per-warehouse return cap (see IRM branch): still-out from this line, bounded by global holding.
    const split = kitLineSplit(movements, kit.id);
    const lineOutstanding = Math.max(0, split.issued - split.used - split.returned);
    const globalHeld = job.assignedEngineerId
      ? (await goodsManagementRepo.findCustomerHolding(entry.id, job.assignedEngineerId))?.quantityOnHand ?? 0
      : 0;
    const held = Math.min(lineOutstanding, globalHeld);
    return {
      source: "customer", customerStockEntryId: entry.id, jobKitLineId: kit.id, itemName: entry.itemName, uom: entry.uom,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already,
      heldByEngineer: held, available: entry.quantity,
    };
  }

  throw notFound(`No item matches "${code}".`);
}

// ── Damage-photo upload ───────────────────────────────────────────────────────────────────────
// Receives a data URI from the WM scan panel, uploads it to Cloudinary, and returns the hosted URL.
// The caller (JobScanPanel) stores this URL in the movement line's damagePhotoUrl field, so no raw
// data URI ever reaches the movement-post endpoint (which validates max 2000 chars — a Cloudinary
// URL is always shorter).
export async function uploadDamagePhoto(image: string): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your Cloudinary credentials in Settings → Integrations (or set CLOUDINARY_* in the backend env).",
    );
  }
  // Use a timestamp-based unique publicId so each damage photo is stored as a distinct asset
  // (no overwrite — unlike branding, damage photos must be preserved for audit purposes).
  const publicId = `damage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = await uploadToCloudinary(image, publicId, creds, "senthra/damage-photos");
  return { url };
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
  const summary = await goodsManagementRepo.getSummary(job.id);
  if (summary?.goodsStatus === "reconciled") throw conflict("This job has already been reconciled and is locked.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);

  // Resolve + validate every line against the kit list BEFORE opening the tx.
  type Resolved = {
    line: (typeof input.lines)[number];
    kit: NonNullable<typeof job.kitLines>[number];
    itemName: string;
    uom: string | null;
    warehouseId: string | null; // null for misc lines (no stock / no warehouse)
    customerId?: string | null;
    customerName?: string | null;
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
    } else if (line.source === "customer") {
      const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId!);
      if (!entry) throw badRequest("Customer stock item not found.");
      resolved.push({ line, kit, itemName: entry.itemName, uom: entry.uom, warehouseId: entry.warehouseId!, customerId: entry.customerId, customerName: entry.customer?.name ?? null });
    } else {
      // misc — free-text kit line, no stock / no warehouse. Issued by count (handed over), no ledger.
      if (kit.lineType !== "misc") throw badRequest("This kit line isn't a misc item.");
      resolved.push({ line, kit, itemName: kit.itemName, uom: null, warehouseId: null });
    }
    // Real lines can only be issued FROM their own pickup warehouse (admins are unrestricted
    // otherwise). Misc lines have no warehouse and may be issued from any warehouse.
    if (line.source !== "misc") {
      if (kit.warehouseId !== input.warehouseId) {
        throw badRequest(`${kit.itemName} isn't stocked at this warehouse and can't be issued from here.`);
      }
      assertWarehouseAccess(actor, input.warehouseId);
    }
  }

  const warehouseId = input.warehouseId; // the warehouse being managed (always set; misc has no own wh)
  const actorEmail = actor?.email ?? null;
  // derive engineerName from snapshot fields (set at assign-time)
  const engineerName = job.assignedEngineerName ?? "";
  const engineerEmail = job.assignedEngineerEmail ?? null;
  // warehouse snapshot from the first REAL line at this warehouse (misc lines carry no warehouse).
  const realLine = resolved.find((r) => r.line.source !== "misc");
  const warehouseName = realLine?.kit.warehouseName ?? null;
  const warehouseCode = realLine?.kit.warehouseCode ?? null;

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
          const live = await inventoryRepo.findBalancePairTx(tx, r.line.irmItemId!, r.warehouseId!);
          const available = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
          if (r.line.qty > available) {
            throw conflict(`${r.itemName}: only ${available} available — stock changed.`);
          }
          await inventoryService.applyOutbound(tx, {
            irmItemId: r.line.irmItemId!,
            warehouseId: r.warehouseId!,
            quantity: r.line.qty,
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            createdBy: actorEmail,
          });
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, r.line.irmItemId!, job.assignedEngineerId!, r.line.qty);
          await engineerStockRepo.insertEngineerTxnTx(tx, {
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
        } else if (r.line.source === "customer") {
          const liveEntry = await goodsManagementRepo.findCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!);
          if (r.line.qty > (liveEntry?.quantity ?? 0)) {
            throw conflict(`${r.itemName}: only ${liveEntry?.quantity ?? 0} available — customer stock changed.`);
          }
          const entry = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!, -r.line.qty);
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, r.line.customerStockEntryId!, job.assignedEngineerId!, r.line.qty, { customerId: entry.customerId, customerName: r.customerName ?? null, itemName: entry.itemName });
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
      // Determine the correct goodsStatus after this movement: "issued" only when EVERY kit line —
      // including misc — is fully issued; otherwise "partially_issued". Misc lines are issued by
      // count in the panel, so a pending misc item keeps the job "partially_issued" until it's done.
      const allKitLines = job.kitLines ?? [];
      const isFullyIssued =
        allKitLines.length > 0 &&
        allKitLines.every((kl) => {
          // Accumulate issued qty for this kit line from existing movements + ALL qty being posted now.
          // SUM the new lines (not .find) — a single issue request can carry more than one line for the
          // same kit line, and counting only the first would mis-set the status.
          let issued = issuedForKitLine(movements, kl.id);
          for (const r of resolved) if (r.kit.id === kl.id) issued += r.line.qty;
          return issued >= kl.qty;
        });
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: isFullyIssued ? "issued" : "partially_issued" });
    },
  );

  audit.record({ actor, action: "goods_management.issued", targetType: "job", targetId: job.id, targetLabel: created.code });

  // Realtime: notify the engineer + all office staff watching the jobs list.
  const issuePayload = { jobId: job.id, movementId: created.id, code: created.code, direction: "issue" };
  emitToUser(job.assignedEngineerId!, "goods:issued", issuePayload);
  notify(job.assignedEngineerId!, { title: "Kit ready to collect", body: `Stock for ${job.jobNumber} has been issued — collect it from the warehouse.`, data: { type: "job", jobId: job.id } });
  emitToRoom(OFFICE_JOBS_ROOM, "goods:updated", issuePayload);

  return toPublic(created);
}

// ── Queue: planned vs available ───────────────────────────────────────────────────────────────

export interface QueueKitLine {
  id: string; // kit line id
  lineType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  plannedQty: number;
  issuedQty: number; // GROSS issued (total sent out, before returns)
  usedQty: number; // consumed/used on site (incl. lost write-offs)
  returnedQty: number; // returned to the warehouse
  engineerHeld: number; // engineer's REAL current holding of this item (same balance the return scan
  // checks; shared per item across jobs/warehouses) — caps how much can actually be returned
  available: number; // warehouse pool (no cost/value exposed)
  // How many still-out units of this line came from another engineer's van and so may be RETURNED at
  // any warehouse (no warehouse released them; the return path enforces the same via
  // vanReturnableAwayFromHome). > 0 lets the queue keep the line actionable away from its nominal home
  // instead of greying it out. For a MIXED line this is just the van portion — the warehouse-issued
  // part still owes its home. 0 for an ordinary warehouse-issued line.
  vanReturnableQty: number;
  // Total units of this line handed over from a van (completed transfers). Lets the queue show the
  // source split — "N from stock · M from van" — so a merged line's composition is visible rather
  // than hidden behind one issued total. The warehouse-issued part is issuedQty − vanIssuedQty.
  vanIssuedQty: number;
}

export interface QueueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  customerId: string;
  customerName: string | null;
  assignedEngineerId: string | null;
  engineerName: string | null;
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

export interface QueuePage {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Queue status filters. "active" = anything still needing work (everything except reconciled); the
// others target one exact goodsStatus. "reconciled" backs the read-only Closed / history view.
export const QUEUE_STATUSES = ["active", "not_issued", "partially_issued", "issued", "awaiting_return", "reconciled"] as const;
export type QueueStatusFilter = (typeof QUEUE_STATUSES)[number];

export interface QueueParams {
  warehouseId: string;
  status?: string; // one of QUEUE_STATUSES; defaults to "active"
  search?: string; // job number / name / customer / engineer (DB-filtered)
  page?: number;
  pageSize?: number;
}

const DEFAULT_QUEUE_PAGE_SIZE = 20;
const MAX_QUEUE_PAGE_SIZE = 100;

// Assemble one QueueKitLine from pre-batched lookups: warehouse availability, the movement split
// (issued/used/returned) and the engineer's real holding. Shared by the queue list and the single-job
// detail so the two views can never drift on how "available"/"held"/the split are computed (the bug the
// detail N+1 fix exposed). Each caller batches the lookups its own way and passes the engineer holding in.
function buildKitLineRow(
  kl: {
    id: string;
    lineType: string;
    irmItemId: string | null;
    customerStockEntryId: string | null;
    itemName: string;
    warehouseId: string | null;
    warehouseName: string | null;
    warehouseCode: string | null;
    qty: number;
  },
  movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>,
  balByKey: Map<string, Awaited<ReturnType<typeof inventoryRepo.findBalancesByItemsAndWarehouses>>[number]>,
  cseQty: Map<string, number>,
  engineerHeld: number,
  vanQty: number, // qty on this line handed over from a van (completed transfers only)
): QueueKitLine {
  let available = 0;
  if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
    const bal = balByKey.get(`${kl.irmItemId}|${kl.warehouseId}`);
    available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
  } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
    available = cseQty.get(kl.customerStockEntryId) ?? 0; // qty only — no cost/value exposed
  }
  const split = kitLineSplit(movements, kl.id);
  return {
    id: kl.id,
    lineType: kl.lineType,
    irmItemId: kl.irmItemId,
    customerStockEntryId: kl.customerStockEntryId,
    itemName: kl.itemName,
    warehouseId: kl.warehouseId,
    warehouseName: kl.warehouseName,
    warehouseCode: kl.warehouseCode,
    plannedQty: kl.qty,
    issuedQty: split.issued, // gross issued (the per-item lifecycle status derives the rest)
    usedQty: split.used,
    returnedQty: split.returned,
    engineerHeld,
    available,
    vanReturnableQty: vanReturnableAwayFromHome(movements, kl.id, kl.warehouseId, vanQty),
    vanIssuedQty: Math.min(vanQty, split.issued), // clamp: a transfer can outlive a since-reduced line
  };
}

// The Goods Management queue for ONE warehouse: candidate jobs (a real line stocked here OR any misc
// line) filtered by goodsStatus + search, then paginated. Reconciled jobs are EXCLUDED from the
// default "active" view (they're done) and surfaced only via status="reconciled" (the read-only
// Closed view). Movements + balances are enriched for the CURRENT PAGE ONLY, in batched queries — so
// the endpoint stays ~5 round-trips regardless of how many jobs exist (was an N+1 of 600+).
export async function listQueue(params: QueueParams, actor?: AuditActor): Promise<QueuePage> {
  assertWarehouseAccess(actor, params.warehouseId);
  const status = params.status ?? "active";
  if (!QUEUE_STATUSES.includes(status as QueueStatusFilter)) throw badRequest(`Invalid status filter "${status}".`);
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? DEFAULT_QUEUE_PAGE_SIZE), 1), MAX_QUEUE_PAGE_SIZE);
  const search = params.search?.trim() || undefined;

  // 1) Candidate jobs for this warehouse, DB-filtered by job status + search, newest first. The query
  // also widens to jobs holding van-sourced stock (JobKitLine.hasVanSource) — that owes no warehouse
  // and is returnable at ANY of them, so a van return must be findable here even though its kit line
  // is homed elsewhere. Widening adds candidates, not noise: step 2c keeps such a job only while it
  // still has van stock out here.
  const jobs = await jobRepo.findActiveForGoodsManagement(params.warehouseId, search);

  // 2) goodsStatus per job (one batched query) → active / closed / exact-status filter.
  const summaries = await goodsManagementRepo.getSummariesByJobs(jobs.map((j) => j.id));
  const statusByJob = new Map(summaries.map((s) => [s.jobId, s.goodsStatus]));
  const goodsStatusOf = (jobId: string) => statusByJob.get(jobId) ?? "not_issued";
  const matchesStatus = (gs: string) => (status === "active" ? gs !== "reconciled" : gs === status);

  const byStatus = jobs.filter((j) => matchesStatus(goodsStatusOf(j.id)));

  // 2b) Drop jobs the DB matched ONLY through the warehouse-blind misc arm of the kit-line filter
  // (see jobRepo.findActiveForGoodsManagement) once that misc work is finished. A misc line carries
  // no warehouseId, so it pulls its job into EVERY warehouse's queue — right while the item is still
  // outstanding (any warehouse may hand it over), but pure noise afterwards: every line then renders
  // greyed out, nothing can be issued or returned here, and the job still inflates "Total: N jobs".
  //
  // This MUST be decided per LINE, not from the job-level goodsStatus: a job sitting at
  // "partially_issued" because a real line at ANOTHER warehouse is short has no work here at all,
  // yet the job-level status can't tell which line type is pending. So we pull issued-per-kit-line
  // for the status-matched candidates in ONE lean query (no relation includes) and mirror exactly
  // what the UI calls actionable — a real line at this warehouse, or a misc line not yet fully
  // issued (GoodsManagementTab: `active = isMisc ? !miscDone : atWh`). Running it here, BEFORE
  // pagination, is what keeps page counts and "Total: N jobs" honest.
  const issuedByLine = await goodsManagementRepo.findIssuedQtyByKitLine(byStatus.map((j) => j.id));
  const hasWorkHere = (j: (typeof jobs)[number]) =>
    (j.kitLines ?? []).some((kl) =>
      kl.lineType === "misc"
        ? (issuedByLine.get(kl.id) ?? 0) < kl.qty
        : kl.warehouseId === params.warehouseId,
    );

  // 2c) A job pulled in ONLY by the van widening (no line here, no pending misc) stays only if it
  // still has van stock returnable away from home — else it's a done job with nothing to do here, and
  // showing it would be the every-warehouse noise we avoid. Precise per-line check; movements load
  // ONLY for this subset (active van jobs not homed here), bounded well below the whole candidate set.
  const maybeVanOnly = byStatus.filter((j) => !hasWorkHere(j));
  const vanReturnableJobs = new Set<string>();
  if (maybeVanOnly.length > 0) {
    const movesByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
    for (const m of await goodsManagementRepo.findMovementsByJobs(maybeVanOnly.map((j) => j.id))) {
      (movesByJob.get(m.jobId) ?? movesByJob.set(m.jobId, []).get(m.jobId)!).push(m);
    }
    const vanQtyByLine = await completedVanQtyByKitLine(maybeVanOnly.flatMap((j) => (j.kitLines ?? []).map((k) => k.id)));
    for (const j of maybeVanOnly) {
      const has = (j.kitLines ?? []).some(
        (k) => k.lineType === "irm" && vanReturnableAwayFromHome(movesByJob.get(j.id) ?? [], k.id, k.warehouseId, vanQtyByLine.get(k.id) ?? 0) > 0,
      );
      if (has) vanReturnableJobs.add(j.id);
    }
  }

  const filtered = byStatus.filter((j) => hasWorkHere(j) || vanReturnableJobs.has(j.id));

  // 3) Paginate (createdAt-desc order preserved from the query).
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const pageJobs = filtered.slice((page - 1) * pageSize, page * pageSize);

  // 4) Enrich ONLY the page, in batched queries (movements grouped by job; IRM balances; customer qty).
  const movementsByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
  for (const m of await goodsManagementRepo.findMovementsByJobs(pageJobs.map((j) => j.id))) {
    const list = movementsByJob.get(m.jobId);
    if (list) list.push(m);
    else movementsByJob.set(m.jobId, [m]);
  }
  const irmItemIds = new Set<string>();
  const whIds = new Set<string>();
  const cseIds = new Set<string>();
  for (const j of pageJobs) {
    for (const kl of j.kitLines ?? []) {
      if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
        irmItemIds.add(kl.irmItemId);
        whIds.add(kl.warehouseId);
      } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
        cseIds.add(kl.customerStockEntryId);
      }
    }
  }
  const balByKey = new Map(
    (await inventoryRepo.findBalancesByItemsAndWarehouses([...irmItemIds], [...whIds])).map((b) => [`${b.irmItemId}|${b.warehouseId}`, b]),
  );
  const cseQty = new Map((await goodsManagementRepo.findCustomerStockEntriesByIds([...cseIds])).map((e) => [e.id, e.quantity]));

  // Engineer's REAL holding per item (same balance the return scan checks) — keyed by
  // `${engineerId}|${itemId}`. The holding is global per item (shared across jobs/warehouses), so this
  // is the only honest source for "to return": it can never claim more than the engineer actually has.
  // Batched per engineer (the page has only a handful), not per line.
  const engHeld = new Map<string, number>();
  for (const engId of [...new Set(pageJobs.map((j) => j.assignedEngineerId).filter((id): id is string => !!id))]) {
    for (const b of await engineerStockRepo.findEngineerBalances(engId)) engHeld.set(`${engId}|${b.irmItemId}`, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(engId)) engHeld.set(`${engId}|${h.customerStockEntryId}`, h.quantityOnHand);
  }

  // Van-supplied qty per kit line for the PAGE (one lean query) — decides which lines stay actionable
  // away from their nominal home warehouse.
  const vanQtyByLine = await completedVanQtyByKitLine(pageJobs.flatMap((j) => (j.kitLines ?? []).map((k) => k.id)));

  const rows: QueueRow[] = pageJobs.map((job) => {
    const movements = movementsByJob.get(job.id) ?? [];
    const heldOf = (kl: { irmItemId: string | null; customerStockEntryId: string | null }) => {
      if (!job.assignedEngineerId) return 0;
      const itemId = kl.irmItemId ?? kl.customerStockEntryId;
      return itemId ? engHeld.get(`${job.assignedEngineerId}|${itemId}`) ?? 0 : 0;
    };
    const kitLines: QueueKitLine[] = (job.kitLines ?? []).map((kl) => buildKitLineRow(kl, movements, balByKey, cseQty, heldOf(kl), vanQtyByLine.get(kl.id) ?? 0));
    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobName: job.name,
      customerId: job.customerId,
      customerName: job.customerName,
      assignedEngineerId: job.assignedEngineerId,
      // Prefer the assign-time snapshot; fall back to the live engineer relation so the queue still
      // shows a name for jobs assigned before the snapshot was populated.
      engineerName:
        job.assignedEngineerName ??
        (job.assignedEngineer ? `${job.assignedEngineer.firstName} ${job.assignedEngineer.lastName}`.trim() : null),
      status: job.status,
      goodsStatus: goodsStatusOf(job.id),
      kitLines,
    };
  });

  return { rows, total, page, pageSize, totalPages };
}

export async function getJobGoods(jobId: string, actor?: AuditActor): Promise<JobGoodsDetail> {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");

  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const summary = await goodsManagementRepo.getSummary(job.id);

  // Enforce per-line warehouse access before any enrichment.
  for (const kl of job.kitLines ?? []) {
    if (kl.warehouseId) assertWarehouseAccess(actor, kl.warehouseId);
  }

  // Enrich in batched queries (was an N+1 of ~3 round-trips per kit line) — same approach as listQueue.
  const irmItemIds = new Set<string>();
  const whIds = new Set<string>();
  const cseIds = new Set<string>();
  for (const kl of job.kitLines ?? []) {
    if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
      irmItemIds.add(kl.irmItemId);
      whIds.add(kl.warehouseId);
    } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
      cseIds.add(kl.customerStockEntryId);
    }
  }
  const balByKey = new Map(
    (await inventoryRepo.findBalancesByItemsAndWarehouses([...irmItemIds], [...whIds])).map((b) => [`${b.irmItemId}|${b.warehouseId}`, b]),
  );
  const cseQty = new Map((await goodsManagementRepo.findCustomerStockEntriesByIds([...cseIds])).map((e) => [e.id, e.quantity]));
  // Engineer's REAL holding per item (global per item) — batched once for the job's single engineer.
  const engHeld = new Map<string, number>();
  if (job.assignedEngineerId) {
    for (const b of await engineerStockRepo.findEngineerBalances(job.assignedEngineerId)) engHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(job.assignedEngineerId)) engHeld.set(h.customerStockEntryId, h.quantityOnHand);
  }

  const heldOf = (kl: { irmItemId: string | null; customerStockEntryId: string | null }) => {
    if (!job.assignedEngineerId) return 0;
    const itemId = kl.irmItemId ?? kl.customerStockEntryId;
    return itemId ? engHeld.get(itemId) ?? 0 : 0;
  };
  const vanQtyByLine = await completedVanQtyByKitLine((job.kitLines ?? []).map((k) => k.id));
  const lines: QueueKitLine[] = (job.kitLines ?? []).map((kl) => buildKitLineRow(kl, movements, balByKey, cseQty, heldOf(kl), vanQtyByLine.get(kl.id) ?? 0));

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

// ── Return flow: scan-in engineer → warehouse (good) or damaged pool (damaged) ──────────────
export async function postReturn(jobId: string, input: PostMovementInput, actor?: AuditActor): Promise<PublicMovement> {
  if (input.direction !== "return") throw badRequest("Wrong direction for return.");
  const job = await loadJobOrThrow(jobId);
  if (!["accepted", "in_progress", "completed"].includes(job.status)) {
    throw conflict("Stock can only be returned for an accepted/in-progress/completed job.");
  }
  const returnSummary = await goodsManagementRepo.getSummary(job.id);
  if (returnSummary?.goodsStatus === "reconciled") throw conflict("This job has already been reconciled and is locked.");
  const actorEmail = actor?.email ?? null;

  // Fetched at most ONCE per call and shared by the van-source check below and the outstanding-qty
  // budget further down (which already needed them) — so allowing van returns costs no extra query.
  let movementsCache: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>> | null = null;
  const loadMovements = async () => (movementsCache ??= await goodsManagementRepo.findMovementsByJob(job.id));

  // Resolve line details + warehouse for the movement header (derived from kit lines).
  // For returns we derive item names + warehouse from the kit list (already on the job), not by
  // re-fetching the IRM item or CSE — this keeps the pre-validation fast and test-friendly.
  type Resolved = {
    line: (typeof input.lines)[number];
    itemName: string;
    uom: string | null;
    sku: string | null;
    warehouseId: string;
    warehouseName: string | null;
    warehouseCode: string | null;
    customerId: string | null;
    condition: "good" | "damaged";
    awayReturn?: boolean; // van portion returned away from the kit line's home warehouse
    kitHomeWarehouseId?: string | null; // the kit line's own home (sizes the away-from-home budget)
  };
  const resolved: Resolved[] = [];

  for (const line of input.lines) {
    const condition = (line.condition ?? "good") as "good" | "damaged";
    if (line.source === "irm") {
      if (!line.irmItemId) throw badRequest("IRM return line is missing irmItemId.");
      // Match the kit line for this item AT THIS warehouse (an item may be listed at several).
      let kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === line.irmItemId && k.warehouseId === input.warehouseId);
      // Mirror scanLookup: the VAN portion of a line owes no warehouse, so it can be scanned back in
      // anywhere. Must be enforced HERE too — scanLookup only feeds the UI, and this is the call that
      // actually moves stock. `awayReturn` flags it so the per-warehouse budget below caps at the van
      // portion (not the whole line) and the movement is credited to the receiving warehouse.
      const awayReturn = !kit;
      // The per-line van cap below is keyed by jobKitLineId. Without it an away return skips the cap
      // entirely (bounded only by physical holding), so it could over-credit the receiving warehouse
      // while leaving the line's home warehouse permanently short. scanLookup always supplies the line
      // id, so require it here rather than letting the capacity-based fallback size an uncapped return.
      if (awayReturn && !line.jobKitLineId) throw badRequest("An away-from-home return must reference its kit line.");
      if (!kit) {
        // Resolve the EXACT kit line the client scanned (its id came from scanLookup), NOT a fresh
        // capacity-based re-pick. When the same item is homed at two warehouses, re-picking could land
        // on the other line if caps shifted between scan and post, then size THIS return's budget with
        // that line's home — miscounting home-vs-away returns and wrongly rejecting. The scanned line
        // keeps scan and post consistent. Falls back to the capacity pick only if no line id was sent.
        kit = line.jobKitLineId
          ? (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.id === line.jobKitLineId && k.irmItemId === line.irmItemId && !!k.warehouseId && k.warehouseId !== input.warehouseId)
          : undefined;
        if (!kit) {
          const away = await findAwayReturnKitLine(
            (job.kitLines ?? []).filter((k) => k.lineType === "irm" && k.irmItemId === line.irmItemId),
            await loadMovements(),
          );
          kit = away?.kit;
        }
      }
      if (!kit?.warehouseId) throw badRequest("Cannot determine warehouse for this IRM return line.");
      assertWarehouseAccess(actor, input.warehouseId);
      resolved.push({
        line, itemName: kit.itemName, uom: null, sku: null,
        // Credit the warehouse that physically received it — for a van return that's the scanning
        // warehouse, not the line's nominal home (which never held this stock).
        warehouseId: awayReturn ? input.warehouseId : kit.warehouseId,
        warehouseName: awayReturn ? null : kit.warehouseName ?? null,
        warehouseCode: awayReturn ? null : kit.warehouseCode ?? null,
        customerId: null, condition,
        awayReturn,
        // The resolved line's own home — sizes the away-from-home budget (counts returns made at any
        // warehouse other than this). Same as input.warehouseId for a home return.
        kitHomeWarehouseId: kit.warehouseId,
      });
    } else {
      if (!line.customerStockEntryId) throw badRequest("Customer return line is missing customerStockEntryId.");
      // Derive warehouse + item name from the kit line (at THIS warehouse). Fall back to CSE fetch.
      const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === line.customerStockEntryId && k.warehouseId === input.warehouseId);
      if (kit?.warehouseId) {
        assertWarehouseAccess(actor, input.warehouseId);
        resolved.push({
          line, itemName: kit.itemName, uom: null, sku: null, warehouseId: kit.warehouseId,
          warehouseName: kit.warehouseName ?? null, warehouseCode: kit.warehouseCode ?? null,
          customerId: null, condition,
        });
      } else {
        // Kit line absent or has no warehouseId — fall back to live CSE lookup.
        const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId);
        if (!entry) throw badRequest("Customer stock item not found.");
        if (!entry.warehouseId) throw badRequest("Cannot determine warehouse for this customer return line.");
        assertWarehouseAccess(actor, entry.warehouseId);
        resolved.push({
          line, itemName: entry.itemName, uom: entry.uom ?? null, sku: null, warehouseId: entry.warehouseId,
          warehouseName: null, warehouseCode: null,
          customerId: entry.customerId ?? null, condition,
        });
      }
    }
  }

  // Every return line must belong to THIS warehouse — can't receive another warehouse's items here.
  for (const r of resolved) {
    if (r.warehouseId !== input.warehouseId) {
      throw badRequest(`${r.itemName} isn't stocked at this warehouse and can't be received here.`);
    }
  }

  const warehouseId = resolved[0].warehouseId;
  // Van-sourced lines carry no warehouse snapshot (their kit line is homed elsewhere, and naming
  // THAT warehouse on a movement received here would be wrong). Every resolved line is guaranteed to
  // be at input.warehouseId by the check above, so resolve the receiving warehouse's own labels once
  // rather than persisting nulls — the snapshot is what keeps history readable after a rename.
  let warehouseName = resolved[0].warehouseName;
  let warehouseCode = resolved[0].warehouseCode;
  if (warehouseName === null) {
    const wh = await warehouseRepo.findById(warehouseId);
    warehouseName = wh?.name ?? null;
    warehouseCode = wh?.code ?? null;
  }
  const engineerName = job.assignedEngineerName ?? "";
  const engineerEmail = job.assignedEngineerEmail ?? null;

  const movementLines: goodsManagementRepo.MovementLineRow[] = resolved.map((r) => ({
    source: r.line.source,
    irmItemId: r.line.source === "irm" ? (r.line.irmItemId ?? null) : null,
    customerStockEntryId: r.line.source === "customer" ? (r.line.customerStockEntryId ?? null) : null,
    itemName: r.itemName,
    sku: r.sku,
    uom: r.uom,
    qty: r.line.qty,
    condition: r.condition,
    jobKitLineId: r.line.jobKitLineId ?? null,
    scannedCode: r.line.scannedCode ?? null,
    damagePhotoUrl: r.condition === "damaged" ? (r.line.damagePhotoUrl ?? null) : null,
    damageReason: r.condition === "damaged" ? (r.line.damageReason ?? null) : null,
    notes: r.line.notes ?? null,
  }));

  // Per-warehouse return cap: at the line's HOME warehouse it can return only what's still out from
  // its kit line (issued − used − returned), so a multi-warehouse holding can't be fully returned at
  // one warehouse (over-crediting it + shorting the other). AWAY from home, only the van portion may
  // land (vanReturnableAwayFromHome). Computed from current movements; a running budget handles
  // multiple lines (e.g. good + damaged split) against the same kit line in one request.
  const returnMovements = await loadMovements();
  const awayVanQty = await completedVanQtyByKitLine(
    resolved.filter((r) => r.awayReturn && r.line.jobKitLineId).map((r) => r.line.jobKitLineId!),
  );
  const outstandingByLine = new Map<string, number>();
  for (const r of resolved) {
    const klId = r.line.jobKitLineId;
    if (!klId || outstandingByLine.has(klId)) continue;
    if (r.awayReturn) {
      outstandingByLine.set(klId, vanReturnableAwayFromHome(returnMovements, klId, r.kitHomeWarehouseId ?? null, awayVanQty.get(klId) ?? 0));
    } else {
      const s = kitLineSplit(returnMovements, klId);
      outstandingByLine.set(klId, Math.max(0, s.issued - s.used - s.returned));
    }
  }

  const created = await goodsManagementRepo.createMovementWithCode(
    {
      jobId: job.id,
      direction: "return",
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
    movementLines,
    async (tx, movementId, code) => {
      for (const r of resolved) {
        const { line, condition, warehouseId: wh } = r;
        const qty = line.qty;

        // Per-warehouse cap: can't return more than the kit line still has out here — the whole line
        // at its home warehouse, or just the van portion away from home.
        if (line.jobKitLineId) {
          const remaining = outstandingByLine.get(line.jobKitLineId) ?? 0;
          if (qty > remaining) {
            throw conflict(r.awayReturn
              ? `Only ${remaining} of ${r.itemName} came from a van and can be returned away from its home warehouse — the rest must go back there.`
              : `Only ${remaining} of ${r.itemName} can be returned at this warehouse — that's all that's still out from here.`);
          }
          outstandingByLine.set(line.jobKitLineId, remaining - qty);
        }

        if (line.source === "irm") {
          const irmItemId = line.irmItemId!;
          // Pre-check: engineer must hold at least qty.
          const held = await engineerStockRepo.findEngineerBalanceTx(tx, irmItemId, job.assignedEngineerId!);
          if (!held || held.quantityOnHand < qty) {
            throw conflict(`Engineer doesn't hold ${qty} of this IRM item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the engineer holding.
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, irmItemId, job.assignedEngineerId!, -qty);
          // Ledger row with type "job_return".
          await engineerStockRepo.insertEngineerTxnTx(tx, {
            irmItemId,
            engineerId: job.assignedEngineerId!,
            quantityDelta: -qty,
            type: "job_return",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });

          if (condition === "good") {
            // Credit the warehouse back via applyInbound.
            await inventoryService.applyInbound(tx, {
              irmItemId,
              warehouseId: wh,
              quantity: qty,
              sourceType: "goods_management",
              sourceId: movementId,
              sourceCode: code,
              createdBy: actorEmail,
            });
          } else {
            // Damaged: credit the damaged pool.
            const damageKey: goodsManagementRepo.DamagedKey = {
              warehouseId: wh,
              ownerType: "company",
              irmItemId,
              customerStockEntryId: null,
              customerId: null,
              itemName: r.itemName,
            };
            const dmgBal = await goodsManagementRepo.upsertDamagedBalanceTx(tx, damageKey, qty);
            await goodsManagementRepo.insertDamagedTxnTx(tx, {
              warehouseId: wh,
              ownerType: "company",
              irmItemId,
              customerStockEntryId: null,
              customerId: null,
              quantityDelta: qty,
              reason: line.damageReason ?? "Damaged on return",
              notes: line.notes ?? null,
              photoUrl: line.damagePhotoUrl ?? null,
              sourceType: "goods_management_return",
              sourceId: movementId,
              sourceCode: code,
              balanceAfter: dmgBal.quantity,
              createdBy: actorEmail,
            });
          }
        } else {
          const customerStockEntryId = line.customerStockEntryId!;
          // Pre-check: engineer must hold at least qty.
          const held = await goodsManagementRepo.findCustomerHoldingTx(tx, customerStockEntryId, job.assignedEngineerId!);
          if (!held || held.quantityOnHand < qty) {
            throw conflict(`Engineer doesn't hold ${qty} of this customer item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the customer holding.
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, customerStockEntryId, job.assignedEngineerId!, -qty, {
            customerId: held.customerId,
            itemName: held.itemName,
          });
          // Ledger row.
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId,
            engineerId: job.assignedEngineerId!,
            quantityDelta: -qty,
            type: "job_return",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });

          if (condition === "good") {
            // Credit the customer stock pool back.
            await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, customerStockEntryId, qty);
          } else {
            // Damaged: credit the damaged pool (customer-owned). No pool credit for the customer entry.
            // Use customerId from the live holding (snapshot on the balance row).
            const effectiveCustomerId = held.customerId ?? r.customerId;
            const damageKey: goodsManagementRepo.DamagedKey = {
              warehouseId: wh,
              ownerType: "customer",
              irmItemId: null,
              customerStockEntryId,
              customerId: effectiveCustomerId,
              itemName: held.itemName,
            };
            const dmgBal = await goodsManagementRepo.upsertDamagedBalanceTx(tx, damageKey, qty);
            await goodsManagementRepo.insertDamagedTxnTx(tx, {
              warehouseId: wh,
              ownerType: "customer",
              irmItemId: null,
              customerStockEntryId,
              customerId: effectiveCustomerId,
              quantityDelta: qty,
              reason: line.damageReason ?? "Damaged on return",
              notes: line.notes ?? null,
              photoUrl: line.damagePhotoUrl ?? null,
              sourceType: "goods_management_return",
              sourceId: movementId,
              sourceCode: code,
              balanceAfter: dmgBal.quantity,
              createdBy: actorEmail,
            });
          }
        }
      }
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "awaiting_return" });
    },
  );

  audit.record({ actor, action: "goods_management.return_posted", targetType: "job", targetId: job.id, targetLabel: created.code });

  // Realtime: notify the engineer + all office staff.
  const returnPayload = { jobId: job.id, movementId: created.id, code: created.code, direction: "return" };
  emitToUser(job.assignedEngineerId!, "goods:returned", returnPayload);
  emitToRoom(OFFICE_JOBS_ROOM, "goods:updated", returnPayload);

  return toPublic(created);
}

// ── Consume movement (engineer Complete) ─────────────────────────────────────────────────────
// Called from job.service.completeJobForEngineer. Takes the already-loaded job to avoid a circular
// import (goods-management.service → job.repository; job.service → goods-management.service).
// Opens a single transaction that:
//   1. For each used line, drains the engineer holding (IRM via engineerStockRepo, customer via gmRepo).
//   2. Appends ledger rows with type "job_consume".
//   3. Creates a "consume" JobStockMovement (warehouseId null).
//   4. Stamps the job "completed" via jobRepository.completeIfInProgressTx.
//   5. Upserts the summary with goodsStatus "awaiting_return" + workSummary.
export interface ConsumeUsedLine {
  source: "irm" | "customer";
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string; // the exact kit line used — disambiguates an item issued from >1 warehouse
  qty: number;
}

// Match an engineer-declared "used" line to the EXACT kit line it came from: by declared kit-line id
// (precise when an item was issued from more than one warehouse), else by item id for older clients
// without jobKitLineId. The declared item MUST be on this job's kit list — otherwise we'd drain the
// engineer's (global) holding for an unrelated item with no traceable attribution. An unmatched line
// (off-job item, or a stale/edited jobKitLineId) is rejected, never silently orphaned.
function resolveUsedKitLine(job: JobWithRelations, used: ConsumeUsedLine): JobWithRelations["kitLines"][number] {
  const kitLine = job.kitLines.find((kl) =>
    used.jobKitLineId
      ? kl.id === used.jobKitLineId
      : used.source === "irm"
        ? kl.lineType === "irm" && kl.irmItemId === used.irmItemId
        : kl.lineType === "customer_stock" && kl.customerStockEntryId === used.customerStockEntryId,
  );
  if (!kitLine) throw badRequest("A declared 'used' item isn't on this job's kit list (or its line was edited) — refresh the job and try again.");
  return kitLine;
}

export async function recordConsumeAndComplete(
  job: JobWithRelations,
  engineerId: string,
  workSummary: string | null,
  usedLines: ConsumeUsedLine[],
  actorEmail: string | null,
): Promise<void> {
  const jobId = job.id;

  // Pre-build movement lines (item names from kit list snapshots); balances are re-checked inside tx.
  const movementLines: goodsManagementRepo.MovementLineRow[] = usedLines
    .filter((u) => u.qty > 0)
    .map((used) => {
      const kitLine = resolveUsedKitLine(job, used);
      return {
        source: used.source === "irm" ? "irm" : "customer",
        irmItemId: used.source === "irm" ? used.irmItemId ?? null : null,
        customerStockEntryId: used.source === "irm" ? null : used.customerStockEntryId ?? null,
        itemName: kitLine.itemName,
        sku: null,
        uom: null,
        qty: used.qty,
        condition: "good",
        jobKitLineId: kitLine.id,
        scannedCode: null,
        damagePhotoUrl: null,
        damageReason: null,
        notes: null,
      };
    });

  // Decide the goods status AFTER this consume: if the engineer is left holding NOTHING for the job
  // (used everything — nothing to return), auto-reconcile instead of parking it in "awaiting_return"
  // and forcing a manual Close & Reconcile. Outstanding per line = issued − used (prior + this) −
  // returned; if every line nets to 0, there's nothing to hand back.
  const priorMovements = await goodsManagementRepo.findMovementsByJob(jobId);
  const newUsedByLine = new Map<string, number>();
  for (const m of movementLines) if (m.jobKitLineId) newUsedByLine.set(m.jobKitLineId, (newUsedByLine.get(m.jobKitLineId) ?? 0) + m.qty);
  let totalOutstanding = 0;
  for (const kl of job.kitLines) {
    if (kl.lineType === "misc") continue; // misc isn't stock-tracked
    const s = kitLineSplit(priorMovements, kl.id);
    totalOutstanding += Math.max(0, s.issued - s.used - s.returned - (newUsedByLine.get(kl.id) ?? 0));
  }
  const finalGoodsStatus = totalOutstanding > 0 ? "awaiting_return" : "reconciled";

  // Use the GM code allocator so consume movements get proper GM-#### codes.
  await goodsManagementRepo.createMovementWithCode(
    {
      jobId,
      direction: "consume",
      engineerId,
      engineerName: job.assignedEngineerName ?? "",
      engineerEmail: job.assignedEngineerEmail ?? null,
      warehouseId: null,  // consume is engineer-declared; no warehouse
      warehouseName: null,
      warehouseCode: null,
      status: "posted",
      postedAt: new Date(),
      performedBy: actorEmail,
      createdBy: actorEmail,
    },
    movementLines,
    async (tx, movementId, code) => {
      // Inside the same transaction: drain holdings + ledger + stamp job + summary.
      for (const used of usedLines) {
        if (used.qty <= 0) continue;

        if (used.source === "irm") {
          if (!used.irmItemId) throw badRequest("IRM used line missing irmItemId.");
          // Pre-check: engineer must hold at least this qty.
          const held = await engineerStockRepo.findEngineerBalanceTx(tx, used.irmItemId, engineerId);
          if (!held || held.quantityOnHand < used.qty) {
            throw conflict(`Engineer doesn't hold ${used.qty} of this IRM item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the engineer holding.
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, used.irmItemId, engineerId, -used.qty);
          // Append ledger row.
          await engineerStockRepo.insertEngineerTxnTx(tx, {
            irmItemId: used.irmItemId,
            engineerId,
            quantityDelta: -used.qty,
            type: "job_consume",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });
        } else {
          if (!used.customerStockEntryId) throw badRequest("Customer used line missing customerStockEntryId.");
          // Pre-check: engineer must hold at least this qty.
          const held = await goodsManagementRepo.findCustomerHoldingTx(tx, used.customerStockEntryId, engineerId);
          if (!held || held.quantityOnHand < used.qty) {
            throw conflict(`Engineer doesn't hold ${used.qty} of this customer item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the customer holding.
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, used.customerStockEntryId, engineerId, -used.qty, {
            customerId: held.customerId,
            itemName: held.itemName,
          });
          // Append ledger row.
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId: used.customerStockEntryId,
            engineerId,
            quantityDelta: -used.qty,
            type: "job_consume",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });
        }
      }

      // Stamp job completed (atomic guard).
      const stamped = await jobRepo.completeIfInProgressTx(tx, jobId, engineerId);
      if (stamped.count !== 1) {
        throw conflict("Job can't be completed right now. Refresh and try again.");
      }

      // Upsert the summary (auto-reconciled when nothing's left to return — see above).
      await goodsManagementRepo.upsertSummaryTx(tx, jobId, {
        goodsStatus: finalGoodsStatus,
        workSummary: workSummary ?? null,
      });
    },
  );
}

// ── Damaged stock read ────────────────────────────────────────────────────────────────────────
// Exposes NO cost/value — only item/qty/serial/location/flag.
export interface DamagedRow {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  ownerType: string; // "company" | "customer"
  irmItemId: string | null;
  customerStockEntryId: string | null;
  customerId: string | null;
  itemName: string;
  quantity: number;
  updatedAt: string; // ISO date from DamagedStockBalance.updatedAt
  reason: string | null; // from latest DamagedStockTransaction
  photoUrl: string | null; // from latest DamagedStockTransaction
}

export async function listDamaged(
  filter: { warehouseId?: string; customerId?: string },
  actor?: AuditActor,
): Promise<DamagedRow[]> {
  const scopeIds = warehouseScopeFilter(actor);

  // Step 1: collect raw balance rows (now includes warehouse relation).
  type RawBalance = Awaited<ReturnType<typeof goodsManagementRepo.findDamagedByWarehouse>>[number];
  let rawBalances: RawBalance[] = [];

  if (filter.customerId) {
    const raw = await goodsManagementRepo.findDamagedByCustomer(filter.customerId);
    rawBalances = raw.filter((r) => scopeIds === undefined || scopeIds.includes(r.warehouseId));
  } else if (filter.warehouseId) {
    assertWarehouseAccess(actor, filter.warehouseId);
    rawBalances = await goodsManagementRepo.findDamagedByWarehouse(filter.warehouseId);
  } else {
    // No filter: return all warehouses the actor can access.
    const allWarehouseIds = scopeIds;
    if (allWarehouseIds !== undefined) {
      // Scoped: fetch per warehouse then merge.
      for (const whId of allWarehouseIds) {
        const raw = await goodsManagementRepo.findDamagedByWarehouse(whId);
        rawBalances.push(...raw);
      }
    } else {
      // Global actor: use repo's findAll-style query (no filter).
      rawBalances = await goodsManagementRepo.findAllDamaged();
    }
  }

  // Step 2: batch-fetch the latest transaction for each balance (reason + photoUrl).
  const latestTxnMap = await goodsManagementRepo.findLatestDamagedTxnsByBalances(rawBalances);

  // Step 3: assemble final rows.
  const rows: DamagedRow[] = rawBalances.map((r) => {
    const txn = latestTxnMap.get(r.id);
    return {
      id: r.id,
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse?.name ?? null,
      ownerType: r.ownerType,
      irmItemId: r.irmItemId,
      customerStockEntryId: r.customerStockEntryId,
      customerId: r.customerId,
      itemName: r.itemName,
      quantity: r.quantity,
      updatedAt: r.updatedAt.toISOString(),
      reason: txn?.reason ?? null,
      photoUrl: txn?.photoUrl ?? null,
    };
  });

  return rows;
}

// ── Overdue holdings ──────────────────────────────────────────────────────────────────────────
// Issue movements older than `days` whose job's engineer still holds stock
// (goodsStatus !== "reconciled").
export interface OverdueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  engineerId: string;
  engineerName: string;
  warehouseId: string | null;
  issuedAt: Date;
  goodsStatus: string;
  lines: { source: string; irmItemId: string | null; customerStockEntryId: string | null; itemName: string; qty: number }[];
}

export async function listOverdue(actor?: AuditActor, days = 14): Promise<OverdueRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const movements = await goodsManagementRepo.findRecentMovementsForOverdue(cutoff);

  // Group by job, filter to jobs not yet reconciled.
  const seenJobIds = new Set<string>();
  const rows: OverdueRow[] = [];

  for (const m of movements) {
    if (seenJobIds.has(m.jobId)) continue;

    // Check warehouse scope access.
    if (m.warehouseId) {
      try {
        assertWarehouseAccess(actor, m.warehouseId);
      } catch {
        continue; // skip movements the actor can't access
      }
    }

    const summary = await goodsManagementRepo.getSummary(m.jobId);
    if (summary?.goodsStatus === "reconciled") continue;

    seenJobIds.add(m.jobId);

    rows.push({
      jobId: m.jobId,
      jobNumber: m.job?.jobNumber ?? m.jobId,
      jobName: m.job?.name ?? "",
      engineerId: m.engineerId,
      engineerName: m.engineerName,
      warehouseId: m.warehouseId,
      issuedAt: m.createdAt,
      goodsStatus: summary?.goodsStatus ?? "issued",
      lines: m.items.map((l) => ({
        source: l.source,
        irmItemId: l.irmItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        qty: l.qty,
      })),
    });
  }

  return rows;
}

// ── Close & reconcile ─────────────────────────────────────────────────────────────────────────
// Computes per-item tally: issued − consumed − returnedGood − returnedDamaged.
// If all zero → goodsStatus = "reconciled" (locked).
// If any positive and writeOffLost → drain remaining engineer holding with type "job_lost" + reconcile.
// If any positive and no writeOffLost → return the unaccounted list and leave open.

interface UnaccountedItem {
  itemName: string;
  qty: number;
  source: "irm" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  customerId: string | null;
}

type TallyEntry = { jobKitLineId: string; itemName: string; source: "irm" | "customer"; irmItemId: string | null; customerStockEntryId: string | null; warehouseId: string | null; issued: number; consumed: number; returnedGood: number; returnedDamaged: number };

// Tally goods for reconciliation, keyed by the job's CURRENT, stock-tracked kit lines (jobKitLineId).
// Keying by kit line — not by item id — keeps this consistent with the held / queue / job-pack views
// and ignores movements left over from kit lines that were later edited or removed (whose ids no
// longer match), which would otherwise double-count an item. Misc lines are free-text (not
// stock-tracked) and can never be returned, so they're excluded from reconciliation entirely.
function computeTallies(
  movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>,
  kitLines?: NonNullable<JobWithRelations["kitLines"]>,
): Map<string, TallyEntry> {
  const tallies = new Map<string, TallyEntry>();
  for (const kl of kitLines ?? []) {
    if (kl.lineType === "misc") continue; // misc is not stock-tracked → never reconciled
    tallies.set(kl.id, {
      jobKitLineId: kl.id,
      itemName: kl.itemName,
      source: kl.irmItemId ? "irm" : "customer",
      irmItemId: kl.irmItemId ?? null,
      customerStockEntryId: kl.customerStockEntryId ?? null,
      warehouseId: kl.warehouseId ?? null,
      issued: 0,
      consumed: 0,
      returnedGood: 0,
      returnedDamaged: 0,
    });
  }

  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      const t = tallies.get(l.jobKitLineId);
      if (!t) continue; // orphaned (kit line edited/removed) or misc — not part of this job's reconcile
      if (m.direction === "issue") t.issued += l.qty;
      else if (m.direction === "consume") t.consumed += l.qty; // includes "lost" write-offs
      else if (m.direction === "return") {
        if (l.condition === "damaged") t.returnedDamaged += l.qty;
        else t.returnedGood += l.qty;
      }
    }
  }

  return tallies;
}

export async function closeReconcile(
  jobId: string,
  input: CloseReconcileInput,
  actor?: AuditActor,
): Promise<{ summary: { goodsStatus: string; workSummary: string | null; lastMovementAt: Date | null }; unaccounted: { itemName: string; qty: number }[] }> {
  const job = await loadJobOrThrow(jobId);
  const existingSummary = await goodsManagementRepo.getSummary(job.id);

  if (existingSummary?.goodsStatus === "reconciled") {
    throw conflict("This job is already reconciled and locked.");
  }

  // Guard: reconcile ONLY once the engineer has completed the job (goodsStatus "awaiting_return").
  // Before that the stock is still in use on site — reconciling would write off live stock as "lost"
  // and lock the job. Issued / partially_issued jobs must wait for the engineer to declare usage.
  if (existingSummary?.goodsStatus !== "awaiting_return") {
    throw conflict("This job can only be reconciled after the engineer completes it and declares what was used.");
  }

  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const tallies = computeTallies(movements, job.kitLines ?? []);

  // "Unaccounted" must reflect what the engineer ACTUALLY still holds — not raw per-line issued −
  // returned. Stock returned at a different warehouse, or (for a customer-stock entry shared across
  // jobs) handed back under another job, is genuinely accounted even though THIS job's per-line
  // movements don't record the return. So cap each item's unaccounted at the engineer's real held
  // balance (the same source the scan/queue use), distributed across the item's kit lines. Without
  // this, reconcile shows phantom shortfalls and the only escapes are a wrong "write off as lost" or
  // leaving the job stuck open.
  const engId = job.assignedEngineerId;
  const irmHeld = new Map<string, number>();
  const cseHeld = new Map<string, number>();
  if (engId) {
    for (const b of await engineerStockRepo.findEngineerBalances(engId)) irmHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(engId)) cseHeld.set(h.customerStockEntryId, h.quantityOnHand);
  }

  // Group the tallies by item (the engineer holding is global per item, not per kit line) and spread
  // each item's real held across its lines, capped at each line's raw remaining.
  const talliesByItem = new Map<string, TallyEntry[]>();
  for (const t of tallies.values()) {
    const key = t.source === "irm" ? `irm:${t.irmItemId}` : `cse:${t.customerStockEntryId}`;
    const g = talliesByItem.get(key);
    if (g) g.push(t);
    else talliesByItem.set(key, [t]);
  }

  const unaccountedItems: UnaccountedItem[] = [];
  for (const group of talliesByItem.values()) {
    let remainingHeld = group[0].source === "irm" ? irmHeld.get(group[0].irmItemId!) ?? 0 : cseHeld.get(group[0].customerStockEntryId!) ?? 0;
    for (const t of group) {
      const rawRemaining = Math.max(0, t.issued - t.consumed - t.returnedGood - t.returnedDamaged);
      const qty = Math.min(rawRemaining, remainingHeld); // never more than the engineer truly holds
      remainingHeld -= qty;
      if (qty > 0) {
        unaccountedItems.push({
          itemName: t.itemName,
          qty,
          source: t.source,
          irmItemId: t.irmItemId,
          customerStockEntryId: t.customerStockEntryId,
          warehouseId: t.warehouseId,
          customerId: null,
        });
      }
    }
  }

  const actorEmail = actor?.email ?? null;

  if (unaccountedItems.length > 0 && !input.writeOffLost) {
    // Return unaccounted list, do not reconcile.
    return {
      summary: existingSummary
        ? { goodsStatus: existingSummary.goodsStatus, workSummary: existingSummary.workSummary, lastMovementAt: existingSummary.lastMovementAt }
        : { goodsStatus: "awaiting_return", workSummary: null, lastMovementAt: null },
      unaccounted: unaccountedItems.map((u) => ({ itemName: u.itemName, qty: u.qty })),
    };
  }

  // Either balanced (no unaccounted) or writeOffLost = true.
  // Build lost movement lines for unaccounted items.
  // condition: "lost" distinguishes these write-off consume lines from normal consumes in the audit ledger.
  const lostLines: goodsManagementRepo.MovementLineRow[] = unaccountedItems.map((u) => ({
    source: u.source,
    irmItemId: u.irmItemId,
    customerStockEntryId: u.customerStockEntryId,
    itemName: u.itemName,
    sku: null,
    uom: null,
    qty: u.qty,
    condition: "lost",
    jobKitLineId: null,
    scannedCode: null,
    damagePhotoUrl: null,
    damageReason: "written off as lost",
    notes: null,
  }));

  if (lostLines.length > 0) {
    // Write the lost movement + drain holdings + upsert summary in one transaction.
    await goodsManagementRepo.createMovementWithCode(
      {
        jobId: job.id,
        direction: "consume",
        engineerId: job.assignedEngineerId!,
        engineerName: job.assignedEngineerName ?? "",
        engineerEmail: job.assignedEngineerEmail ?? null,
        warehouseId: null,
        warehouseName: null,
        warehouseCode: null,
        status: "posted",
        postedAt: new Date(),
        performedBy: actorEmail,
        createdBy: actorEmail,
      },
      lostLines,
      async (tx, movementId, code) => {
        for (const u of unaccountedItems) {
          if (u.source === "irm") {
            const held = await engineerStockRepo.findEngineerBalanceTx(tx, u.irmItemId!, job.assignedEngineerId!);
            const heldQty = held?.quantityOnHand ?? 0;
            // Drain however much is actually held (may be less than unaccounted if already written off).
            if (heldQty > 0) {
              const drainQty = Math.min(u.qty, heldQty);
              const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, u.irmItemId!, job.assignedEngineerId!, -drainQty);
              await engineerStockRepo.insertEngineerTxnTx(tx, {
                irmItemId: u.irmItemId!,
                engineerId: job.assignedEngineerId!,
                quantityDelta: -drainQty,
                type: "job_lost",
                sourceType: "goods_management",
                sourceId: movementId,
                sourceCode: code,
                balanceAfter: eng.quantityOnHand,
                createdBy: actorEmail,
              });
            }
          } else {
            const held = await goodsManagementRepo.findCustomerHoldingTx(tx, u.customerStockEntryId!, job.assignedEngineerId!);
            const heldQty = held?.quantityOnHand ?? 0;
            if (heldQty > 0) {
              const drainQty = Math.min(u.qty, heldQty);
              const hold = await goodsManagementRepo.upsertCustomerHoldingTx(
                tx,
                u.customerStockEntryId!,
                job.assignedEngineerId!,
                -drainQty,
                { customerId: held!.customerId, itemName: held!.itemName },
              );
              await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
                customerStockEntryId: u.customerStockEntryId!,
                engineerId: job.assignedEngineerId!,
                quantityDelta: -drainQty,
                type: "job_lost",
                sourceType: "goods_management",
                sourceId: movementId,
                sourceCode: code,
                balanceAfter: hold.quantityOnHand,
                createdBy: actorEmail,
              });
            }
          }
        }
        await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "reconciled" });
      },
    );
  } else {
    // Balanced (no unaccounted) — just update the summary.
    await withTransaction(async (tx) => {
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "reconciled" });
    });
  }

  audit.record({ actor, action: "goods_management.reconciled", targetType: "job", targetId: job.id, targetLabel: job.jobNumber ?? job.id });

  // Realtime: notify the engineer + all office staff.
  const reconcilePayload = { jobId: job.id, direction: "reconcile" };
  emitToUser(job.assignedEngineerId!, "goods:returned", reconcilePayload);
  emitToRoom(OFFICE_JOBS_ROOM, "goods:updated", reconcilePayload);

  const updatedSummary = await goodsManagementRepo.getSummary(job.id);
  return {
    summary: updatedSummary
      ? { goodsStatus: updatedSummary.goodsStatus, workSummary: updatedSummary.workSummary, lastMovementAt: updatedSummary.lastMovementAt }
      : { goodsStatus: "reconciled", workSummary: null, lastMovementAt: null },
    unaccounted: [],
  };
}

// ── Damaged Restore (reverse a write-off) ────────────────────────────────────────────────────
// Decrements the DamagedStockBalance, appends a reversal DamagedStockTransaction, and credits
// the units back to usable stock — company → InventoryBalance + InventoryTransaction;
// customer → CustomerStockEntry.quantity. All in one atomic transaction.
export interface RestoreDamagedResult {
  warehouseId: string;
  ownerType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  quantityRestored: number;
  damagedBalanceAfter: number;
  usableBalanceAfter: number;
}

export async function restoreDamaged(input: RestoreDamagedInput, actor?: AuditActor): Promise<RestoreDamagedResult> {
  const actorEmail = actor?.email ?? null;
  const irmItemId = input.irmItemId ?? null;
  const customerStockEntryId = input.customerStockEntryId ?? null;

  // Load the damaged balance by natural key.
  const balance = await goodsManagementRepo.findDamagedBalance({
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId,
    customerStockEntryId,
  });
  if (!balance) throw notFound("Damaged stock balance not found for the given item and warehouse.");
  if (balance.quantity <= 0) throw conflict("No damaged units remain to restore.");
  if (input.quantity > balance.quantity) {
    throw conflict(`Only ${balance.quantity} damaged unit(s) available — cannot restore ${input.quantity}.`);
  }

  let damagedBalanceAfter = 0;
  let usableBalanceAfter = 0;

  await withTransaction(async (tx) => {
    // 1. Decrement damaged balance + append reversal ledger row.
    damagedBalanceAfter = await goodsManagementRepo.decrementDamagedBalanceTx(tx, balance.id, input.quantity, {
      warehouseId: input.warehouseId,
      ownerType: input.ownerType,
      irmItemId,
      customerStockEntryId,
      customerId: balance.customerId,
      quantityDelta: -input.quantity,
      reason: "restore",
      notes: input.notes,
      photoUrl: null,
      sourceType: "damaged_restore",
      sourceId: balance.id,
      sourceCode: null,
      createdBy: actorEmail,
    });

    // 2. Return units to usable stock.
    if (input.ownerType === "company" && irmItemId) {
      // Company stock: upsert InventoryBalance and append an InventoryTransaction.
      const updatedBal = await inventoryRepo.upsertBalanceTx(tx, irmItemId, input.warehouseId, input.quantity);
      usableBalanceAfter = updatedBal.quantityOnHand;
      await inventoryRepo.insertTransactionTx(tx, {
        irmItemId,
        warehouseId: input.warehouseId,
        quantityDelta: input.quantity,
        type: "restore",
        sourceType: "damaged_restore",
        sourceId: balance.id,
        sourceCode: null,
        balanceAfter: usableBalanceAfter,
        notes: input.notes,
        createdBy: actorEmail,
      });
    } else if (customerStockEntryId) {
      // Customer stock: credit the CustomerStockEntry via the shared, negative-guarded qty-adjust helper.
      const updated = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, customerStockEntryId, input.quantity);
      usableBalanceAfter = updated.quantity;
    }
  });

  audit.record({
    actor,
    action: "goods_management.damaged_restored",
    targetType: "damaged_stock_balance",
    targetId: balance.id,
    targetLabel: balance.itemName,
    metadata: {
      warehouseId: input.warehouseId,
      ownerType: input.ownerType,
      irmItemId,
      customerStockEntryId,
      quantity: input.quantity,
      notes: input.notes,
    },
  });

  return {
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId,
    customerStockEntryId,
    quantityRestored: input.quantity,
    damagedBalanceAfter,
    usableBalanceAfter,
  };
}
