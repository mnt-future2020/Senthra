import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as kitRequestRepo from "./job-kit-request.repository.js";
import type { CreateKitRequestData, CreateKitRequestLineData, KitRequestWithLines } from "./job-kit-request.repository.js";
import type { ApproveKitRequestInput, CreateKitRequestInput, DeclineKitRequestInput } from "./job-kit-request.validation.js";

// ---- DTOs ------------------------------------------------------------------------------------

export interface PublicKitRequestLine {
  id: string;
  source: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  jobKitLineId: string | null;
  // For customer_stock lines: the warehouse the entry is stored in (where it will be issued from). The
  // planner can't change it — it's shown read-only so the approve modal reveals the pickup location.
  // Null for irm/misc lines. Populated on reads that feed the approve modal (list/getOne).
  warehouseName: string | null;
  warehouseCode: string | null;
  // Where this line was actually sourced (set on approve): "warehouse" | "engineer" | null (misc, or
  // a request approved before per-line sourcing shipped — fall back to the request's fulfillmentMode).
  sourceType: string | null;
  sourceWarehouseId: string | null;
  sourceEngineerId: string | null;
}

export interface PublicKitRequest {
  id: string;
  code: string;
  status: string;
  jobId: string;
  jobNumber: string;
  requestedByEngineerId: string;
  requestedByEngineerName: string;
  requestedByEngineerEmail: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  fulfillmentMode: string | null;
  transferId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PublicKitRequestLine[];
}

export interface PagedKitRequests {
  requests: PublicKitRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// whByEntry: customerStockEntryId → its warehouse label, resolved by the caller in one batched query
// (see resolveLineWarehouses) so toPublic stays synchronous and free of per-line DB hits. Absent map =
// no customer-stock warehouse labels (fine for responses that don't drive the approve modal).
function toPublic(r: KitRequestWithLines, whByEntry?: Map<string, { name: string | null; code: string | null }>): PublicKitRequest {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    jobId: r.jobId,
    jobNumber: r.jobNumber,
    requestedByEngineerId: r.requestedByEngineerId,
    requestedByEngineerName: r.requestedByEngineerName,
    requestedByEngineerEmail: r.requestedByEngineerEmail,
    reason: r.reason,
    notes: r.notes,
    attachments: r.attachments,
    reviewedByUserId: r.reviewedByUserId,
    reviewedByEmail: r.reviewedByEmail,
    reviewedAt: iso(r.reviewedAt),
    decisionNote: r.decisionNote,
    fulfillmentMode: r.fulfillmentMode,
    transferId: r.transferId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: r.lines.map((l) => {
      const wh = l.source === "customer_stock" && l.customerStockEntryId ? whByEntry?.get(l.customerStockEntryId) : undefined;
      return {
        id: l.id,
        source: l.source,
        irmItemId: l.irmItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        sku: l.sku,
        uom: l.uom,
        qty: l.qty,
        jobKitLineId: l.jobKitLineId,
        warehouseName: wh?.name ?? null,
        warehouseCode: wh?.code ?? null,
        sourceType: l.sourceType,
        sourceWarehouseId: l.sourceWarehouseId,
        sourceEngineerId: l.sourceEngineerId,
      };
    }),
  };
}

// Batch-resolve the warehouse each customer_stock line's entry is stored in — one query for all lines
// across all given requests (no N+1). Returns entryId → { name, code }. IRM/misc lines are ignored.
async function resolveLineWarehouses(requests: KitRequestWithLines[]): Promise<Map<string, { name: string | null; code: string | null }>> {
  const entryIds = [
    ...new Set(
      requests.flatMap((r) => r.lines.filter((l) => l.source === "customer_stock" && l.customerStockEntryId).map((l) => l.customerStockEntryId as string)),
    ),
  ];
  if (entryIds.length === 0) return new Map();
  return goodsManagementRepo.findCustomerEntryWarehousesByIds(entryIds);
}

