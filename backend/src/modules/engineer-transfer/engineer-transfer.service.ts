import type { Prisma } from "@prisma/client";

import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitAttentionChanged, emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as settingsService from "#modules/settings/settings.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as customerStockRepo from "#modules/goods-management/goods-management.repository.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as transferRepo from "./engineer-transfer.repository.js";
import type { CreateTransferInput, TransferLineInput } from "./engineer-transfer.validation.js";
import type { CreateTransferData, CreateTransferLineData, TransferWithLines } from "./engineer-transfer.repository.js";
import { randomUUID } from "node:crypto";

// ---- DTO types -------------------------------------------------------------------------------

export interface PublicTransferLine {
  id: string;
  ownership: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  quantity: number;
}

export interface PublicTransfer {
  id: string;
  code: string;
  status: string;
  fromEngineerId: string;
  fromEngineerName: string;
  fromEngineerEmail: string | null;
  fromEngineerPhone: string | null;
  toEngineerId: string;
  toEngineerName: string;
  toEngineerEmail: string | null;
  requestedById: string;
  requestedByEmail: string | null;
  requestedByKind: string;
  reason: string;
  notes: string | null;
  jobId: string | null;
  customerId: string | null;
  attachments: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  overrideByAdmin: boolean;
  declinedBy: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  requireSignature: boolean;
  receiverSignatureUrl: string | null;
  acknowledgedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PublicTransferLine[];
}

export interface PagedTransfers {
  transfers: PublicTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function toPublicLine(l: { id: string; ownership: string; irmItemId: string | null; customerStockEntryId: string | null; itemName: string; sku: string | null; uom: string | null; quantity: number }): PublicTransferLine {
  return {
    id: l.id,
    ownership: l.ownership,
    irmItemId: l.irmItemId,
    customerStockEntryId: l.customerStockEntryId,
    itemName: l.itemName,
    sku: l.sku,
    uom: l.uom,
    quantity: l.quantity,
  };
}

function toPublic(t: TransferWithLines): PublicTransfer {
  return {
    id: t.id,
    code: t.code,
    status: t.status,
    fromEngineerId: t.fromEngineerId,
    fromEngineerName: t.fromEngineerName,
    fromEngineerEmail: t.fromEngineerEmail,
    fromEngineerPhone: t.fromEngineerPhone,
    toEngineerId: t.toEngineerId,
    toEngineerName: t.toEngineerName,
    toEngineerEmail: t.toEngineerEmail,
    requestedById: t.requestedById,
    requestedByEmail: t.requestedByEmail,
    requestedByKind: t.requestedByKind,
    reason: t.reason,
    notes: t.notes,
    jobId: t.jobId,
    customerId: t.customerId,
    attachments: t.attachments,
    approvedBy: t.approvedBy,
    approvedAt: iso(t.approvedAt),
    overrideByAdmin: t.overrideByAdmin,
    declinedBy: t.declinedBy,
    declinedAt: iso(t.declinedAt),
    declineReason: t.declineReason,
    cancelledAt: iso(t.cancelledAt),
    completedAt: iso(t.completedAt),
    requireSignature: t.requireSignature,
    receiverSignatureUrl: t.receiverSignatureUrl,
    acknowledgedAt: iso(t.acknowledgedAt),
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    lines: t.lines.map(toPublicLine),
  };
}

function emitBoth(fromEngineerId: string, toEngineerId: string, data: { id: string; code: string; status: string }): void {
  emitToUser(fromEngineerId, "engineer:transfer_updated", data);
  emitToUser(toEngineerId, "engineer:transfer_updated", data);
  // Office staff (admins + anyone with jobs.view) live-update the admin transfer board.
  emitToRoom(OFFICE_JOBS_ROOM, "engineer:transfer_updated", data);
  emitAttentionChanged("engineer_transfers");
}

// Resolve name from User (no single `name` field — compose firstName + lastName).
function engineerName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

// Assert that a user exists, is active, and their role canHoldStock.
async function assertEngineer(id: string, label: string): Promise<{ id: string; name: string; email: string; phone: string | null }> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound(`${label} engineer not found.`);
  if (user.status !== "active") throw badRequest(`${label} engineer account is not active.`);
  if (!user.role?.canHoldStock) throw badRequest(`${label} user is not a stock-holding engineer.`);
  return { id: user.id, name: engineerName(user), email: user.email, phone: user.phone ?? null };
}

// ---- getEngineerTransferRequireSignature helper -----------------------------------------------

