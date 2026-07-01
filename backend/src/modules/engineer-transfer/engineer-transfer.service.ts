import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as settingsService from "#modules/settings/settings.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as customerStockRepo from "#modules/goods-management/goods-management.repository.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as transferRepo from "./engineer-transfer.repository.js";
import type { CreateTransferInput } from "./engineer-transfer.validation.js";
import type { CreateTransferData, CreateTransferLineData, TransferWithLines } from "./engineer-transfer.repository.js";

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
}

// Resolve name from User (no single `name` field — compose firstName + lastName).
function engineerName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

// Assert that a user exists, is active, and their role canHoldStock.
async function assertEngineer(id: string, label: string): Promise<{ id: string; name: string; email: string }> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound(`${label} engineer not found.`);
  if (user.status !== "active") throw badRequest(`${label} engineer account is not active.`);
  if (!user.role?.canHoldStock) throw badRequest(`${label} user is not a stock-holding engineer.`);
  return { id: user.id, name: engineerName(user), email: user.email };
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
  const lines: CreateTransferLineData[] = [];
  for (const l of input.lines) {
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
      });
    }
  }

  const data: CreateTransferData = {
    code: "", // allocated inside createTransfer
    status: "pending",
    fromEngineerId: fromEng.id,
    fromEngineerName: fromEng.name,
    fromEngineerEmail: fromEng.email,
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

  return toPublic(cancelled);
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
  const publicId = `sig-${t.id}-${Date.now()}`;
  const signatureUrl = await uploadToCloudinary(signatureDataUri, publicId, creds, "senthra/engineer-transfers");

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
  const publicId = `attach-${Date.now()}`;
  const url = await uploadToCloudinary(image, publicId, creds, "senthra/engineer-transfers");
  return { url };
}