function emitUpdate(engineerId: string, jobId: string, data: { id: string; code: string; status: string }): void {
  const payload = { ...data, jobId };
  emitToUser(engineerId, "kit_request:updated", payload);
  emitToRoom(OFFICE_JOBS_ROOM, "kit_request:updated", payload);
}

function isReviewer(actor: AuditActor): boolean {
  const perms = actor.permissions ?? [];
  return actor.type === "admin" || perms.includes("*") || perms.includes("jobs.kit_request.review");
}

// ---- create (field engineer) -----------------------------------------------------------------

export async function create(input: CreateKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const engineerId = actor.id ?? "";
  const job = await jobRepo.findById(input.jobId);
  if (!job) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("You can only request kit for a job assigned to you.");
  if (!["accepted", "in_progress"].includes(job.status)) {
    throw conflict("You can request extra kit once the job is accepted and in progress.");
  }
  // Reconciled goods lock the job — approving a kit request grows the kit (a goods write), which the
  // reconciled lock rejects downstream. Block it HERE so the request is never raised on a locked job,
  // instead of failing only when the PM tries to approve it. Mirrors the lock in job.service.
  if ((await goodsManagementService.getGoodsStatus(input.jobId)) === "reconciled") {
    throw conflict("This job's goods have been reconciled and locked — no more kit can be requested.");
  }

  // Resolve fresh item snapshots — the per-line lookups are independent, so run them in parallel
  // (preserving order) rather than one round-trip at a time.
  const lines: CreateKitRequestLineData[] = await Promise.all(
    input.lines.map(async (l): Promise<CreateKitRequestLineData> => {
      if (l.source === "irm") {
        const item = await irmRepo.findById(l.irmItemId!);
        if (!item) throw badRequest(`The IRM item for "${l.itemName}" no longer exists.`);
        if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
        return { source: "irm", irmItemId: item.id, itemName: item.name, sku: item.sku ?? null, uom: item.baseUnit ?? null, qty: l.qty };
      }
      if (l.source === "customer_stock") {
        const entry = await goodsManagementRepo.findCustomerStockEntryById(l.customerStockEntryId!);
        if (!entry) throw badRequest(`The customer stock item for "${l.itemName}" no longer exists.`);
        if (entry.customerId !== job.customerId) throw badRequest(`"${entry.itemName}" doesn't belong to this job's customer.`);
        return { source: "customer_stock", customerStockEntryId: entry.id, itemName: entry.itemName, sku: entry.sku ?? entry.barcode ?? null, uom: entry.uom ?? null, qty: l.qty };
      }
      return { source: "misc", itemName: l.itemName.trim(), qty: l.qty };
    }),
  );

  const data: CreateKitRequestData = {
    code: "",
    status: "pending",
    jobId: job.id,
    jobNumber: job.jobNumber,
    requestedByEngineerId: engineerId,
    requestedByEngineerName: job.assignedEngineerName ?? "",
    requestedByEngineerEmail: job.assignedEngineerEmail ?? actor.email ?? null,
    reason: input.reason,
    notes: input.notes ?? null,
    attachments: input.attachments ?? [],
    createdBy: actor.email ?? null,
  };

  const req = await kitRequestRepo.createKitRequest(data, lines);
  audit.record({ actor, action: "job_kit_request.created", targetType: "job", targetId: job.id, targetLabel: req.code, metadata: { jobNumber: job.jobNumber, lineCount: lines.length } });
  emitUpdate(engineerId, job.id, { id: req.id, code: req.code, status: req.status });
  return toPublic(req);
}