export async function getEngineerTransferRequireSignature(): Promise<boolean> {
  const settings = await settingsService.getSettings();
  return settings.engineerTransferRequireSignature ?? false;
}

// Admin oversight of transfers is keyed on the PERMISSION, not the principal type. The only
// `type:"admin"` principal is the root account; staff super-admins / warehouse managers are
// `type:"user"` but hold `engineer_stock.transfer` (or "*") and must get the same oversight powers
// (arbitrary recipient on create, plus decline / cancel / override on the board). A field engineer
// (only `engineer.transfer`) is NOT oversight.
function hasStockOversight(actor: AuditActor): boolean {
  const perms = actor.permissions ?? [];
  return perms.includes("*") || perms.includes("engineer_stock.transfer");
}

// Resolve each input line to a persisted line with fresh item snapshots, carrying the optional
// jobKitLineId through (set only for job-kit-request fulfilment). Shared by the ordinary composer
// (createTransfer) and the PM-initiated job-scoped path (createJobTransfer).
async function resolveTransferLines(inputLines: TransferLineInput[]): Promise<CreateTransferLineData[]> {
  const lines: CreateTransferLineData[] = [];
  for (const l of inputLines) {
    if (l.ownership === "company") {
      const item = await irmRepo.findById(l.irmItemId!);
      if (!item) throw notFound(`IRM item ${l.irmItemId} not found.`);
      if (item.status !== "active") throw badRequest(`IRM item "${item.name}" is not active.`);
      lines.push({
        ownership: "company",
        irmItemId: item.id,
        itemName: item.name,
        sku: item.sku ?? null,
        uom: item.baseUnit ?? null,
        quantity: l.quantity,
        jobKitLineId: l.jobKitLineId ?? null,
      });
    } else {
      const entry = await customerStockRepo.findCustomerStockEntryById(l.customerStockEntryId!);
      if (!entry) throw notFound(`Customer stock entry ${l.customerStockEntryId} not found.`);
      lines.push({
        ownership: "customer",
        customerStockEntryId: entry.id,
        itemName: entry.itemName,
        sku: entry.sku ?? entry.barcode ?? null,
        uom: entry.uom ?? null,
        quantity: l.quantity,
        jobKitLineId: l.jobKitLineId ?? null,
      });
    }
  }
  return lines;
}

// Validate that a job-scoped transfer's source + recipient are both active stock-holding engineers and
// distinct — used by the kit-request approval to fail fast BEFORE it grows the kit (createJobTransfer
// re-checks, but that runs after the grow).
export async function assertTransferEngineers(fromEngineerId: string, toEngineerId: string): Promise<void> {
  const from = await assertEngineer(fromEngineerId, "Source");
  const to = await assertEngineer(toEngineerId, "Destination");
  if (from.id === to.id) throw badRequest("The source engineer can't be the same as the job's engineer — pick a different holder.");
}

// ---- createJobTransfer (job-scoped, PM-initiated from a kit-request approval) -----------------
// Unlike createTransfer, the recipient is set EXPLICITLY (the job's assigned engineer), not derived
// from the caller — the JobKitRequest service has already authorised the PM (jobs.kit_request.review).
// Every line MUST carry a jobKitLineId so completion attributes the received qty to the job (see
// repository.completeTransferOnce). Returns the pending transfer; the holder still approves it.
export interface CreateJobTransferParams {
  fromEngineerId: string;
  toEngineerId: string;
  jobId: string;
  customerId?: string | null;
  reason: string;
  notes?: string | null;
  lines: TransferLineInput[];
}

