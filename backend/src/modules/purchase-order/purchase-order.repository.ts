import { Prisma, type PurchaseOrder, type PurchaseOrderAttachment } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for Purchase Orders. The ONLY place Prisma is touched for POs. Soft-deleted
// POs (deletedAt set) are excluded from normal reads. Header + lines + totals are written
// atomically (withTransaction) so a PO can never persist with stale totals or half-written lines.

// Supplier slice for the read-only "Supplier Information" section + the PO document's
// Supplier block (postal address). Additive — the public DTO ignores the address fields.
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

const withRelations = {
  supplier: { select: supplierSelect },
  warehouse: { select: warehouseSelect },
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { irmItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  attachments: { orderBy: { createdAt: "asc" } },
  // Procurement-chain slices: the source PRF, the optional job, and the GRNs received against
  // this PO — compact selects only (the detail chain strip + linked badges render from these).
  purchaseRequest: { select: { id: true, code: true, status: true } },
  job: { select: { id: true, jobNumber: true, name: true, status: true } },
  goodsReceipts: { select: { id: true, code: true, status: true, receivedDate: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.PurchaseOrderInclude;

export type PurchaseOrderWithRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof withRelations }>;

// The scalar fields written to a line (snapshots + computed total; receivedQuantity defaults 0).
export interface PoLineRow {
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

export interface PoTotals {
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
}

export interface PurchaseOrderListFilters {
  search?: string;
  status?: string;
  // Multiple statuses (e.g. the warehouse "Expected deliveries" worklist wants sent +
  // partially_received in one query). Takes precedence over `status` when non-empty.
  statuses?: string[];
  priority?: string;
  supplierId?: string;
  warehouseId?: string;
  // The assigned PM — feeds the "Awaiting my action" worklist (pm_review + pmUserId = me).
  pmUserId?: string;
  jobId?: string;
  // Warehouse-access scope (from warehouseScopeFilter): `undefined` = unrestricted (no filter);
  // an array constrains the list to POs delivering to those warehouses. NOTE: a scoped actor only
  // ever sees POs WITH a warehouseId in their set — POs whose warehouseId is still null (header not
  // yet assigned) are excluded from a scoped user's list. That's acceptable: unassigned POs aren't
  // "theirs" until a warehouse is set. Unrestricted actors are entirely unaffected.
  warehouseIds?: string[];
}

// Exported for unit testing — pure where-clause builder, no Prisma I/O.
export function buildWhere(filters: PurchaseOrderListFilters): Prisma.PurchaseOrderWhereInput {
  const where: Prisma.PurchaseOrderWhereInput = { deletedAt: null };
  if (filters.statuses?.length) where.status = { in: filters.statuses };
  else if (filters.status) where.status = filters.status;
  if (filters.priority) where.priority = filters.priority;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters.pmUserId) where.pmUserId = filters.pmUserId;
  if (filters.jobId) where.jobId = filters.jobId;
  // Warehouse-access scoping — AND with any explicit warehouse filter above. When a scoped actor
  // also filters by a specific warehouse, both must hold (an out-of-scope pick correctly matches none).
  if (filters.warehouseIds !== undefined) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { warehouseId: { in: filters.warehouseIds } }];
  }
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { referenceNumber: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.PurchaseOrderOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "code":
      return { code: "asc" };
    case "expected":
      return { expectedDeliveryDate: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(
  filters: PurchaseOrderListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<PurchaseOrderWithRelations[]> {
  return prisma.purchaseOrder.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}

export function count(filters: PurchaseOrderListFilters = {}): Promise<number> {
  return prisma.purchaseOrder.count({ where: buildWhere(filters) });
}

export function findById(id: string): Promise<PurchaseOrderWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}

export function findByCode(code: string): Promise<PurchaseOrderWithRelations | null> {
  return prisma.purchaseOrder.findFirst({ where: { code, deletedAt: null }, include: withRelations });
}

// Generic header update — used by the workflow actions (status/timestamps/actor). NEVER used to
// change lines; line edits go through replaceItemsAndTotals.
export function update(id: string, data: Prisma.PurchaseOrderUncheckedUpdateInput): Promise<PurchaseOrderWithRelations> {
  return prisma.purchaseOrder.update({ where: { id }, data, include: withRelations });
}

export function softDelete(id: string): Promise<PurchaseOrder> {
  return prisma.purchaseOrder.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Replace ALL line rows + recompute the header totals, atomically (draft edit).
export async function replaceItemsAndTotals(
  poId: string,
  lines: PoLineRow[],
  totals: PoTotals,
  headerPatch: Prisma.PurchaseOrderUncheckedUpdateInput,
): Promise<PurchaseOrderWithRelations> {
  return withTransaction(async (tx) => {
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: poId } });
    if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: poId, ...l })) });
    await tx.purchaseOrder.update({ where: { id: poId }, data: { ...headerPatch, ...totals } });
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: withRelations });
  });
}