// Which stock-tracked request lines the given engineer can't cover from their van — powers the
// pre-claim transfer holdings check. Labels read `CAT6 (needs 3, holds 1)`.
async function findHolderShortages(engineerId: string, stockLines: KitRequestWithLines["lines"]): Promise<string[]> {
  // Load the engineer's whole van ONCE (two queries in parallel) rather than one round-trip per line —
  // matters on a high-latency DB link where per-line queries serialise.
  const [irmBalances, customerHoldings] = await Promise.all([
    engineerStockRepo.findEngineerBalances(engineerId),
    goodsManagementRepo.findCustomerHoldingsByEngineer(engineerId),
  ]);
  const irmHeld = new Map(irmBalances.map((b) => [b.irmItemId, b.quantityOnHand]));
  const customerHeld = new Map(customerHoldings.map((h) => [h.customerStockEntryId, h.quantityOnHand]));
  const out: string[] = [];
  for (const l of stockLines) {
    const held = l.source === "irm" ? irmHeld.get(l.irmItemId!) ?? 0 : customerHeld.get(l.customerStockEntryId!) ?? 0;
    if (held < l.qty) out.push(`${l.itemName} (needs ${l.qty}, holds ${held})`);
  }
  return out;
}

// A nominal home warehouse for a transfer-fulfilled IRM kit line (a van transfer picks no warehouse,
// but the kit line still needs one for returns). Prefer: the item's existing kit-line warehouse on this
// job → the warehouse holding the most of it → any warehouse the job already uses → any active warehouse.
async function deriveHomeWarehouse(irmItemId: string, job: NonNullable<Awaited<ReturnType<typeof jobRepo.findById>>>): Promise<string> {
  const onKit = (job.kitLines ?? []).find((k) => k.irmItemId === irmItemId && k.warehouseId);
  if (onKit?.warehouseId) return onKit.warehouseId;
  const balances = await inventoryRepo.findAllBalances({ irmItemId });
  const top = [...balances].filter((b) => b.quantityOnHand > 0).sort((a, b) => b.quantityOnHand - a.quantityOnHand)[0];
  if (top) return top.warehouseId;
  const jobWh = (job.kitLines ?? []).find((k) => k.warehouseId)?.warehouseId;
  if (jobWh) return jobWh;
  const [any] = await warehouseRepo.findMany({ status: "active" }, 0, 1);
  if (any) return any.id;
  throw conflict("No warehouse available to home this item — add a warehouse or issue from stock instead.");
}

export interface EligibleHolder {
  engineerId: string;
  name: string;
}
// Holders PER REQUEST LINE — sourcing is chosen per line, so this asks "who can supply THIS item?"
// rather than the old "who holds the entire request?" (which returned nobody the moment one item was
// missing, dead-ending the PM even when a colleague could cover most of it). `holders` lists only
// engineers with ENOUGH for that line, so the PM can never pick a short one. An empty list simply
// means no van option for that item; the warehouse remains available.
export interface LineHolders {
  requestLineId: string;
  holders: (EligibleHolder & { available: number })[];
}
export async function holdersByLine(requestId: string): Promise<LineHolders[]> {
  const req = await kitRequestRepo.findById(requestId);
  if (!req) throw notFound("Kit request not found.");
  const job = await jobRepo.findById(req.jobId);
  const exclude = job?.assignedEngineerId ?? ""; // the job's own engineer can't supply themselves
  const stockLines = req.lines.filter((l) => l.source !== "misc");
  if (stockLines.length === 0) return [];
  const perLine = await Promise.all(
    stockLines.map((l) => (l.source === "irm" ? transferRepo.findHoldersForIrm(l.irmItemId!, exclude) : transferRepo.findHoldersForCustomer(l.customerStockEntryId!, exclude))),
  );
  return stockLines.map((l, i) => ({
    requestLineId: l.id,
    holders: perLine[i]
      .filter((h) => h.available >= l.qty)
      .map((h) => ({ engineerId: h.engineerId, name: h.name, available: h.available })),
  }));
}

// ---- approve (PM / planner) ------------------------------------------------------------------