export async function createJobTransfer(
  params: CreateJobTransferParams,
  actor: AuditActor,
  // Runs inside the transfer-creation transaction with the new transfer id — the kit-request approve
  // uses it to stamp its request.transferId atomically, so a retry can't open a duplicate transfer.
  afterCreate?: (tx: Prisma.TransactionClient, transferId: string) => Promise<void>,
): Promise<PublicTransfer> {
  const fromEng = await assertEngineer(params.fromEngineerId, "Source");
  const toEng = await assertEngineer(params.toEngineerId, "Destination");
  if (fromEng.id === toEng.id) throw badRequest("The source engineer can't be the same as the job's engineer — pick a different holder.");

  const requireSignature = await getEngineerTransferRequireSignature();
  const lines = await resolveTransferLines(params.lines);

  const data: CreateTransferData = {
    code: "",
    status: "pending",
    fromEngineerId: fromEng.id,
    fromEngineerName: fromEng.name,
    fromEngineerEmail: fromEng.email,
    fromEngineerPhone: fromEng.phone,
    toEngineerId: toEng.id,
    toEngineerName: toEng.name,
    toEngineerEmail: toEng.email,
    requestedById: actor.id ?? "",
    requestedByEmail: actor.email ?? "",
    requestedByKind: "admin",
    reason: params.reason,
    notes: params.notes ?? null,
    jobId: params.jobId,
    customerId: params.customerId ?? null,
    attachments: [],
    requireSignature,
    createdBy: actor.email ?? null,
  };

  const transfer = await transferRepo.createTransfer(data, lines, afterCreate);

  audit.record({
    actor,
    action: "engineer_transfer.created",
    targetType: "engineer_transfer",
    targetId: transfer.id,
    targetLabel: transfer.code,
    metadata: { fromEngineerId: fromEng.id, toEngineerId: toEng.id, jobId: params.jobId, lineCount: lines.length },
  });
  emitBoth(fromEng.id, toEng.id, { id: transfer.id, code: transfer.code, status: transfer.status });
  // Notify the HOLDER — they must approve/decline giving stock from their van.
  notify(fromEng.id, { title: "Stock requested from your van", body: `${transfer.toEngineerName} requested stock (${transfer.code}) — approve or decline it.`, data: { type: "transfer", transferId: transfer.id } });

  return toPublic(transfer);
}

// ---- createTransfer ---------------------------------------------------------------------------

export async function createTransfer(input: CreateTransferInput, actor: AuditActor): Promise<PublicTransfer> {
  // Resolve who the requester is.
  const requestedById = actor.id ?? "";
  const requestedByEmail = actor.email ?? "";

  // "Admin-side" = created from the oversight board (see hasStockOversight). A field engineer may
  // only request stock FOR THEMSELVES; oversight callers may name an arbitrary recipient.
  const isAdminSide = hasStockOversight(actor);
  const requestedByKind: string = isAdminSide ? "admin" : "engineer";

  // Resolve the FROM engineer (holder)
  const fromEng = await assertEngineer(input.fromEngineerId, "Source");

  // Resolve the TO engineer (recipient). A non-admin-side caller (a field engineer) may ONLY request
  // stock FOR THEMSELVES — we force the recipient to the caller, so an engineer can never create a
  // transfer between two other engineers. Admin-side callers may name an arbitrary recipient.
  const toEngineerId = isAdminSide ? (input.toEngineerId ?? requestedById) : requestedById;
  if (!toEngineerId) throw badRequest("Recipient engineer ID is required.");
  const toEng = await assertEngineer(toEngineerId, "Destination");

  // from and to must be different
  if (fromEng.id === toEng.id) throw badRequest("Source and destination engineer must be different.");

  // Snapshot the requireSignature setting at create time
  const requireSignature = await getEngineerTransferRequireSignature();

  // Resolve item snapshots for lines
  const lines = await resolveTransferLines(input.lines);

  const data: CreateTransferData = {
    code: "", // allocated inside createTransfer
    status: "pending",
    fromEngineerId: fromEng.id,
    fromEngineerName: fromEng.name,
    fromEngineerEmail: fromEng.email,
    fromEngineerPhone: fromEng.phone,
    toEngineerId: toEng.id,
    toEngineerName: toEng.name,
    toEngineerEmail: toEng.email,
    requestedById,
    requestedByEmail,
    requestedByKind,
    reason: input.reason,
    notes: input.notes ?? null,
    jobId: input.jobId ?? null,
    customerId: input.customerId ?? null,
    attachments: input.attachments ?? [],
    requireSignature,
    createdBy: requestedByEmail || null,
  };

  const transfer = await transferRepo.createTransfer(data, lines);

  audit.record({
    actor,
    action: "engineer_transfer.created",
    targetType: "engineer_transfer",
    targetId: transfer.id,
    targetLabel: transfer.code,
    metadata: { fromEngineerId: fromEng.id, toEngineerId: toEng.id, lineCount: lines.length },
  });

  emitBoth(fromEng.id, toEng.id, { id: transfer.id, code: transfer.code, status: transfer.status });
  // Notify the HOLDER — they must approve/decline giving stock from their van.
  notify(fromEng.id, { title: "Stock requested from your van", body: `${transfer.toEngineerName} requested stock (${transfer.code}) — approve or decline it.`, data: { type: "transfer", transferId: transfer.id } });

  return toPublic(transfer);
}

