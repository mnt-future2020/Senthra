import { Prisma, type PurchaseRequest, type PurchaseRequestAttachment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for Purchase Requests (PRF). The ONLY place Prisma is touched for PRFs.
// Soft-deleted PRFs (deletedAt set) are excluded from normal reads. Header + lines + totals are
// written atomically (withTransaction) so a PRF can never persist with stale totals or
// half-written lines. Mirrors purchase-order.repository throughout.

// Supplier slice for the read-only "Supplier Information" section (same slice as the PO's).
const supplierSelect = {
  id: true,
  code: true,
  name: true,
  contactPerson: true,
  contactEmail: true,
  contactPhone: true,
  paymentTerms: true,
  customPaymentTerms: true,
  currency: true,
  leadTimeDays: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
} satisfies Prisma.SupplierSelect;

const warehouseSelect = {
  id: true,
  code: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
} satisfies Prisma.WarehouseSelect;

const jobSelect = { id: true, jobNumber: true, name: true, status: true } satisfies Prisma.JobSelect;

/**
 * A purchase order that still exists.
 *
 * Mongo: a row whose create omitted the field does not match `{ deletedAt: null }`, so both shapes
 * have to be asked for.
 */
const LIVE_PO = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } satisfies Prisma.PurchaseOrderWhereInput;

