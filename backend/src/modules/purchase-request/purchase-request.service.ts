import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import * as prfRepo from "./purchase-request.repository.js";
import type { PrfLineRow, PurchaseRequestWithRelations } from "./purchase-request.repository.js";
import * as prfEmail from "./purchase-request.email.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { withTransaction } from "../../lib/prisma.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type {
  CreatePurchaseRequestInput,
  PrfAttachmentInput,
  PrfLineInput,
  UpdatePurchaseRequestInput,
} from "./purchase-request.validation.js";
import { incotermLabel } from "#modules/purchase-order/purchase-order.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Status state machine (forward-only; backend-enforced). Two sanctioned reverse edges:
// submitted → draft (Reject for rework) and approved → draft (Reopen for revision — the
// price-revision workflow; an approved PRF is NEVER edited in place). `converted` is terminal
// and READ-ONLY forever: re-procurement goes through cancel-the-PO + Duplicate-as-revision. ──
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = Reject (rework)
  approved: ["converted", "draft", "cancelled"], // → draft = Reopen (revision); → converted via Generate PO
  converted: [],
  cancelled: [],
};
const humanStatus = (s: string) => s.replace(/_/g, " ");
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${humanStatus(from)} purchase request to ${humanStatus(to)}.`);
  }
}

// ── DTO ────────────────────────────────────────────────────────────────────────────────────
export interface PublicPrfSupplier {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTerms: string | null;
  currency: string | null;
  leadTimeDays: number | null;
}
export interface PublicPrfWarehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
}
export interface PublicPrfJob {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
}
export interface PublicPrfItem {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  unitPricePence: number;
  unitPrice: number;
  vatRate: number;
  lineTotalPence: number;
  lineTotal: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string } | null;
}
export interface PublicPrfAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}
export interface PublicPurchaseRequest {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string | null;
  supplier: PublicPrfSupplier | null;
  warehouseId: string;
  warehouse: PublicPrfWarehouse | null;
  jobId: string | null;
  job: PublicPrfJob | null;
  projectRef: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  quoteReference: string | null;
  quoteDate: string | null;
  quoteValidUntil: string | null;
  justification: string | null;
  notes: string | null;
  deliveryTerms: string | null;
  deliveryTermsLabel: string | null;
  paymentTerms: string | null;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  items: PublicPrfItem[];
  attachments: PublicPrfAttachment[];
  // The PO generated from this PRF (at most one), for the linked-PO badge + chain strip.
  purchaseOrder: { id: string; code: string; status: string } | null;
  revisionOfId: string | null;
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  reopenReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  convertedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedPurchaseRequests {
  purchaseRequests: PublicPurchaseRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const pounds = (p: number | null | undefined): number => (p == null ? 0 : p / 100);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function warehouseAddress(w: PurchaseRequestWithRelations["warehouse"]): string | null {
  if (!w) return null;
  const parts = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function toPublic(prf: PurchaseRequestWithRelations): PublicPurchaseRequest {
  const s = prf.supplier;
  const paymentTerms = s ? (s.paymentTerms === "Custom" ? s.customPaymentTerms : s.paymentTerms) : null;
  const linkedPo = prf.purchaseOrders[0] ?? null;
  return {
    id: prf.id,
    code: prf.code,
    supplierId: prf.supplierId,
    supplierName: prf.supplierName,
    supplier: s
      ? {
          id: s.id,
          code: s.code,
          name: s.name,
          contactPerson: s.contactPerson,
          contactEmail: s.contactEmail,
          contactPhone: s.contactPhone,
          paymentTerms: paymentTerms ?? null,
          currency: s.currency ?? "GBP",
          leadTimeDays: s.leadTimeDays,
        }
      : null,
    warehouseId: prf.warehouseId,
    warehouse: prf.warehouse
      ? { id: prf.warehouse.id, code: prf.warehouse.code, name: prf.warehouse.name, address: warehouseAddress(prf.warehouse) }
      : null,
    jobId: prf.jobId,
    job: prf.job ? { id: prf.job.id, jobNumber: prf.job.jobNumber, name: prf.job.name, status: prf.job.status } : null,
    projectRef: prf.projectRef,
    sourceType: prf.sourceType,
    sourceId: prf.sourceId,
    status: prf.status ?? "draft",
    quoteReference: prf.quoteReference,
    quoteDate: iso(prf.quoteDate),
    quoteValidUntil: iso(prf.quoteValidUntil),
    justification: prf.justification,
    notes: prf.notes,
    deliveryTerms: prf.deliveryTerms,
    deliveryTermsLabel: prf.deliveryTerms ? incotermLabel(prf.deliveryTerms) : null,
    paymentTerms: prf.paymentTerms,
    currency: prf.currency ?? "GBP",
    subtotalPence: prf.subtotalPence,
    vatPence: prf.vatPence,
    grandTotalPence: prf.grandTotalPence,
    subtotal: pounds(prf.subtotalPence),
    vatTotal: pounds(prf.vatPence),
    grandTotal: pounds(prf.grandTotalPence),
    items: prf.items.map((i) => ({
      id: i.id,
      irmItemId: i.irmItemId,
      itemName: i.itemName,
      sku: i.sku,
      baseUnit: i.baseUnit,
      quantity: i.quantity,
      unitPricePence: i.unitPricePence,
      unitPrice: pounds(i.unitPricePence),
      vatRate: i.vatRate,
      lineTotalPence: i.lineTotalPence,
      lineTotal: pounds(i.lineTotalPence),
      notes: i.notes,
      irmItem: i.irmItem ? { id: i.irmItem.id, code: i.irmItem.code, name: i.irmItem.name, status: i.irmItem.status } : null,
    })),
    attachments: prf.attachments.map((a) => ({
      id: a.id,
      label: a.label,
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url: a.url,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    purchaseOrder: linkedPo ? { id: linkedPo.id, code: linkedPo.code, status: linkedPo.status } : null,
    revisionOfId: prf.revisionOfId,
    createdBy: prf.createdBy,
    submittedBy: prf.submittedBy,
    submittedAt: iso(prf.submittedAt),
    approvedBy: prf.approvedBy,
    approvedAt: iso(prf.approvedAt),
    rejectionReason: prf.rejectionReason,
    reopenReason: prf.reopenReason,
    cancelledAt: iso(prf.cancelledAt),
    cancelReason: prf.cancelReason,
    convertedAt: iso(prf.convertedAt),
    updatedBy: prf.updatedBy,
    createdAt: prf.createdAt.toISOString(),
    updatedAt: prf.updatedAt.toISOString(),
  };
}

// ── Financials (server-authoritative, integer pence — identical maths to the PO module) ─────
export function computeTotals(lines: { quantity: number; unitPricePence: number; vatRate: number }[]): prfRepo.PrfTotals {
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPricePence; // ex-VAT
    subtotal += lineTotal;
    vat += Math.round((lineTotal * l.vatRate) / 100);
  }
  return { subtotalPence: subtotal, vatPence: vat, grandTotalPence: subtotal + vat };
}

// Validate each line's IRM item is ACTIVE, snapshot its name/sku/unit, and compute the line total.
async function buildLineRows(items: PrfLineInput[]): Promise<PrfLineRow[]> {
  // One batched active-item validation for the whole set (not N sequential lookups).
  const itemsById = await irmService.requireActiveIrmItems(items.map((l) => l.irmItemId));
  const rows: PrfLineRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const item = itemsById.get(line.irmItemId)!; // guaranteed present + active by requireActiveIrmItems
    const vatRate = line.vatRate ?? item.vatRatePercent ?? 0;
    rows.push({
      irmItemId: line.irmItemId,
      itemName: item.name,
      sku: item.sku ?? null,
      baseUnit: item.baseUnit ?? null,
      quantity: line.quantity,
      unitPricePence: line.unitPricePence,
      vatRate,
      lineTotalPence: line.quantity * line.unitPricePence,
      sortOrder: i,
      notes: trimToNull(line.notes),
    });
  }
  return rows;
}

// Validate an optional job link (must exist and not be soft-deleted). Returns the id or null.
async function resolveJobId(jobId: string | null | undefined): Promise<string | null> {
  if (!jobId) return null;
  const job = await jobRepo.findById(jobId);
  if (!job) throw badRequest("Selected job no longer exists.");
  return jobId;
}

export interface ListPurchaseRequestsParams {
  search?: string;
  status?: string;
  statuses?: string[];
  supplier?: string;
  warehouse?: string;
  job?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listPurchaseRequests(params: ListPurchaseRequestsParams = {}, actor?: AuditActor): Promise<PagedPurchaseRequests> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = {
    search: params.search,
    status: params.status,
    statuses: params.statuses,
    supplierId: params.supplier,
    warehouseId: params.warehouse,
    jobId: params.job,
    warehouseIds: warehouseScopeFilter(actor),
  };
  const total = await prfRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await prfRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { purchaseRequests: rows.map(toPublic), total, page, pageSize, totalPages };
}

export async function getPurchaseRequest(idOrCode: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = OBJECT_ID_RE.test(idOrCode) ? await prfRepo.findById(idOrCode) : await prfRepo.findByCode(idOrCode);
  if (!prf) throw notFound("Purchase request not found.");
  if (prf.warehouseId) assertWarehouseAccess(actor, prf.warehouseId);
  return toPublic(prf);
}

export async function createPurchaseRequest(input: CreatePurchaseRequestInput, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
  const supplier = await supplierService.requireActiveSupplier(input.supplierId);
  await warehouseService.requireActiveWarehouse(input.warehouseId);
  const jobId = await resolveJobId(input.jobId);
  const lineRows = await buildLineRows(input.items);
  const totals = computeTotals(lineRows);
  const actorLabel = actor?.email ?? null;

  const created = await prfRepo.createWithCode(
    {
      supplierId: input.supplierId,
      supplierName: supplier.name,
      warehouseId: input.warehouseId,
      jobId,
      projectRef: trimToNull(input.projectRef),
      status: "draft",
      quoteReference: trimToNull(input.quoteReference),
      quoteDate: input.quoteDate ? new Date(input.quoteDate) : null,
      quoteValidUntil: input.quoteValidUntil ? new Date(input.quoteValidUntil) : null,
      justification: trimToNull(input.justification),
      notes: trimToNull(input.notes),
      deliveryTerms: input.deliveryTerms ?? null,
      paymentTerms: trimToNull(input.paymentTerms),
      currency: "GBP",
      ...totals,
      createdBy: actorLabel,
      updatedBy: actorLabel,
    },
    lineRows,
  );
  audit.record({ actor, action: "purchase_request.created", targetType: "purchase_request", targetId: created.id, targetLabel: created.code });
  return toPublic(created);
}

export async function updatePurchaseRequest(id: string, input: UpdatePurchaseRequestInput, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const existing = await prfRepo.findById(id);
  if (!existing) throw notFound("Purchase request not found.");
  if (existing.warehouseId) assertWarehouseAccess(actor, existing.warehouseId);
  // EDITABLE ONLY IN DRAFT — supplier/warehouse/quantities/prices/header all lock once submitted.
  if (existing.status !== "draft") {
    throw conflict("Only draft purchase requests can be edited. Reject or reopen it back to draft first.");
  }

  const headerPatch: Prisma.PurchaseRequestUncheckedUpdateInput = { updatedBy: actor?.email ?? null };

  if (input.supplierId !== undefined && input.supplierId !== existing.supplierId) {
    const s = await supplierService.requireActiveSupplier(input.supplierId);
    headerPatch.supplierId = input.supplierId;
    headerPatch.supplierName = s.name;
  }
  if (input.warehouseId !== undefined && input.warehouseId !== existing.warehouseId) {
    if (input.warehouseId) assertWarehouseAccess(actor, input.warehouseId);
    await warehouseService.requireActiveWarehouse(input.warehouseId);
    headerPatch.warehouseId = input.warehouseId;
  }
  if (input.jobId !== undefined) headerPatch.jobId = await resolveJobId(input.jobId);
  if (input.projectRef !== undefined) headerPatch.projectRef = trimToNull(input.projectRef);
  if (input.quoteReference !== undefined) headerPatch.quoteReference = trimToNull(input.quoteReference);
  if (input.quoteDate !== undefined) headerPatch.quoteDate = input.quoteDate ? new Date(input.quoteDate) : null;
  if (input.quoteValidUntil !== undefined) headerPatch.quoteValidUntil = input.quoteValidUntil ? new Date(input.quoteValidUntil) : null;
  if (input.justification !== undefined) headerPatch.justification = trimToNull(input.justification);
  if (input.notes !== undefined) headerPatch.notes = trimToNull(input.notes);
  if (input.deliveryTerms !== undefined) headerPatch.deliveryTerms = input.deliveryTerms ?? null;
  if (input.paymentTerms !== undefined) headerPatch.paymentTerms = trimToNull(input.paymentTerms);

  let result: PurchaseRequestWithRelations;
  if (input.items !== undefined) {
    const lineRows = await buildLineRows(input.items);
    const totals = computeTotals(lineRows);
    result = await prfRepo.replaceItemsAndTotals(id, lineRows, totals, headerPatch);
  } else {
    result = await prfRepo.update(id, headerPatch);
  }
  audit.record({ actor, action: "purchase_request.updated", targetType: "purchase_request", targetId: id, targetLabel: result.code });
  return toPublic(result);
}

// ── Workflow actions (each transition-guarded + stamped + audited) ───────────────────────────
async function loadOrThrow(id: string, actor?: AuditActor): Promise<PurchaseRequestWithRelations> {
  const prf = await prfRepo.findById(id);
  if (!prf) throw notFound("Purchase request not found.");
  if (prf.warehouseId) assertWarehouseAccess(actor, prf.warehouseId);
  return prf;
}
function recordStatus(actor: AuditActor | undefined, id: string, code: string, action: string, metadata?: Record<string, unknown>): void {
  audit.record({ actor, action, targetType: "purchase_request", targetId: id, targetLabel: code, metadata });
}

export async function submitPurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "submitted");
  if (prf.items.length === 0) throw badRequest("Add at least one item before submitting.");
  const updated = await prfRepo.update(id, { status: "submitted", submittedBy: actor?.email ?? null, submittedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_request.submitted");
  // Fire-and-forget: notify the finance reviewers a PRF awaits their decision. NEVER blocks.
  void prfEmail.notifyReviewersPrfSubmitted(updated, actor?.email ?? null).catch((e) =>
    console.error(`PRF ${updated.code} review notification failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function approvePurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "approved");
  const updated = await prfRepo.update(id, { status: "approved", approvedBy: actor?.email ?? null, approvedAt: new Date() });
  recordStatus(actor, id, updated.code, "purchase_request.approved");
  void prfEmail.notifyRequesterPrfDecision(updated, "approved").catch((e) =>
    console.error(`PRF ${updated.code} approval email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

export async function rejectPurchaseRequest(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "submitted") {
    throw conflict(`Only a submitted purchase request can be rejected (this one is ${humanStatus(prf.status)}).`);
  }
  // Clear any prior reopenReason so the detail page never shows a stale reason from an earlier cycle.
  const updated = await prfRepo.update(id, { status: "draft", rejectionReason: reason.trim(), reopenReason: null });
  recordStatus(actor, id, updated.code, "purchase_request.rejected", { reason: reason.trim() });
  void prfEmail.notifyRequesterPrfDecision(updated, "rejected", reason).catch((e) =>
    console.error(`PRF ${updated.code} rejection email failed:`, e instanceof Error ? e.message : e),
  );
  return toPublic(updated);
}

// Reopen-for-revision: the ONLY way an approved PRF changes (price-revision workflow). Clears the
// approval stamps and drops back to draft with the reason on record — the full review runs again.
export async function reopenPurchaseRequest(id: string, reason: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "approved") {
    throw conflict(`Only a finance-approved purchase request can be reopened for revision (this one is ${humanStatus(prf.status)}).`);
  }
  const updated = await prfRepo.update(id, {
    status: "draft",
    approvedBy: null,
    approvedAt: null,
    reopenReason: reason.trim(),
    // Clear any prior rejectionReason so the two reason fields never show a contradictory pair.
    rejectionReason: null,
    updatedBy: actor?.email ?? null,
  });
  recordStatus(actor, id, updated.code, "purchase_request.reopened", { reason: reason.trim() });
  return toPublic(updated);
}

export async function cancelPurchaseRequest(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "cancelled");
  const cancelReason = trimToNull(reason);
  const updated = await prfRepo.update(id, { status: "cancelled", cancelledAt: new Date(), cancelReason });
  // Carry the reason into the audit metadata (parity with reject + the PO cancel audit).
  recordStatus(actor, id, updated.code, "purchase_request.cancelled", { reason: cancelReason ?? undefined });
  return toPublic(updated);
}

export async function deletePurchaseRequest(id: string, actor?: AuditActor): Promise<void> {
  const prf = await loadOrThrow(id, actor);
  if (prf.status !== "draft") throw conflict("Only draft purchase requests can be deleted.");
  await prfRepo.softDelete(id);
  audit.record({ actor, action: "purchase_request.deleted", targetType: "purchase_request", targetId: id, targetLabel: prf.code });
}

// ── Convert: generate the Purchase Order from a finance-approved PRF ─────────────────────────
// ONE PO per PRF, forever. The whole conversion is a single all-or-nothing transaction: the PRF's
// approved status is re-checked INSIDE the transaction (a concurrent second convert sees
// `converted` and fails), the PO code is allocated in-tx (rollback reclaims the number), the
// lines are copied VERBATIM from the reviewed PRF (finance approved THOSE snapshots + prices —
// nothing is re-snapshotted), the quotation attachments are copied onto the PO (same Cloudinary
// URLs), and the PRF flips to `converted` (read-only forever). The PO lands in `draft` so Finance
// can complete delivery address/terms; the commercial-equality fast-path in the PO service then
// lets it go draft → approved without a second review — unless it diverged.
export interface ConvertResult {
  purchaseRequest: PublicPurchaseRequest;
  purchaseOrderId: string;
  purchaseOrderCode: string;
}

export async function convertPurchaseRequest(id: string, actor?: AuditActor): Promise<ConvertResult> {
  const prf = await loadOrThrow(id, actor);
  assertTransition(prf.status, "converted"); // clear pre-check (the tx re-checks authoritatively)
  const supplier = await supplierService.requireActiveSupplier(prf.supplierId);
  await warehouseService.requireActiveWarehouse(prf.warehouseId);
  // Every line's item must still be active — a PO must never be issued for a retired item.
  await irmService.requireActiveIrmItems(prf.items.map((l) => l.irmItemId));

  const actorLabel = actor?.email ?? null;
  const internalParts: string[] = [];
  if (prf.justification) internalParts.push(`PRF ${prf.code} justification: ${prf.justification}`);
  if (prf.notes) internalParts.push(`PRF ${prf.code} notes: ${prf.notes}`);

  let poId = "";
  let poCode = "";
  let attempt = 0;
  for (; attempt < 5; attempt++) {
    await poRepo.ensurePoCounter();
    try {
      await withTransaction(async (tx) => {
        const live = await prfRepo.findForConvertTx(tx, id);
        if (!live) throw notFound("Purchase request not found.");
        if (live.status !== "approved") {
          throw conflict(`This purchase request is ${humanStatus(live.status)} and can no longer be converted.`);
        }
        poCode = await poRepo.allocatePoCodeTx(tx);
        const lines = live.items.map((l, i) => ({
          irmItemId: l.irmItemId,
          itemName: l.itemName,
          sku: l.sku,
          baseUnit: l.baseUnit,
          quantity: l.quantity,
          unitPricePence: l.unitPricePence,
          vatRate: l.vatRate,
          lineTotalPence: l.lineTotalPence,
          sortOrder: i,
          notes: l.notes,
        }));
        poId = await poRepo.createPoTx(
          tx,
          {
            supplierId: live.supplierId,
            supplierName: supplier.name,
            warehouseId: live.warehouseId,
            purchaseRequestId: live.id,
            jobId: live.jobId,
            projectRef: live.projectRef,
            status: "draft",
            priority: "normal",
            referenceNumber: live.quoteReference,
            orderDate: new Date(),
            currency: "GBP",
            ...computeTotals(lines),
            // Carry the commercial terms captured on the PRF onto the PO. Payment term falls back
            // to the supplier's standing default when the PRF left it blank.
            deliveryTerms: live.deliveryTerms,
            paymentTerms:
              live.paymentTerms ??
              (supplier.paymentTerms === "Custom" ? (supplier.customPaymentTerms ?? null) : (supplier.paymentTerms ?? null)),
            internalNotes: internalParts.length ? internalParts.join("\n\n") : null,
            createdBy: actorLabel,
            updatedBy: actorLabel,
          },
          poCode,
          lines,
          live.attachments.map((a) => ({
            label: a.label,
            fileName: a.fileName,
            fileType: a.fileType,
            fileSizeBytes: a.fileSizeBytes,
            url: a.url,
            uploadedBy: a.uploadedBy,
          })),
        );
        await prfRepo.setConvertedTx(tx, id, actorLabel);
      });
      break;
    } catch (e) {
      if (poRepo.isPoCodeConflict(e)) {
        await poRepo.fastForwardPoCounter();
        continue;
      }
      if (poRepo.isPoWriteConflict(e)) continue; // transient — retry the whole transaction
      throw e;
    }
  }
  // Exhausted retries — could be repeated code collisions OR transient Mongo write-conflicts under
  // contention. Use a message that covers both so support isn't sent down a code-collision-only path.
  if (attempt >= 5) throw conflict("Couldn't generate the purchase order due to high contention. Please try again.");

  recordStatus(actor, id, prf.code, "purchase_request.converted", { purchaseOrderId: poId, purchaseOrderCode: poCode });
  audit.record({
    actor,
    action: "purchase_order.created",
    targetType: "purchase_order",
    targetId: poId,
    targetLabel: poCode,
    metadata: { purchaseRequestId: id, purchaseRequestCode: prf.code },
  });
  const fresh = await prfRepo.findById(id);
  return { purchaseRequest: toPublic(fresh ?? prf), purchaseOrderId: poId, purchaseOrderCode: poCode };
}

// ── Duplicate-as-revision (price-revision workflow, post-conversion) ─────────────────────────
// A converted PRF is read-only forever, and one-PO-per-PRF always holds. When the supplier
// revises a quote after conversion: cancel the PO (existing flow), then duplicate — a prefilled
// DRAFT copy linked via revisionOfId that goes through the full review cycle again.
export async function duplicatePurchaseRequest(id: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const original = await loadOrThrow(id, actor);
  if (original.status !== "converted") {
    throw conflict("Only a converted purchase request can be duplicated as a revision — edit or resubmit a pre-conversion one instead.");
  }
  const supplier = await supplierService.requireActiveSupplier(original.supplierId);
  await warehouseService.requireActiveWarehouse(original.warehouseId);
  await irmService.requireActiveIrmItems(original.items.map((l) => l.irmItemId));
  const actorLabel = actor?.email ?? null;

  const created = await prfRepo.createWithCode(
    {
      supplierId: original.supplierId,
      supplierName: supplier.name,
      warehouseId: original.warehouseId,
      jobId: original.jobId,
      projectRef: original.projectRef,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      status: "draft",
      quoteReference: original.quoteReference,
      quoteDate: original.quoteDate,
      quoteValidUntil: original.quoteValidUntil,
      justification: original.justification,
      notes: original.notes,
      deliveryTerms: original.deliveryTerms,
      paymentTerms: original.paymentTerms,
      currency: "GBP",
      subtotalPence: original.subtotalPence,
      vatPence: original.vatPence,
      grandTotalPence: original.grandTotalPence,
      revisionOfId: original.id,
      createdBy: actorLabel,
      updatedBy: actorLabel,
    },
    original.items.map((l, i) => ({
      irmItemId: l.irmItemId,
      itemName: l.itemName,
      sku: l.sku,
      baseUnit: l.baseUnit,
      quantity: l.quantity,
      unitPricePence: l.unitPricePence,
      vatRate: l.vatRate,
      lineTotalPence: l.lineTotalPence,
      sortOrder: i,
      notes: l.notes,
    })),
  );
  audit.record({
    actor,
    action: "purchase_request.created",
    targetType: "purchase_request",
    targetId: created.id,
    targetLabel: created.code,
    metadata: { revisionOf: original.code },
  });
  return toPublic(created);
}

// ── Attachments (draft-only — a PRF is editable ONLY in draft, attachments included) ─────────
function assertEditable(status: string): void {
  if (status !== "draft") {
    throw conflict("Attachments can only be changed on a draft purchase request.");
  }
}

export async function addAttachment(prfId: string, input: PrfAttachmentInput, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(prfId, actor);
  assertEditable(prf.status);
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("File uploads aren't configured. Add Cloudinary credentials in Settings first.");
  const url = await uploadFileToCloudinary(input.data, randomUUID(), creds);
  await prfRepo.addAttachment({
    purchaseRequestId: prfId,
    label: trimToNull(input.label),
    fileName: input.fileName.trim(),
    fileType: input.fileType,
    fileSizeBytes: input.fileSizeBytes,
    url,
    uploadedBy: actor?.email ?? null,
  });
  audit.record({ actor, action: "purchase_request.attachment_added", targetType: "purchase_request", targetId: prfId, targetLabel: prf.code });
  return getPurchaseRequest(prfId, actor);
}

export async function removeAttachment(prfId: string, attachmentId: string, actor?: AuditActor): Promise<PublicPurchaseRequest> {
  const prf = await loadOrThrow(prfId, actor);
  assertEditable(prf.status);
  const att = await prfRepo.findAttachment(attachmentId);
  if (!att || att.purchaseRequestId !== prfId) throw notFound("Attachment not found.");
  await prfRepo.removeAttachment(attachmentId);
  audit.record({ actor, action: "purchase_request.attachment_removed", targetType: "purchase_request", targetId: prfId, targetLabel: prf.code });
  return getPurchaseRequest(prfId, actor);
}