export async function approve(id: string, input: ApproveKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const job = await jobRepo.findById(req.jobId);
  if (!job) throw notFound("The job for this request no longer exists.");
  if (!job.assignedEngineerId) throw conflict("This job has no assigned engineer to receive the kit.");

  const irmLines = req.lines.filter((l) => l.source === "irm");
  const stockLines = req.lines.filter((l) => l.source !== "misc");

  // Resolve every line's SOURCE and its pickup/home warehouse BEFORE we claim + grow, so any problem
  // leaves the request pending and nothing is half-applied.
  //
  // Stock for one request rarely sits in one place — the warehouse may hold some items while another
  // engineer's van holds the rest — so the source is chosen PER LINE. `lineSources` expresses that
  // directly; the legacy request-level fulfillmentMode is normalised into the same per-line shape
  // below so there is exactly ONE code path from here on.
  const engineerByLine = new Map<string, string>(); // request-line id → source engineer (transfer lines)
  const whByLine = new Map<string, string>(); // request-line id → pickup/home warehouse (IRM lines)

  const explicit = new Map((input.lineSources ?? []).map((s) => [s.requestLineId, s]));
  if (explicit.size > 0) {
    // Every line must be accounted for — a missing one would silently fall through to no source.
    for (const l of req.lines) {
      if (l.source === "misc") continue; // misc is handed over with the kit; it has no stock source
      if (!explicit.has(l.id)) throw badRequest(`Choose where "${l.itemName}" will be fulfilled from.`);
    }
    for (const [lineId, s] of explicit) {
      const line = req.lines.find((l) => l.id === lineId);
      if (!line) throw badRequest("A chosen source refers to an item that isn't on this request.");
      if (line.source === "misc") continue; // ignore a stray source on a misc line
      if (s.sourceType === "engineer") {
        if (!s.engineerId) throw badRequest(`Pick the engineer to transfer "${line.itemName}" from.`);
        engineerByLine.set(lineId, s.engineerId);
      } else if (line.source === "irm") {
        if (!s.warehouseId) throw badRequest(`Choose a pickup warehouse for "${line.itemName}".`);
        whByLine.set(lineId, s.warehouseId);
      }
      // customer_stock + warehouse source: the warehouse is the entry's own — derived downstream.
    }
  } else if (input.fulfillmentMode === "warehouse_issue") {
    // Legacy shorthand: every IRM item issued from a warehouse the PM picked PER LINE (different items
    // can come from different warehouses). Customer-stock derives from the entry; misc needs none.
    const picked = new Map((input.lineWarehouses ?? []).map((w) => [w.requestLineId, w.warehouseId]));
    for (const l of irmLines) {
      const wh = picked.get(l.id);
      if (!wh) throw badRequest(`Choose a pickup warehouse for "${l.itemName}".`);
      whByLine.set(l.id, wh);
    }
  } else {
    // Legacy shorthand: ALL stock-tracked lines transfer from one engineer's van.
    if (!input.fromEngineerId) throw badRequest("Pick the engineer to transfer stock from.");
    if (stockLines.length === 0) throw badRequest("These are all misc items — they must be issued from a warehouse, not transferred from a van.");
    for (const l of stockLines) engineerByLine.set(l.id, input.fromEngineerId);
  }

  // Validate the transfer side ONCE PER SOURCE ENGINEER, against only the lines they actually supply —
  // checking their whole-request coverage would wrongly reject an engineer who covers just their share.
  const linesByEngineer = new Map<string, KitRequestWithLines["lines"]>();
  for (const l of stockLines) {
    const eng = engineerByLine.get(l.id);
    if (!eng) continue;
    const bucket = linesByEngineer.get(eng);
    if (bucket) bucket.push(l);
    else linesByEngineer.set(eng, [l]);
  }
  for (const [engineerId, lines] of linesByEngineer) {
    if (engineerId === job.assignedEngineerId) throw badRequest("Pick a different engineer — the job's own engineer can't transfer to themselves.");
    await transferService.assertTransferEngineers(engineerId, job.assignedEngineerId);
    const shortages = await findHolderShortages(engineerId, lines);
    if (shortages.length > 0) throw badRequest(`That engineer doesn't hold enough of: ${shortages.join("; ")}.`);
  }

  // IRM lines coming from a van still need a nominal home warehouse (for returns), same as before.
  const vanIrmLines = irmLines.filter((l) => engineerByLine.has(l.id));
  const homeWarehouses = await Promise.all(vanIrmLines.map((l) => deriveHomeWarehouse(l.irmItemId!, job)));
  vanIrmLines.forEach((l, i) => whByLine.set(l.id, homeWarehouses[i]));

  // Request-level summary for list views + history; the per-line detail is authoritative.
  const usesWarehouse = stockLines.some((l) => !engineerByLine.has(l.id)) || (stockLines.length === 0 && irmLines.length === 0);
  const usesEngineer = linesByEngineer.size > 0;
  const resolvedMode = usesEngineer && usesWarehouse ? "mixed" : usesEngineer ? "engineer_transfer" : "warehouse_issue";

  // Claim atomically — flips pending → approved so two concurrent approvals can't both grow the kit.
  const claimed = await kitRequestRepo.claimPending(id);
  if (claimed === 0) throw conflict("This request was just handled by someone else.");

  try {
    // The steps below are RESUMABLE and each side effect is checkpointed ATOMICALLY: the kit-grow stamps
    // the request lines in the SAME transaction, and the transfer stamps req.transferId in the SAME
    // transaction. So a crash can never leave a grow un-stamped or a transfer un-recorded, and a retry
    // resumes from the failed step — never re-growing the kit or opening a duplicate transfer.

    // 1. Grow the kit — skip if the request lines are already stamped (a prior attempt grew it).
    const alreadyGrown = req.lines.length > 0 && req.lines.every((l) => l.jobKitLineId);
    let jobKitLineIds: (string | null)[];
    if (alreadyGrown) {
      jobKitLineIds = req.lines.map((l) => l.jobKitLineId);
    } else {
      const appendLines: jobService.KitAppendLine[] = req.lines.map((l) => ({
        source: l.source as "irm" | "customer_stock" | "misc",
        irmItemId: l.irmItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        qty: l.qty,
        warehouseId: l.source === "irm" ? whByLine.get(l.id) ?? null : null,
      }));
      // stampTx runs inside the grow's transaction → grow + stamp are atomic.
      const grown = await jobService.appendKitFromRequest(job.id, appendLines, actor, (tx, ids) =>
        kitRequestRepo.stampLineKitIdsTx(tx, req.lines.map((l, i) => ({ id: l.id, jobKitLineId: ids[i] }))),
      );
      jobKitLineIds = grown.jobKitLineIds;
    }

    // 2. Fulfilment — ONE transfer per distinct source engineer (warehouse-sourced lines need no
    // transfer; they're collected via Goods Management once the kit has grown).
    //
    // Resumability: each transfer APPENDS its id to req.transferIds inside its own transaction, and
    // we skip any engineer already recorded there. So a crash midway through a two-engineer approval
    // resumes by opening only the transfer that never got created — never a duplicate.
    const kitLineIdByRequestLine = new Map(req.lines.map((l, i) => [l.id, jobKitLineIds[i]]));
    // Transfers already opened by a previous attempt, keyed by their SOURCE engineer — the only
    // reliable way to tell which of several transfers survived a crash. Reads from the transfer
    // records themselves rather than inferring from request state.
    const priorIds = [...(req.transferIds ?? []), ...(req.transferId ? [req.transferId] : [])];
    const priorByEngineer = new Map<string, string>();
    for (const t of await transferRepo.findSourcesByIds([...new Set(priorIds)])) {
      priorByEngineer.set(t.fromEngineerId, t.id);
    }
    const transferIds: string[] = [];
    for (const [engineerId, lines] of linesByEngineer) {
      const existing = priorByEngineer.get(engineerId);
      if (existing) { transferIds.push(existing); continue; } // already opened — resume past it
      const transferLines = lines
        .map((l) => ({ l, jobKitLineId: kitLineIdByRequestLine.get(l.id) }))
        .filter((x) => x.l.source !== "misc");
      if (transferLines.some((x) => !x.jobKitLineId)) throw conflict("Couldn't link a requested item to its kit line — refresh and try again.");
      const transfer = await transferService.createJobTransfer(
        {
          fromEngineerId: engineerId,
          toEngineerId: job.assignedEngineerId,
          jobId: job.id,
          customerId: job.customerId,
          reason: `Kit request ${req.code} — ${job.jobNumber}`,
          notes: input.decisionNote ?? null,
          lines: transferLines.map((x) => ({
            ownership: x.l.source === "irm" ? "company" : "customer",
            irmItemId: x.l.irmItemId ?? undefined,
            customerStockEntryId: x.l.customerStockEntryId ?? undefined,
            quantity: x.l.qty,
            jobKitLineId: x.jobKitLineId ?? undefined,
          })),
        },
        actor,
        // afterCreate runs inside the transfer's transaction → transfer + checkpoint are atomic.
        (tx, tid) => kitRequestRepo.appendTransferIdTx(tx, id, tid),
      );
      transferIds.push(transfer.id);
    }
    // Keep the legacy single-id field meaningful for existing readers (first transfer wins).
    const transferId: string | null = transferIds[0] ?? null;

    // 3. Persist review metadata + the per-line sources (line stamps / transfer ids checkpointed above).
    const finalized = await kitRequestRepo.finalizeApproval(id, {
      reviewedByUserId: actor.id ?? null,
      reviewedByEmail: actor.email ?? null,
      reviewedAt: new Date(),
      decisionNote: input.decisionNote ?? null,
      fulfillmentMode: resolvedMode,
      transferId,
      transferIds,
      lineSources: req.lines.map((l) => ({
        id: l.id,
        sourceType: l.source === "misc" ? null : engineerByLine.has(l.id) ? "engineer" : "warehouse",
        sourceEngineerId: engineerByLine.get(l.id) ?? null,
        sourceWarehouseId: engineerByLine.has(l.id) ? null : whByLine.get(l.id) ?? null,
      })),
    });

    audit.record({ actor, action: "job_kit_request.approved", targetType: "job", targetId: job.id, targetLabel: req.code, metadata: { fulfillmentMode: resolvedMode, transferIds, jobNumber: job.jobNumber } });
    emitUpdate(req.requestedByEngineerId, job.id, { id, code: req.code, status: "approved" });
    notify(req.requestedByEngineerId, { title: "Kit request approved", body: `Your kit request ${req.code} for ${job.jobNumber} was approved.`, data: { type: "job", jobId: job.id } });
    return toPublic(finalized);
  } catch (e) {
    // Roll the status back to pending so the PM can retry. The grow + transfer are checkpointed on the
    // request (stamped line ids / transferId), so the retry RESUMES from the failed step, never repeating
    // the already-committed work — no kit inflation, no duplicate transfer.
    await kitRequestRepo.revertToPending(id).catch(() => {});
    throw e;
  }
}

