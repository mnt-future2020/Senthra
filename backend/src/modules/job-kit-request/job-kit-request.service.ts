import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
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

function toPublic(r: KitRequestWithLines): PublicKitRequest {
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
    lines: r.lines.map((l) => ({
      id: l.id,
      source: l.source,
      irmItemId: l.irmItemId,
      customerStockEntryId: l.customerStockEntryId,
      itemName: l.itemName,
      sku: l.sku,
      uom: l.uom,
      qty: l.qty,
      jobKitLineId: l.jobKitLineId,
    })),
  };
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

// Engineers who can fulfil a request by transfer: those holding ENOUGH of EVERY stock-tracked line
// (the job's own engineer is excluded). Powers the approve modal's source-engineer picker so the PM
// only ever picks a valid holder. Empty ⇒ no single engineer holds it all (use warehouse issue).
export interface EligibleHolder {
  engineerId: string;
  name: string;
}
export async function eligibleHolders(requestId: string): Promise<EligibleHolder[]> {
  const req = await kitRequestRepo.findById(requestId);
  if (!req) throw notFound("Kit request not found.");
  const job = await jobRepo.findById(req.jobId);
  const exclude = job?.assignedEngineerId ?? "";
  const stockLines = req.lines.filter((l) => l.source !== "misc");
  if (stockLines.length === 0) return [];
  // Fetch each line's holders in parallel (independent queries), then intersect: engineers holding
  // ENOUGH of every stock-tracked line.
  const perLine = await Promise.all(
    stockLines.map((l) => (l.source === "irm" ? transferRepo.findHoldersForIrm(l.irmItemId!, exclude) : transferRepo.findHoldersForCustomer(l.customerStockEntryId!, exclude))),
  );
  let acc: Map<string, string> | null = null; // engineers holding every line seen so far → name
  for (let i = 0; i < stockLines.length; i++) {
    const enough = new Map<string, string>(perLine[i].filter((h) => h.available >= stockLines[i].qty).map((h) => [h.engineerId, h.name]));
    if (acc === null) acc = enough;
    else for (const k of [...acc.keys()]) if (!enough.has(k)) acc.delete(k);
  }
  return [...(acc ?? new Map<string, string>()).entries()].map(([engineerId, name]) => ({ engineerId, name }));
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

  // Resolve the pickup/home warehouse for every IRM line BEFORE we claim + grow, so any problem leaves
  // the request pending. Keyed by request-line id.
  const whByLine = new Map<string, string>();
  if (input.fulfillmentMode === "warehouse_issue") {
    // Each IRM item is issued from a warehouse the PM picked PER LINE (different items can come from
    // different warehouses). Customer-stock lines derive their warehouse from the entry; misc need none.
    const picked = new Map((input.lineWarehouses ?? []).map((w) => [w.requestLineId, w.warehouseId]));
    for (const l of irmLines) {
      const wh = picked.get(l.id);
      if (!wh) throw badRequest(`Choose a pickup warehouse for "${l.itemName}".`);
      whByLine.set(l.id, wh);
    }
  } else {
    // Engineer transfer: stock comes from a van, so NO warehouse is chosen. Validate the source engineer
    // actually holds every stock-tracked line, then derive a nominal home warehouse per IRM line.
    if (!input.fromEngineerId) throw badRequest("Pick the engineer to transfer stock from.");
    if (input.fromEngineerId === job.assignedEngineerId) throw badRequest("Pick a different engineer — the job's own engineer can't transfer to themselves.");
    if (stockLines.length === 0) throw badRequest("These are all misc items — they must be issued from a warehouse, not transferred from a van.");
    await transferService.assertTransferEngineers(input.fromEngineerId, job.assignedEngineerId);
    const shortages = await findHolderShortages(input.fromEngineerId, stockLines);
    if (shortages.length > 0) throw badRequest(`That engineer doesn't hold enough of: ${shortages.join("; ")}.`);
    const homeWarehouses = await Promise.all(irmLines.map((l) => deriveHomeWarehouse(l.irmItemId!, job)));
    irmLines.forEach((l, i) => whByLine.set(l.id, homeWarehouses[i]));
  }

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

    // 2. Fulfilment (engineer transfer) — skip if a transfer was already opened for this request.
    let transferId: string | null = req.transferId ?? null;
    if (input.fulfillmentMode === "engineer_transfer" && !transferId) {
      // Only stock-tracked lines transfer; any misc lines were still added to the kit and get issued
      // from a warehouse the normal way.
      const transferLines = req.lines.map((l, i) => ({ l, jobKitLineId: jobKitLineIds[i] })).filter((x) => x.l.source !== "misc");
      if (transferLines.some((x) => !x.jobKitLineId)) throw conflict("Couldn't link a requested item to its kit line — refresh and try again.");
      const transfer = await transferService.createJobTransfer(
        {
          fromEngineerId: input.fromEngineerId!,
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
        // afterCreate runs inside the transfer's transaction → transfer + transferId checkpoint are atomic.
        (tx, tid) => kitRequestRepo.setTransferIdTx(tx, id, tid),
      );
      transferId = transfer.id;
    }

    // 3. Persist review metadata (line stamps + transferId already checkpointed above).
    const finalized = await kitRequestRepo.finalizeApproval(id, {
      reviewedByUserId: actor.id ?? null,
      reviewedByEmail: actor.email ?? null,
      reviewedAt: new Date(),
      decisionNote: input.decisionNote ?? null,
      fulfillmentMode: input.fulfillmentMode,
      transferId,
    });

    audit.record({ actor, action: "job_kit_request.approved", targetType: "job", targetId: job.id, targetLabel: req.code, metadata: { fulfillmentMode: input.fulfillmentMode, transferId, jobNumber: job.jobNumber } });
    emitUpdate(req.requestedByEngineerId, job.id, { id, code: req.code, status: "approved" });
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

function paged(result: { requests: KitRequestWithLines[]; total: number }, page: number, pageSize: number): PagedKitRequests {
  return {
    requests: result.requests.map(toPublic),
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
  return toPublic(req);
}

// IRM catalogue search for the request composer — lets a field engineer (who has no irm.view) pick a
// real, in-catalogue item to request instead of free-typing a name. Read-only, name/code/sku fields
// only; capped and active-only. A blank term returns nothing (never enumerates the whole catalogue).
export interface KitItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}
export async function searchItems(q: string): Promise<KitItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];
  const rows = await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name");
  return rows.map((r) => ({ irmItemId: r.id, code: r.code, name: r.name, sku: r.sku ?? null, uom: r.baseUnit ?? null }));
}

export async function uploadAttachment(image: string): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  const publicId = `kitreq-${Date.now()}`;
  const url = await uploadToCloudinary(image, publicId, creds, "senthra/kit-requests");
  return { url };
}