// ---- listMine ---------------------------------------------------------------------------------

export async function listMine(engineerId: string, params: { role?: "incoming" | "outgoing" | "all"; status?: string; sort?: string; search?: string; page?: number; pageSize?: number }): Promise<PagedTransfers> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const { transfers, total } = await transferRepo.listForEngineer(engineerId, { ...params, page, pageSize });
  return {
    transfers: transfers.map(toPublic),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// Count of completed transfers awaiting the engineer's receipt signature — Engineer dashboard attention row.
export function countAwaitingSignature(engineerId: string): Promise<number> {
  return transferRepo.countAwaitingSignature(engineerId);
}

// ---- listAll (admin / oversight) -------------------------------------------------------------

export async function listAll(params: { status?: string; engineerId?: string; ownership?: string; sort?: string; search?: string; page?: number; pageSize?: number }, _actor: AuditActor): Promise<PagedTransfers> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const { transfers, total } = await transferRepo.listAll({ ...params, page, pageSize });
  return {
    transfers: transfers.map(toPublic),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---- getOne -----------------------------------------------------------------------------------

export async function getOne(id: string, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  // Oversight roles (admin / engineer_stock.*) may view any transfer; everyone else (a field
  // engineer) may only view transfers they are a party to.
  const perms = actor.permissions ?? [];
  const isOversight = perms.includes("*") || perms.includes("engineer_stock.view") || perms.includes("engineer_stock.transfer");
  if (!isOversight) {
    const me = actor.id ?? "";
    if (me !== t.fromEngineerId && me !== t.toEngineerId && me !== t.requestedById) {
      throw forbidden("You don't have access to this transfer.");
    }
  }
  return toPublic(t);
}

// ---- getHolders -------------------------------------------------------------------------------

export interface HolderResult {
  engineerId: string;
  name: string;
  available: number;
}

export async function getHolders(
  query: { ownership: string; irmItemId?: string; customerStockEntryId?: string },
  requesterId: string,
): Promise<HolderResult[]> {
  if (query.ownership === "company") {
    if (!query.irmItemId) throw badRequest("irmItemId is required for company ownership.");
    return transferRepo.findHoldersForIrm(query.irmItemId, requesterId);
  } else if (query.ownership === "customer") {
    if (!query.customerStockEntryId) throw badRequest("customerStockEntryId is required for customer ownership.");
    return transferRepo.findHoldersForCustomer(query.customerStockEntryId, requesterId);
  } else {
    throw badRequest("ownership must be 'company' or 'customer'.");
  }
}

// A specific engineer's transferable holdings (company + customer), with ids + available qty.
// Powers the admin "New transfer" item picker (admin knows the source engineer).
export function getEngineerHoldings(engineerId: string) {
  return transferRepo.findEngineerHoldings(engineerId);
}

// Engineer-portal company (IRM) discovery: company items held by OTHER engineers matching the search
// term. Engineers have no irm.view, so they discover transferable company stock here (held balances),
// not via the catalogue. A blank term is rejected so it can't enumerate everyone's holdings.
export async function getCompanyCandidates(search: string, requesterId: string) {
  const term = (search ?? "").trim();
  if (term.length < 1) return [];
  return transferRepo.findCompanyHoldingsBySearch(term, requesterId);
}

// Engineer-portal customer-consignment discovery: customer items held by OTHER engineers matching
// the search term (the requester is always excluded so they can't see their own holdings here). A
// blank term is rejected so the endpoint can't be used to enumerate everyone's customer holdings.
export async function getCustomerCandidates(search: string, requesterId: string) {
  const term = (search ?? "").trim();
  if (term.length < 1) return [];
  return transferRepo.findCustomerHoldingsBySearch(term, requesterId);
}

// ---- approve (holder only) -------------------------------------------------------------------

export async function approve(id: string, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  if (t.status !== "pending") throw conflict(`Cannot approve a ${t.status} transfer.`);

  // Only the HOLDER (fromEngineer) may approve — oversight callers use override() instead.
  const actorId = actor.id ?? "";
  const isOversight = hasStockOversight(actor);
  if (!isOversight && actorId !== t.fromEngineerId) {
    throw forbidden("Only the stock holder can approve this transfer.");
  }
  // An oversight caller who is not the holder must force-complete via the override path.
  if (isOversight && actorId !== t.fromEngineerId) {
    throw forbidden("Admins must use the override endpoint to force-complete a transfer.");
  }

  const approverEmail = actor.email ?? t.fromEngineerEmail ?? "";
  const completed = await transferRepo.completeTransferTx(id, { approverEmail, overrideByAdmin: false });

  audit.record({
    actor,
    action: "engineer_transfer.approved",
    targetType: "engineer_transfer",
    targetId: completed.id,
    targetLabel: completed.code,
    metadata: { approvedBy: approverEmail },
  });
  emitBoth(completed.fromEngineerId, completed.toEngineerId, { id: completed.id, code: completed.code, status: completed.status });
  // Notify the RECIPIENT — their request was approved; stock is on its way.
  notify(completed.toEngineerId, {
    title: "Transfer approved",
    body: `${completed.fromEngineerName} approved your stock request (${completed.code}).${completed.requireSignature ? " Sign for it on delivery." : ""}`,
    data: { type: "transfer", transferId: completed.id },
  });

  return toPublic(completed);
}

// ---- decline ---------------------------------------------------------------------------------

export async function decline(id: string, reason: string | undefined, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  if (t.status !== "pending") throw conflict(`Cannot decline a ${t.status} transfer.`);

  // The holder or an oversight caller (root admin OR staff with engineer_stock.transfer) may decline.
  const actorId = actor.id ?? "";
  if (!hasStockOversight(actor) && actorId !== t.fromEngineerId) {
    throw forbidden("Only the stock holder or an admin can decline this transfer.");
  }

  const declinedBy = actor.email ?? "";
  const declined = await transferRepo.declineTx(id, declinedBy, reason);

  audit.record({
    actor,
    action: "engineer_transfer.declined",
    targetType: "engineer_transfer",
    targetId: declined.id,
    targetLabel: declined.code,
    metadata: { declinedBy, reason },
  });
  emitBoth(declined.fromEngineerId, declined.toEngineerId, { id: declined.id, code: declined.code, status: declined.status });
  // Notify the RECIPIENT — their request was declined.
  notify(declined.toEngineerId, { title: "Transfer declined", body: `${declined.fromEngineerName} declined your stock request (${declined.code}).`, data: { type: "transfer", transferId: declined.id } });

  return toPublic(declined);
}

// ---- cancel (requester only, while pending) --------------------------------------------------

export async function cancel(id: string, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  if (t.status !== "pending") throw conflict(`Cannot cancel a ${t.status} transfer.`);

  // The original requester or an oversight caller (root admin OR staff with engineer_stock.transfer) may cancel.
  const actorId = actor.id ?? "";
  if (!hasStockOversight(actor) && actorId !== t.requestedById) {
    throw forbidden("Only the requester or an admin can cancel this transfer.");
  }

  const cancelled = await transferRepo.cancelTx(id);

  audit.record({
    actor,
    action: "engineer_transfer.cancelled",
    targetType: "engineer_transfer",
    targetId: cancelled.id,
    targetLabel: cancelled.code,
    metadata: { cancelledBy: actor.email },
  });
  emitBoth(cancelled.fromEngineerId, cancelled.toEngineerId, { id: cancelled.id, code: cancelled.code, status: cancelled.status });
  // Notify the HOLDER — the request they were asked to act on was withdrawn.
  notify(cancelled.fromEngineerId, { title: "Transfer request cancelled", body: `The stock request ${cancelled.code} was cancelled — no action needed.`, data: { type: "transfer", transferId: cancelled.id } });

  return toPublic(cancelled);
}

// Withdraw every pending handover raised for a job that has just been CANCELLED.
//
// A pending transfer is a to-do on the SOURCE engineer ("hand N units from your van to this job"). The
// job going away doesn't clear it: it stayed on their Transfers list with nothing to decide, and both
// kit lists kept rendering "awaiting handover" as though stock were still on its way to dead work.
// No stock moves either way — a pending transfer has never touched a balance (only completeTransferTx
// does) — so this is purely closing an open request.
//
// Unlike `cancel` above there is no requester/oversight check: the caller is the job-cancel flow, which
// carries its own `jobs.cancel` permission, and the decision has already been made upstream. Each
// transfer is cancelled independently so one failure can't strand the rest. Returns how many closed.
export async function cancelPendingForJob(jobId: string, actor: AuditActor): Promise<number> {
  const pending = await transferRepo.findPendingByJob(jobId);
  let closed = 0;
  for (const t of pending) {
    try {
      const cancelled = await transferRepo.cancelTx(t.id);
      closed += 1;
      audit.record({
        actor,
        action: "engineer_transfer.cancelled",
        targetType: "engineer_transfer",
        targetId: cancelled.id,
        targetLabel: cancelled.code,
        metadata: { cancelledBy: actor.email, reason: "job cancelled", jobId },
      });
      emitBoth(cancelled.fromEngineerId, cancelled.toEngineerId, { id: cancelled.id, code: cancelled.code, status: cancelled.status });
      // The holder was the one being asked to act, so they are the one who needs to know it's off.
      notify(cancelled.fromEngineerId, {
        title: "Transfer request cancelled",
        body: `The job was cancelled — stock request ${cancelled.code} no longer needs action.`,
        data: { type: "transfer", transferId: cancelled.id },
      });
    } catch (e) {
      // A race (the holder approved it a second ago) leaves a completed transfer, which is correct and
      // not this function's business to undo. Log and carry on with the rest.
      console.error(`Withdrawing transfer ${t.code} after job ${jobId} was cancelled failed:`, e instanceof Error ? e.message : e);
    }
  }
  return closed;
}

// ---- override (admin force-complete) ---------------------------------------------------------

export async function override(id: string, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  if (t.status !== "pending") throw conflict(`Cannot override a ${t.status} transfer.`);

  const approverEmail = actor.email ?? "";
  const completed = await transferRepo.completeTransferTx(id, { approverEmail, overrideByAdmin: true });

  audit.record({
    actor,
    action: "engineer_transfer.overridden",
    targetType: "engineer_transfer",
    targetId: completed.id,
    targetLabel: completed.code,
    metadata: { overriddenBy: approverEmail },
  });
  emitBoth(completed.fromEngineerId, completed.toEngineerId, { id: completed.id, code: completed.code, status: completed.status });
  // Admin force-completed — tell the recipient their stock request is done.
  notify(completed.toEngineerId, {
    title: "Transfer completed",
    body: `Your stock request ${completed.code} was completed.${completed.requireSignature ? " Sign for it on delivery." : ""}`,
    data: { type: "transfer", transferId: completed.id },
  });

  return toPublic(completed);
}

// ---- acknowledge (recipient signs) -----------------------------------------------------------

export async function acknowledge(id: string, signatureDataUri: string, actor: AuditActor): Promise<PublicTransfer> {
  const t = await transferRepo.findById(id);
  if (!t) throw notFound("Transfer not found.");
  if (t.status !== "completed") throw conflict("Transfer must be completed before acknowledging.");

  // Only the recipient (toEngineer) may acknowledge
  const actorId = actor.id ?? "";
  if (actor.type !== "admin" && actorId !== t.toEngineerId) {
    throw forbidden("Only the recipient can acknowledge this transfer.");
  }

  // Upload signature to Cloudinary
  const creds = await settingsService.getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  // Unique per upload, not per millisecond. uploadToCloudinary passes `overwrite: true` because
  // branding and user signatures are replaced in place — so a publicId two concurrent uploads can
  // agree on is one silently overwriting the other. Two engineers acknowledging at once is exactly
  // the case, and the loser's signature is evidence nobody would notice was gone.
  const publicId = `sig-${t.id}-${randomUUID()}`;
  const { url: signatureUrl } = await uploadToCloudinary(signatureDataUri, publicId, creds, "senthra/engineer-transfers");

  const acknowledged = await transferRepo.acknowledgeTx(id, signatureUrl);

  audit.record({
    actor,
    action: "engineer_transfer.acknowledged",
    targetType: "engineer_transfer",
    targetId: acknowledged.id,
    targetLabel: acknowledged.code,
    metadata: { acknowledgedBy: actor.email },
  });
  emitBoth(acknowledged.fromEngineerId, acknowledged.toEngineerId, { id: acknowledged.id, code: acknowledged.code, status: acknowledged.status });

  return toPublic(acknowledged);
}

// ---- uploadAttachment -----------------------------------------------------------------------

export async function uploadAttachment(image: string): Promise<{ url: string }> {
  const creds = await settingsService.getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  // Same reason as the acknowledgement signature above — and worse here, since `attach-` carries no
  // transfer id either, so the collision window was the whole app rather than one transfer.
  const publicId = `attach-${randomUUID()}`;
  const { url } = await uploadToCloudinary(image, publicId, creds, "senthra/engineer-transfers");
  return { url };
}