// ---- decline (PM / planner) ------------------------------------------------------------------

export async function decline(id: string, input: DeclineKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const count = await kitRequestRepo.declinePending(id, { reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null });
  if (count === 0) throw conflict("This request was just handled by someone else.");
  const updated = await kitRequestRepo.findById(id);

  audit.record({ actor, action: "job_kit_request.declined", targetType: "job", targetId: req.jobId, targetLabel: req.code, metadata: { jobNumber: req.jobNumber, decisionNote: input.decisionNote } });
  emitUpdate(req.requestedByEngineerId, req.jobId, { id, code: req.code, status: "declined" });
  notify(req.requestedByEngineerId, { title: "Kit request declined", body: `Your kit request ${req.code} was declined.${input.decisionNote ? ` ${input.decisionNote}` : ""}`, data: { type: "job", jobId: req.jobId } });
  return toPublic(updated!);
}

// ---- cancel (requester, while pending) -------------------------------------------------------

export async function cancel(id: string, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const count = await kitRequestRepo.cancelPending(id, actor.id ?? "");
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel it, and only while it's pending.");
  const updated = await kitRequestRepo.findById(id);

  audit.record({ actor, action: "job_kit_request.cancelled", targetType: "job", targetId: req.jobId, targetLabel: req.code, metadata: { jobNumber: req.jobNumber } });
  emitUpdate(req.requestedByEngineerId, req.jobId, { id, code: req.code, status: "cancelled" });
  return toPublic(updated!);
}