// --- delete-guard counters (used by Supplier / Warehouse / IRM delete guards) ----------------
export function countBySupplier(supplierId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: { supplierId, deletedAt: null } });
}
export function countByWarehouse(warehouseId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: { warehouseId, deletedAt: null } });
}
export function countByIrmItem(irmItemId: string): Promise<number> {
  return prisma.purchaseOrderItem.count({ where: { irmItemId, purchaseOrder: { is: { deletedAt: null } } } });
}

// --- item-scoped read: every (non-deleted) PO line for an IRM item, with its parent PO header ------
// Feeds the IRM item detail "Purchase Orders" tab. Returns per-line rows (a PO with two lines of the
// same item yields two rows). Sorting is done by the service in JS — the Mongo connector can't orderBy
// a to-one relation field.
export function findLinesByIrmItem(irmItemId: string) {
  return prisma.purchaseOrderItem.findMany({
    where: { irmItemId, purchaseOrder: { is: { deletedAt: null } } },
    select: {
      quantity: true,
      receivedQuantity: true,
      purchaseOrder: {
        select: {
          id: true,
          code: true,
          status: true,
          priority: true,
          supplierName: true,
          createdAt: true,
          warehouse: { select: { name: true, code: true } },
        },
      },
    },
  });
}

// --- Goods In seam (tx-aware writers; called only from the GRN completion transaction) -------
// Goods In owns the receipt amounts; the PO just records them. Additive — no existing behaviour.
export function incrementLineReceivedTx(tx: Prisma.TransactionClient, purchaseOrderItemId: string, delta: number) {
  return tx.purchaseOrderItem.update({ where: { id: purchaseOrderItemId }, data: { receivedQuantity: { increment: delta } } });
}
export function lineReceiptTotalsTx(tx: Prisma.TransactionClient, purchaseOrderId: string) {
  return tx.purchaseOrderItem.findMany({ where: { purchaseOrderId }, select: { id: true, quantity: true, receivedQuantity: true } });
}
export function headerForReceiptTx(tx: Prisma.TransactionClient, purchaseOrderId: string) {
  return tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { id: true, code: true, status: true } });
}
export function setStatusTx(tx: Prisma.TransactionClient, purchaseOrderId: string, status: string) {
  return tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status } });
}

// Warehouse Inventory READ seam: outstanding (ordered − received) lines on open POs (sent /
// supplier_accepted / partially_received) delivering an item to a warehouse — feeds the
// inventory detail "Incoming".
export function incomingLinesForItemWarehouse(irmItemId: string, warehouseId: string) {
  return prisma.purchaseOrderItem.findMany({
    where: { irmItemId, purchaseOrder: { is: { warehouseId, status: { in: ["sent", "supplier_accepted", "partially_received"] }, deletedAt: null } } },
    select: { quantity: true, receivedQuantity: true },
  });
}