const withRelations = {
  supplier: { select: supplierSelect },
  warehouse: { select: warehouseSelect },
  job: { select: jobSelect },
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { irmItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  rentalItems: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { rentalItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  attachments: { orderBy: { createdAt: "asc" } },
  // The PO generated from this PRF (at most one — see the schema note) for the linked-PO
  // badge + procurement-chain strip.
  //
  // LIVE ONLY. Without the filter a soft-deleted purchase order kept being returned here, so the
  // request rendered a "View PO-0051" button whose target the PO loader refuses — one click to a
  // "Purchase order not found." page, with nothing on the request saying the order was deleted.
  // Mongo: a row whose create omitted the field does not match `{ deletedAt: null }`, so both
  // shapes have to be asked for.
  purchaseOrders: { where: LIVE_PO, select: { id: true, code: true, status: true } },
} satisfies Prisma.PurchaseRequestInclude;

// Exported so the include above can be pinned by a test: dropping the `where` is a silent
// regression — everything still compiles and every read still returns a row.
export { LIVE_PO, withRelations };

export type PurchaseRequestWithRelations = Prisma.PurchaseRequestGetPayload<{ include: typeof withRelations }>;

// The scalar fields written to a line (snapshots + computed total).
export interface PrfLineRow {
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  unitPricePence: number;
  vatRate: number;
  lineTotalPence: number;
  sortOrder: number;
  notes: string | null;
}

// The scalar fields written to a RENTAL line. Separate from PrfLineRow because a hire carries a
// period and a delivery address an IRM line has no place for.
export interface PrfRentalLineRow {
  rentalItemId: string;
  itemName: string;
  baseUnit: string | null;
  quantity: number;
  hireStartDate: Date;
  hireEndDate: Date;
  notifyDaysBefore: number;
  deliveryAddress: string | null;
  ratePeriod: string;
  ratePence: number | null;
  priceOverridden: boolean;
  returnMode: string;
  returnAddress: string | null;
  unitPricePence: number;
  vatRate: number;
  lineTotalPence: number;
  sortOrder: number;
  notes: string | null;
}

export interface PrfTotals {
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
}

/**
 * "Rejected — needs rework": a PRF sent back to its author, not just any draft.
 *
 * Rejection moves the row to `draft` and stamps the reason, so the reason is what distinguishes a
 * returned request from one nobody has submitted yet. Defined ONCE and shared by the badge count and
 * the list the badge opens — the counterpart of RECEIVABLE_PO_STATUSES on purchase orders.
 *
 * Sharing it is the whole point. The count already used this predicate while the badge's href pointed
 * at `?status=draft`, so "Rejected — needs rework · 3" opened every draft in the module, including
 * ones the reader had just created. Two spellings of one question is how that gap opens; there is now
 * only one.
 */
export const reworkPrfWhere = (): Prisma.PurchaseRequestWhereInput => ({
  status: "draft",
  // `not: null` is $ne, which excludes null AND missing — the right direction here: we want rows that
  // HAVE a reason, so an absent field must not match.
  rejectionReason: { not: null },
});

export interface PurchaseRequestListFilters {
  search?: string;
  /** a real status, or the DERIVED pseudo-status "rework" (see buildWhere) */
  status?: string;
  statuses?: string[];
  supplierId?: string;
  warehouseId?: string;
  jobId?: string;
  // Warehouse-access scope (from warehouseScopeFilter): `undefined` = unrestricted.
  warehouseIds?: string[];
}

// Exported for unit testing — pure where-clause builder, no Prisma I/O.
export function buildWhere(filters: PurchaseRequestListFilters): Prisma.PurchaseRequestWhereInput {
  const where: Prisma.PurchaseRequestWhereInput = { deletedAt: null };
  if (filters.statuses?.length) where.status = { in: filters.statuses };
  else if (filters.status === "rework") {
    // DERIVED pseudo-status, never stored — see reworkPrfWhere. AND'd so it composes with (and can't
    // be clobbered by) the search OR further down, the same shape the PO list uses.
    where.AND = [reworkPrfWhere()];
  } else if (filters.status) where.status = filters.status;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters.jobId) where.jobId = filters.jobId;
  if (filters.warehouseIds !== undefined) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { warehouseId: { in: filters.warehouseIds } }];
  }
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { quoteReference: { contains: q, mode: "insensitive" } },
      { projectRef: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.PurchaseRequestOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(
  filters: PurchaseRequestListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<PurchaseRequestWithRelations[]> {
  return prisma.purchaseRequest.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}

export function count(filters: PurchaseRequestListFilters = {}): Promise<number> {
  return prisma.purchaseRequest.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<PurchaseRequestWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.purchaseRequest.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<PurchaseRequestWithRelations | null> {
  return prisma.purchaseRequest.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

/**
 * Return a request to `approved` because the purchase order generated from it was deleted.
 *
 * CONDITIONAL on the status, not a plain update: the affected-row count is what decides whether THIS
 * call was the one that moved it. Two deletes arriving together, or a delete racing a re-conversion,
 * would otherwise both "succeed" and both write an audit entry claiming the move.
 *
 * `converted` is the only status that can come back this way. A cancelled or already-approved
 * request is left exactly where it is.
 */
export async function revertConversion(id: string, actorEmail: string | null): Promise<boolean> {
  const { count } = await prisma.purchaseRequest.updateMany({
    where: { id, status: "converted", deletedAt: null },
    data: { status: "approved", updatedBy: actorEmail },
  });
  return count === 1;
}

// Generic header update — used by the workflow actions (status/timestamps/actor). NEVER used to
// change lines; line edits go through replaceItemsAndTotals.
export function update(id: string, data: Prisma.PurchaseRequestUncheckedUpdateInput): Promise<PurchaseRequestWithRelations> {
  return prisma.purchaseRequest.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<PurchaseRequest> {
  return prisma.purchaseRequest.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Replace ALL line rows + recompute the header totals, atomically (draft edit).
export async function replaceItemsAndTotals(
  prfId: string,
  lines: PrfLineRow[],
  totals: PrfTotals,
  headerPatch: Prisma.PurchaseRequestUncheckedUpdateInput,
  rentalLines: PrfRentalLineRow[] = [],
): Promise<PurchaseRequestWithRelations> {
  return withTransaction(async (tx) => {
    await tx.purchaseRequestItem.deleteMany({ where: { purchaseRequestId: prfId } });
    await tx.purchaseRequestRentalLine.deleteMany({ where: { purchaseRequestId: prfId } });
    if (lines.length) await tx.purchaseRequestItem.createMany({ data: lines.map((l) => ({ purchaseRequestId: prfId, ...l })) });
    if (rentalLines.length)
      await tx.purchaseRequestRentalLine.createMany({ data: rentalLines.map((l) => ({ purchaseRequestId: prfId, ...l })) });
    await tx.purchaseRequest.update({ where: { id: prfId }, data: { ...headerPatch, ...totals } });
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id: prfId }, include: withRelations });
  });
}

// --- delete-guard counters (used by Supplier / Warehouse delete guards) ----------------------
export function countBySupplier(supplierId: string): Promise<number> {
  return prisma.purchaseRequest.count({ where: { supplierId, deletedAt: null } });
}
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.purchaseRequest.count({ where: { warehouseId, deletedAt: null } });
}
export function countByJob(jobId: string): Promise<number> {
  return prisma.purchaseRequest.count({ where: { jobId, deletedAt: null } });
}

// --- convert seam (tx-aware; called only from the PRF-conversion transaction) ----------------
// Re-read the PRF INSIDE the transaction so the status guard + copied lines/attachments can't
// race a concurrent edit or a second convert click (both would see `converted` and fail).
export function findForConvertTx(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseRequest.findFirst({
    where: { id, deletedAt: null },
    include: {
      items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      rentalItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      attachments: true,
    },
  });
}
export function setConvertedTx(tx: Prisma.TransactionClient, id: string, updatedBy: string | null) {
  return tx.purchaseRequest.update({
    where: { id },
    data: { status: "converted", convertedAt: new Date(), updatedBy },
  });
}

// --- attachments ----------------------------------------------------------------------------
export function addAttachment(
  data: Prisma.PurchaseRequestAttachmentUncheckedCreateInput,
  tx?: Prisma.TransactionClient,
): Promise<PurchaseRequestAttachment> {
  // `tx` is passed by the direct-upload finalize, which commits this row and the removal of its
  // pending-upload ledger entry together.
  return (tx ?? prisma).purchaseRequestAttachment.create({ data });
}
export function findAttachment(id: string): Promise<PurchaseRequestAttachment | null> {
  return prisma.purchaseRequestAttachment.findUnique({ where: { id } });
}
export function removeAttachment(id: string): Promise<PurchaseRequestAttachment> {
  return prisma.purchaseRequestAttachment.delete({ where: { id } });
}

// --- code allocation (atomic Counter, prefix "PRF") ------------------------------------------
const PRF_CODE_PREFIX = "PRF";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

async function highestPrfNumber(): Promise<number> {
  const head = `${PRF_CODE_PREFIX}-`;
  const rows = await prisma.purchaseRequest.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: PRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestPrfNumber();
  try {
    await prisma.counter.create({ data: { key: PRF_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({ where: { key: PRF_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestPrfNumber();
  await prisma.counter.upsert({ where: { key: PRF_CODE_PREFIX }, create: { key: PRF_CODE_PREFIX, seq: max }, update: { seq: max } });
}

// Create a PRF (header + lines + totals) atomically with a freshly-allocated, collision-safe code.
export async function createWithCode(
  header: Omit<Prisma.PurchaseRequestUncheckedCreateInput, "code">,
  lines: PrfLineRow[],
  rentalLines: PrfRentalLineRow[] = [],
): Promise<PurchaseRequestWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${PRF_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        // Persist deletedAt as an explicit null (not absent) — Prisma+Mongo's `{ deletedAt: null }`
        // read filter does NOT match documents where the field is missing. Mirrors poRepo.createWithCode.
        const prf = await tx.purchaseRequest.create({ data: { deletedAt: null, ...header, code } });
        if (lines.length) await tx.purchaseRequestItem.createMany({ data: lines.map((l) => ({ purchaseRequestId: prf.id, ...l })) });
        if (rentalLines.length)
          await tx.purchaseRequestRentalLine.createMany({ data: rentalLines.map((l) => ({ purchaseRequestId: prf.id, ...l })) });
        return tx.purchaseRequest.findUniqueOrThrow({ where: { id: prf.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique purchase-request code.");
}

// --- Reorder-workbench READ seam --------------------------------------------------------------
// Quantity already sitting on OPEN (draft/submitted/approved) PRFs per item × warehouse, keyed
// "irmItemId|warehouseId". Converted/cancelled PRFs don't count (converted stock shows up as
// incoming on the generated PO instead — counting both would double-net). warehouseId + status live
// on the PARENT PurchaseRequest, so this is a findMany + relation-select reduced in memory.
export async function openQuantitiesByItemWarehouse(): Promise<Map<string, number>> {
  const lines = await prisma.purchaseRequestItem.findMany({
    where: { purchaseRequest: { is: { status: { in: ["draft", "submitted", "approved"] }, deletedAt: null } } },
    select: { irmItemId: true, quantity: true, purchaseRequest: { select: { warehouseId: true } } },
  });
  const map = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.irmItemId}|${l.purchaseRequest.warehouseId}`;
    map.set(key, (map.get(key) ?? 0) + l.quantity);
  }
  return map;
}

// --- Dashboard read-models — not a generic reporting API (read-only; warehouse-scoped where applicable) ---

/** Count of PRFs awaiting Finance review. */
export async function countSubmitted(warehouseIds?: string[]): Promise<number> {
  return prisma.purchaseRequest.count({
    where: { status: "submitted", deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
  });
}

// Attention counts — the PRF states where a HUMAN still owes an action. `rework` is the reject path:
// there is no "rejected" status (reject sends submitted → draft), so a rejected request is a draft
// carrying a rejectionReason. Converted/cancelled are terminal and deliberately absent.
export async function countAttention(warehouseIds?: string[]): Promise<{
  awaitingApproval: number;
  awaitingConversion: number;
  rework: number;
}> {
  const scoped = { deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) };
  const [awaitingApproval, awaitingConversion, rework] = await Promise.all([
    prisma.purchaseRequest.count({ where: { status: "submitted", ...scoped } }),
    prisma.purchaseRequest.count({ where: { status: "approved", ...scoped } }),
    // Same predicate the `?status=rework` list filters on, so the badge and that list are one set.
    prisma.purchaseRequest.count({ where: { ...reworkPrfWhere(), ...scoped } }),
  ]);
  return { awaitingApproval, awaitingConversion, rework };
}

/** createdAt of PRFs created since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date }>> {
  const rows = await prisma.purchaseRequest.findMany({
    where: { createdAt: { gte: since }, deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    select: { createdAt: true },
  });
  return rows.map((r) => ({ at: r.createdAt }));
}

/** Submitted PRFs for the worklist. PRF has no priority/title — label with the supplier snapshot. */
export async function submittedWorklist(
  warehouseIds?: string[],
): Promise<Array<{ id: string; code: string; title: string | null; priority: string | null; createdAt: Date }>> {
  const rows = await prisma.purchaseRequest.findMany({
    where: { status: "submitted", deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    select: { id: true, code: true, supplierName: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50, // per-queue cap — oldest-first keeps the actionable head; the service re-caps the merge
  });
  // Keep the {id, code, title, priority, createdAt} shape stable — the service depends on it;
  // title = supplierName snapshot, priority = null (PRF carries neither field).
  return rows.map((r) => ({ id: r.id, code: r.code, title: r.supplierName, priority: null, createdAt: r.createdAt }));
}