// ---- reads -----------------------------------------------------------------------------------

async function paged(result: { requests: KitRequestWithLines[]; total: number }, page: number, pageSize: number): Promise<PagedKitRequests> {
  const whByEntry = await resolveLineWarehouses(result.requests);
  return {
    requests: result.requests.map((r) => toPublic(r, whByEntry)),
    total: result.total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
  };
}

export async function listMine(engineerId: string, params: { status?: string; jobId?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedKitRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const result = await kitRequestRepo.listRequests({ ...params, engineerId, page, pageSize });
  return paged(result, page, pageSize);
}

export async function listAll(params: { status?: string; jobId?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedKitRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const result = await kitRequestRepo.listRequests({ ...params, page, pageSize });
  return paged(result, page, pageSize);
}

export function countPending(jobId?: string): Promise<number> {
  return kitRequestRepo.countPending(jobId);
}

export async function getOne(id: string, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (!isReviewer(actor) && (actor.id ?? "") !== req.requestedByEngineerId) {
    throw forbidden("You don't have access to this request.");
  }
  return toPublic(req, await resolveLineWarehouses([req]));
}

// Item search for the request composer — lets a field engineer (who has no irm.view) pick a real item
// to request instead of free-typing a name. Read-only, name/code/sku only; capped, active-only. A blank
// term returns nothing (never enumerates a whole catalogue). Two sources, discriminated by `source`:
//   • irm            — the company IRM catalogue (always searched)
//   • customer_stock — the JOB'S OWN customer's active, in-stock consignment entries (only when jobId is
//                      given). Scoped HARD to the job's customerId — never leaks another customer's stock.
export type KitItemOption =
  | { source: "irm"; irmItemId: string; code: string; name: string; sku: string | null; uom: string | null }
  | {
      source: "customer_stock";
      customerStockEntryId: string;
      name: string;
      sku: string | null;
      uom: string | null;
      qty: number;
      warehouseName: string;
      warehouseCode: string | null;
      serialNumber: string | null;
    };

export async function searchItems(q: string, jobId?: string): Promise<KitItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];

  const irmRows = await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name");
  const irmOptions: KitItemOption[] = irmRows.map((r) => ({
    source: "irm",
    irmItemId: r.id,
    code: r.code,
    name: r.name,
    sku: r.sku ?? null,
    uom: r.baseUnit ?? null,
  }));

  // Customer stock only when we can resolve the job's customer. If the job is missing/soft-deleted, stay
  // resilient and return IRM only rather than failing the whole search.
  let customerOptions: KitItemOption[] = [];
  if (jobId) {
    const job = await jobRepo.findById(jobId);
    if (job?.customerId) {
      const rows = await goodsManagementRepo.searchActiveCustomerStock(job.customerId, term, 20);
      customerOptions = rows.map((r) => ({
        source: "customer_stock",
        customerStockEntryId: r.id,
        name: r.itemName,
        sku: r.sku,
        uom: r.uom,
        qty: r.quantity,
        warehouseName: r.warehouseName,
        warehouseCode: r.warehouseCode,
        serialNumber: r.serialNumber,
      }));
    }
  }

  return [...irmOptions, ...customerOptions];
}

export async function uploadAttachment(image: string): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  const publicId = `kitreq-${Date.now()}`;
  const url = await uploadToCloudinary(image, publicId, creds, "senthra/kit-requests");
  return { url };
}