// --- supplier procurement summary (the supplier detail "Procurement" tab) --------------------
// Status → count map plus total spend (received/closed orders only). Deliberately no
// lead-time / on-time metrics yet — computable later from sentAt/confirmedDeliveryDate/GRN
// dates without any schema change.
export async function statusCountsForSupplier(supplierId: string): Promise<Record<string, number>> {
  const rows = await prisma.purchaseOrder.groupBy({
    by: ["status"],
    where: { supplierId, deletedAt: null },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
export async function spendPenceForSupplier(supplierId: string): Promise<number> {
  const agg = await prisma.purchaseOrder.aggregate({
    where: { supplierId, deletedAt: null, status: { in: ["fully_received", "closed"] } },
    _sum: { grandTotalPence: true },
  });
  return agg._sum.grandTotalPence ?? 0;
}

// --- attachments ----------------------------------------------------------------------------
export function addAttachment(data: Prisma.PurchaseOrderAttachmentUncheckedCreateInput): Promise<PurchaseOrderAttachment> {
  return prisma.purchaseOrderAttachment.create({ data });
}
export function findAttachment(id: string): Promise<PurchaseOrderAttachment | null> {
  return prisma.purchaseOrderAttachment.findUnique({ where: { id } });
}
export function removeAttachment(id: string): Promise<PurchaseOrderAttachment> {
  return prisma.purchaseOrderAttachment.delete({ where: { id } });
}

// --- code allocation (atomic Counter, prefix "PO") ------------------------------------------
const PO_CODE_PREFIX = "PO";

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

async function highestPoNumber(): Promise<number> {
  const head = `${PO_CODE_PREFIX}-`;
  const rows = await prisma.purchaseOrder.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
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
    const c = await prisma.counter.update({ where: { key: PO_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestPoNumber();
  try {
    await prisma.counter.create({ data: { key: PO_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({ where: { key: PO_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestPoNumber();
  await prisma.counter.upsert({ where: { key: PO_CODE_PREFIX }, create: { key: PO_CODE_PREFIX, seq: max }, update: { seq: max } });
}

// P2034 — Prisma surfaces a MongoDB transaction write-conflict / deadlock as this code. Two
// concurrent multi-creates both incrementing the PO counter inside their transactions race here;
// the loser retries the whole transaction (the counter increment rolled back, so no number lost).
function isWriteConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

// Ensure the PO counter row exists (idempotent). Seeds it at the current high-water mark so the
// FIRST in-transaction increment yields max+1 — seeding itself consumes no number. Done OUTSIDE the
// transaction so the in-tx increment never has to create-then-conflict.
async function ensurePoCounter(): Promise<void> {
  if (await prisma.counter.findUnique({ where: { key: PO_CODE_PREFIX } })) return;
  const start = await highestPoNumber();
  try {
    await prisma.counter.create({ data: { key: PO_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
}

// Create MANY POs (one per warehouse group) as a SINGLE all-or-nothing transaction: either every PO
// (header + lines + its code) commits, or none does. CRITICALLY the code allocation happens INSIDE
// the transaction (tx.counter.$inc), so a rollback RECLAIMS the numbers — a failed split never
// permanently consumes PO numbers (gap-safe). Each PO still gets its own distinct, sequential code.
// Retries the whole transaction on an out-of-band code collision (fast-forward) or a transient
// write-conflict. Returns the created POs IN INPUT ORDER.
export async function createManyWithCodes(
  groups: { header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">; lines: PoLineRow[] }[],
): Promise<PurchaseOrderWithRelations[]> {
  if (groups.length === 0) return [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await ensurePoCounter();
    try {
      return await withTransaction(async (tx) => {
        const createdIds: string[] = [];
        for (const g of groups) {
          // Allocate INSIDE the tx → a rollback un-does the increment (no gap / no consumed number).
          const c = await tx.counter.update({
            where: { key: PO_CODE_PREFIX },
            data: { seq: { increment: 1 } },
            select: { seq: true },
          });
          const code = `${PO_CODE_PREFIX}-${String(c.seq).padStart(4, "0")}`;
          const po = await tx.purchaseOrder.create({ data: { deletedAt: null, ...g.header, code } });
          if (g.lines.length) {
            await tx.purchaseOrderItem.createMany({ data: g.lines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
          }
          createdIds.push(po.id);
        }
        const rows = await tx.purchaseOrder.findMany({ where: { id: { in: createdIds } }, include: withRelations });
        const byId = new Map(rows.map((r) => [r.id, r]));
        return createdIds.map((id) => byId.get(id)).filter((r): r is PurchaseOrderWithRelations => Boolean(r));
      });
    } catch (e) {
      if (isCodeConflict(e)) {
        await fastForwardCounter();
        continue;
      }
      if (isWriteConflict(e)) continue; // transient — retry the whole transaction
      throw e;
    }
  }
  throw new Error("Could not allocate unique purchase-order codes.");
}

// --- PRF-conversion seam (tx-aware; called only from the purchase-request convert transaction) --
// The conversion transaction lives in purchase-request.service (mirroring how Goods In owns its
// completion transaction and calls PO tx-helpers). These expose exactly what it needs: gap-safe
// in-tx code allocation, in-tx PO creation, and the retry predicates.
export { ensurePoCounter, fastForwardCounter as fastForwardPoCounter, isCodeConflict as isPoCodeConflict, isWriteConflict as isPoWriteConflict };

// Allocate the next PO code INSIDE an existing transaction — a rollback reclaims the number.
export async function allocatePoCodeTx(tx: Prisma.TransactionClient): Promise<string> {
  const c = await tx.counter.update({ where: { key: PO_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return `${PO_CODE_PREFIX}-${String(c.seq).padStart(4, "0")}`;
}

// Create a PO (header + lines + attachment rows) INSIDE an existing transaction. `deletedAt`
// persisted as an explicit null for the Prisma+Mongo read-filter reason documented below.
export async function createPoTx(
  tx: Prisma.TransactionClient,
  header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">,
  code: string,
  lines: PoLineRow[],
  attachments: Omit<Prisma.PurchaseOrderAttachmentUncheckedCreateInput, "purchaseOrderId">[] = [],
): Promise<string> {
  const po = await tx.purchaseOrder.create({ data: { deletedAt: null, ...header, code } });
  if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
  if (attachments.length) {
    await tx.purchaseOrderAttachment.createMany({ data: attachments.map((a) => ({ ...a, purchaseOrderId: po.id })) });
  }
  return po.id;
}

// Create a PO (header + lines + totals) atomically with a freshly-allocated, collision-safe code.
export async function createWithCode(
  header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">,
  lines: PoLineRow[],
): Promise<PurchaseOrderWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${PO_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        // Persist deletedAt as an explicit null (not absent): Prisma+Mongo's `{ deletedAt: null }`
        // read filter does NOT match documents where the field is missing, so without this every
        // freshly-created PO would be invisible to findById/findByCode/list/the delete-guard counts.
        // Mirrors supplierRepo.createWithCode.
        const po = await tx.purchaseOrder.create({ data: { deletedAt: null, ...header, code } });
        if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
        return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique purchase-order code.");
}

// --- Dashboard read-models — not a generic reporting API (read-only; warehouse-scoped) ---

// Non-terminal, not-fully-received "open" statuses — same definition as the supplier summary.
const OPEN_PO_STATUSES = ["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted", "partially_received"] as const;
// Open statuses that represent a real financial commitment — a draft is workload, not spend.
const COMMITTED_PO_STATUSES = OPEN_PO_STATUSES.filter((s) => s !== "draft");
// Per-queue fetch cap for dashboard worklists — the merged list is re-sorted and capped again in
// the service, so this only bounds the DB read (oldest-first, so the cap keeps the actionable head).
const WORKLIST_QUERY_CAP = 50;
// Statuses that count as "issued spend" (reached the supplier). Cancelled excluded.
const ISSUED_PO_STATUSES = ["sent", "supplier_accepted", "partially_received", "fully_received", "closed"] as const;
// Pipeline = current count per non-terminal status.
const PIPELINE_STATUSES = OPEN_PO_STATUSES;

function whereWarehouse(warehouseIds?: string[]) {
  return warehouseIds ? { warehouseId: { in: warehouseIds } } : {};
}

/** Open PO count + committed value (pence). The count is a workload metric (drafts included);
 *  the value is financial, so drafts — not yet approved commitments — are excluded from the sum. */
export async function openSummary(warehouseIds?: string[]): Promise<{ count: number; valuePence: number }> {
  const scoped = { deletedAt: null, ...whereWarehouse(warehouseIds) };
  const [count, agg] = await Promise.all([
    prisma.purchaseOrder.count({ where: { status: { in: [...OPEN_PO_STATUSES] }, ...scoped } }),
    prisma.purchaseOrder.aggregate({
      where: { status: { in: [...COMMITTED_PO_STATUSES] }, ...scoped },
      _sum: { grandTotalPence: true },
    }),
  ]);
  return { count, valuePence: agg._sum.grandTotalPence ?? 0 };
}

/** Current count per pipeline status; zero-filled so every bar renders. */
export async function pipelineCounts(warehouseIds?: string[]): Promise<Array<{ status: string; count: number }>> {
  const grouped = await prisma.purchaseOrder.groupBy({
    by: ["status"],
    where: { status: { in: [...PIPELINE_STATUSES] }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
  return PIPELINE_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/** orderDate + grandTotalPence for issued POs since `since`, for the 12-month spend chart. */
export async function issuedSpendSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date; value: number }>> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: { in: [...ISSUED_PO_STATUSES] }, orderDate: { gte: since }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: { orderDate: true, grandTotalPence: true },
  });
  return rows.map((r) => ({ at: r.orderDate, value: r.grandTotalPence ?? 0 }));
}

/** createdAt of POs since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date }>> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { createdAt: { gte: since }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: { createdAt: true },
  });
  return rows.map((r) => ({ at: r.createdAt }));
}

type PoWorklistRow = { id: string; code: string; supplierName: string | null; priority: string | null; status: string; expectedDeliveryDate: Date | null; createdAt: Date };

// PO code field is `code` (@unique, e.g. PO-0001). `supplierName` is snapshotted on the row.
const poWorklistSelect = { id: true, code: true, priority: true, status: true, expectedDeliveryDate: true, createdAt: true, supplierName: true } satisfies Prisma.PurchaseOrderSelect;
function mapPoWorklist(r: {
  id: string; code: string; priority: string | null; status: string; expectedDeliveryDate: Date | null; createdAt: Date; supplierName: string | null;
}): PoWorklistRow {
  return { id: r.id, code: r.code, supplierName: r.supplierName, priority: r.priority, status: r.status, expectedDeliveryDate: r.expectedDeliveryDate, createdAt: r.createdAt };
}

/** Draft POs converted from a PRF (fast-path approval queue). */
export async function fastPathDraftWorklist(warehouseIds?: string[]): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: "draft", purchaseRequestId: { not: null }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: poWorklistSelect,
    orderBy: { createdAt: "asc" },
    take: WORKLIST_QUERY_CAP,
  });
  return rows.map(mapPoWorklist);
}

/** POs in a given status (optionally restricted to a PM) for the worklist. */
export async function statusWorklist(status: string, opts: { pmUserId?: string; warehouseIds?: string[] } = {}): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status, deletedAt: null, ...(opts.pmUserId ? { pmUserId: opts.pmUserId } : {}), ...whereWarehouse(opts.warehouseIds) },
    select: poWorklistSelect,
    orderBy: { createdAt: "asc" },
    take: WORKLIST_QUERY_CAP,
  });
  return rows.map(mapPoWorklist);
}

/** POs that can still receive goods (warehouse-scoped receive queue). */
export async function receivableWorklist(warehouseIds?: string[]): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["sent", "supplier_accepted", "partially_received"] }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: poWorklistSelect,
    orderBy: { expectedDeliveryDate: "asc" },
    take: WORKLIST_QUERY_CAP,
  });
  return rows.map(mapPoWorklist);
}
