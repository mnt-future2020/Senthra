import { Prisma, type PurchaseOrder, type PurchaseOrderAttachment } from "@prisma/client";

import { isWriteConflict, prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";
import { effectiveEta, isDeliveryOverdue } from "./po-overdue.js";
import {
  atWarehouses,
  awaitingDeliveryWhere,
  expiringSoonWhere,
  onHireWhere,
  overdueDeliveryWhere,
  overdueWhere,
  cancelledWhere,
  returnedWhere,
  TERMINAL_HIRE_STATUSES,
} from "./rentalHire.predicate.js";

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

/** A goods receipt that still exists. */
const LIVE_GRN = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } satisfies Prisma.GoodsReceiptWhereInput;

const withRelations = {
  supplier: { select: supplierSelect },
  warehouse: { select: warehouseSelect },
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { irmItem: { select: { id: true, code: true, name: true, status: true } } },
  },
  rentalItems: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      rentalItem: { select: { id: true, code: true, name: true, status: true } },
      // The breakdown behind each hire's running extension total, oldest first — read with the order
      // rather than fetched per line, which on a five-hire order would be five more round trips for
      // a handful of rows.
      extensions: { orderBy: { createdAt: "asc" } },
    },
  },
  attachments: { orderBy: { createdAt: "asc" } },
  // Procurement-chain slices: the source PRF, the optional job, and the GRNs received against
  // this PO — compact selects only (the detail chain strip + linked badges render from these).
  purchaseRequest: { select: { id: true, code: true, status: true } },
  job: { select: { id: true, jobNumber: true, name: true, status: true } },
  // LIVE ONLY, for the same reason the request's linked-PO include filters: a draft receipt can be
  // deleted, every GRN read filters `deletedAt`, and the chain strip renders each of these as a
  // clickable node — so an unfiltered list puts a button on the order that lands the user on
  // "Goods receipt not found." Mongo: a row whose create omitted the field does not match
  // `{ deletedAt: null }`, so both shapes have to be asked for.
  goodsReceipts: {
    where: LIVE_GRN,
    select: { id: true, code: true, status: true, receivedDate: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.PurchaseOrderInclude;

// Exported so the include can be pinned by a test: dropping the `where` is a silent regression —
// it compiles, and every read still returns rows.
export { LIVE_GRN, withRelations };

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
  /** a real status, or a DERIVED pseudo-status — "overdue" | "awaiting_approval" | "awaiting_send" (see buildWhere) */
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
  /** Start of "today" in the COMPANY timezone. REQUIRED whenever `status === "overdue"`. */
  overdueBefore?: Date;
  // Restricts the pm_review HALF of the "awaiting_send" pseudo-status to one PM, leaving the
  // "approved" half (which has no PM yet) untouched. The service sets it for an actor who can't
  // override PM assignment, so the list matches that actor's badge count exactly. Ignored for every
  // other status — a plain pm_review filter is what `pmUserId` above is for.
  pmScopeUserId?: string;
  // Warehouse-access scope (from warehouseScopeFilter): `undefined` = unrestricted (no filter);
  // an array constrains the list to POs delivering to those warehouses. NOTE: a scoped actor only
  // ever sees POs WITH a warehouseId in their set — POs whose warehouseId is still null (header not
  // yet assigned) are excluded from a scoped user's list. That's acceptable: unassigned POs aren't
  // "theirs" until a warehouse is set. Unrestricted actors are entirely unaffected.
  warehouseIds?: string[];
}

// Exported for unit testing — pure where-clause builder, no Prisma I/O.
// The receivable window — a PO that has been issued to the supplier but isn't fully in yet. Shared by
// the overdue filter below and expectedDeliveries, so the "Deliveries overdue" badge and the list it
// opens are the same set of rows, not two similar ideas.
export const RECEIVABLE_PO_STATUSES = ["sent", "supplier_accepted", "partially_received"] as const;

/**
 * A purchase order Goods In can actually act on: issued, AND still carrying goods to receive.
 *
 * The status alone is not enough. A HIRE-ONLY order is `sent` like any other, so it used to sit in the
 * warehouse's Company (GRN) worklist with a Receive button that opened an empty receipt form — there
 * was nothing to receive, because hired kit is received as a hire delivery (rental-receipt), not as a
 * goods receipt. Requiring at least one IRM line keeps those orders in their own queue.
 *
 * Deliberately NOT "outstanding quantity > 0": that comparison is between two COLUMNS, which a
 * Prisma/Mongo `where` cannot express — the same limitation that made `notifyOnDate` a stored column.
 * `partially_received` already means some remains, and a fully-received order leaves the window by
 * status, so the line-EXISTS test is what this can honestly ask for.
 */
export const receivableWhere = (): Prisma.PurchaseOrderWhereInput => ({
  status: { in: [...RECEIVABLE_PO_STATUSES] },
  items: { some: {} },
});

// The two approval-queue predicates, defined ONCE and shared by countAttention (the badge) and
// buildWhere (the list the badge opens) — the same contract RECEIVABLE_PO_STATUSES gives the overdue
// badge. Previously the badge summed these while its href pointed at a single real status, so a
// badge reading "7 to approve" opened a list of 4.
//
// A PRF-born PO is created straight into `draft` (the fast path) and is ALREADY awaiting sign-off, so
// the approval queue is those plus the explicitly submitted `pending_approval` rows.
export const awaitingApprovalPoWhere = (): Prisma.PurchaseOrderWhereInput[] => [
  { status: "draft", purchaseRequestId: { not: null } },
  { status: "pending_approval" },
];

// "Ready to go out": `approved` (no PM assigned yet) plus `pm_review` (assigned, awaiting the send).
// `pmScopeUserId` narrows only the pm_review half — an approved PO has no pmUserId, so applying it
// to both would wrongly empty the queue.
export const awaitingSendPoWhere = (pmScopeUserId?: string): Prisma.PurchaseOrderWhereInput[] => [
  { status: "approved" },
  { status: "pm_review", ...(pmScopeUserId ? { pmUserId: pmScopeUserId } : {}) },
];

/**
 * Orders that have ARRIVED and have nothing left to hand back — the "Received — ready to close" queue.
 *
 * `fully_received` alone answered the wrong question on a rental order. It means every ordered unit
 * turned up, which stays true forever once it happens; a hire, though, is a round trip, and
 * `closePurchaseOrder` refuses an order whose kit is still out. So the badge counted orders nobody
 * could act on, and clicking Close on one got "still on hire — record its return first". The
 * attention registry's first rule is that a count means work a human still owes.
 *
 * ONE definition, read by the badge's count and by the list the badge opens. Written twice they end
 * up different, and a chip reading 12 that opens 17 rows is worse than no chip.
 *
 * `none` is vacuously true on an order with no rental lines, so every goods-only order counts exactly
 * as it did before — which is most of them.
 */
export function awaitingClosePoWhere(): Prisma.PurchaseOrderWhereInput {
  return {
    status: "fully_received",
    // Through the shared list, so this and the close guard cannot drift into disagreeing about what
    // "finished" means — a hire that went back and one closed short are equally done.
    rentalItems: { none: { hireStatus: { notIn: [...TERMINAL_HIRE_STATUSES] } } },
  };
}

export function buildWhere(filters: PurchaseOrderListFilters): Prisma.PurchaseOrderWhereInput {
  const where: Prisma.PurchaseOrderWhereInput = { deletedAt: null };
  if (filters.status === "overdue") {
    // DERIVED pseudo-status, never stored: a receivable PO whose effective ETA has passed. The
    // effective ETA is the supplier-CONFIRMED date when set, otherwise the expected date — the same
    // "confirmed ?? expected" rule expectedDeliveries applies in memory, written here as an AND'd OR
    // so it composes with (and can't be clobbered by) the search OR further down.
    // Loud on a missing boundary, like the jobs list: "today" is a company-timezone question the
    // service answers, and a quiet default would silently report an empty overdue list.
    if (!filters.overdueBefore) throw new Error("buildWhere: overdueBefore is required for the overdue filter.");
    where.status = { in: [...RECEIVABLE_PO_STATUSES] };
    where.AND = [
      {
        OR: [
          { confirmedDeliveryDate: { lt: filters.overdueBefore } },
          // MONGO TRAP — the same one that kept the portal-invite count at zero. `confirmedDeliveryDate: null`
          // matches only rows where the field is EXPLICITLY null, and nothing writes it on create:
          // recordSupplierAcceptance is the only path that ever sets it. So on every PO still awaiting
          // acknowledgement the field is ABSENT, and absent is not null.
          //
          // The badge computes `confirmed ?? expected` in memory (expectedDeliveries), where undefined
          // falls through happily. This clause did not, so a `sent` PO with a past expected date was
          // COUNTED as overdue and then hidden from the list that count opens — "Deliveries overdue 8"
          // opening six rows, every one of them Supplier Accepted, with the un-acknowledged ones (the
          // ones most worth chasing) missing entirely.
          {
            OR: [{ confirmedDeliveryDate: null }, { confirmedDeliveryDate: { isSet: false } }],
            expectedDeliveryDate: { lt: filters.overdueBefore },
          },
        ],
      },
    ];
  } else if (filters.status === "awaiting_close") {
    // DERIVED pseudo-status: arrived, and nothing still on hire. Same predicate the badge counts, so
    // the chip and the list it opens can never disagree. See awaitingClosePoWhere.
    Object.assign(where, awaitingClosePoWhere());
  } else if (filters.status === "receivable") {
    // DERIVED pseudo-status: everything the warehouse can still book in — the exact set countAttention
    // measures for "Deliveries to receive". It spans three real statuses, and the badge used to open
    // `?status=sent` instead: a chip reading 14 opened a list of 7, with the other 7 sitting under
    // supplier_accepted / partially_received. Same `receivableWhere` the badge counts, so there is one
    // definition of "receivable" in this file, not three — and a hire-only order, which has no goods
    // to book in at all, is in neither.
    where.status = { in: [...RECEIVABLE_PO_STATUSES] };
    where.items = { some: {} };
  } else if (filters.status === "awaiting_approval" || filters.status === "awaiting_send") {
    // DERIVED pseudo-statuses, never stored — the approval and send queues, which each span more
    // than one real status. AND'd like the overdue branch above so they compose with (and can't be
    // clobbered by) the search OR further down.
    where.AND = [
      {
        OR:
          filters.status === "awaiting_approval"
            ? awaitingApprovalPoWhere()
            : awaitingSendPoWhere(filters.pmScopeUserId),
      },
    ];
  } else if (filters.statuses?.length) where.status = { in: filters.statuses };
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
export function countByJob(jobId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: { jobId, deletedAt: null } });
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

// Reorder-workbench READ seam: ALL outstanding open-PO lines in one query (the bulk sibling of the
// single-pair read above). warehouseId + status live on the PARENT PurchaseOrder, so this is a
// findMany + relation-select the caller reduces in memory — Mongo groupBy can't cross the relation.
//
// The status set is the FULL open pipeline (draft → partially_received), NOT just the issued/en-route
// stages the inventory-detail "Incoming" uses. A PRF that is converted drops out of the PRF netting
// and the new PO lands in `draft`; if reorder counted only `sent`+, that quantity would be invisible
// through the whole PO-approval window and the workbench would re-suggest buying it (double-order).
// fully_received/closed are excluded — that stock has already landed in on-hand via the GRN.
export function openIncomingLines() {
  return prisma.purchaseOrderItem.findMany({
    where: {
      purchaseOrder: {
        is: {
          status: { in: ["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted", "partially_received"] },
          deletedAt: null,
        },
      },
    },
    select: { irmItemId: true, quantity: true, receivedQuantity: true, purchaseOrder: { select: { warehouseId: true } } },
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
export function addAttachment(
  data: Prisma.PurchaseOrderAttachmentUncheckedCreateInput,
  tx?: Prisma.TransactionClient,
): Promise<PurchaseOrderAttachment> {
  // `tx` is passed by the direct-upload finalize, which commits this row and its pending-upload
  // ledger removal together.
  return (tx ?? prisma).purchaseOrderAttachment.create({ data });
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

// The P2034 write-conflict predicate lives in lib/prisma alongside withTransactionRetry — the case
// it covers here is the same one: two concurrent multi-creates both increment the PO counter inside
// their transactions, and the loser retries the whole thing (the increment rolled back, no number
// lost). Re-exported below as `isPoWriteConflict` for the PRF-conversion seam, which drives its own
// retry loop because it must also handle a duplicate-code conflict.

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
// The scalar fields written to a PO RENTAL line — the committed hire.
export interface PoRentalLineRow {
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
  hireStatus: string;
  /** Only ever written by extendHire — conversion starts every hire at zero. */
  extensionChargePence?: number;
  notifyOnDate: Date;
}

export async function createPoTx(
  tx: Prisma.TransactionClient,
  header: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "code">,
  code: string,
  lines: PoLineRow[],
  attachments: Omit<Prisma.PurchaseOrderAttachmentUncheckedCreateInput, "purchaseOrderId">[] = [],
  rentalLines: PoRentalLineRow[] = [],
): Promise<string> {
  const po = await tx.purchaseOrder.create({ data: { deletedAt: null, ...header, code } });
  if (lines.length) await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
  if (rentalLines.length)
    await tx.purchaseOrderRentalLine.createMany({ data: rentalLines.map((l) => ({ purchaseOrderId: po.id, ...l })) });
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
/** Dashboard "Expected this week": open receivable POs due within 7 days vs already overdue. */
// `dayStart` is the company-timezone start of today (utils/filter-date startOfDayIn) — the SAME clock
// jobRepo.dueBreakdown and the goods-management due filters use. Passing raw `now` instead would make a
// delivery "overdue" hours before a job due the same day is, so the badges would contradict each other
// every morning.
export async function expectedDeliveries(now: Date, dayStart: Date, warehouseIds?: string[]): Promise<{ dueThisWeek: number; overdue: number }> {
  const soon = new Date(dayStart.getTime() + 7 * 86_400_000);
  // The supplier-confirmed date is authoritative for planning (updatable after the supplier commits);
  // fall back to the expected date when it isn't set yet. Because the effective date can be EITHER
  // column, we can't filter by date in the where clause — the open-receivable set is small, so we
  // fetch it and split in memory. A row with neither date is "no ETA" and simply doesn't count.
  // `receivableWhere`, so hire-only orders are excluded. Their kit is expected too, but it is counted
  // by the hire side's own badge ("Hires not yet received", driven by the hire START date) — counting
  // it here as well would put one real-world arrival on two badges, and this one opens a list whose
  // Receive button has nothing to receive.
  const rows = await prisma.purchaseOrder.findMany({
    where: { ...receivableWhere(), deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: { expectedDeliveryDate: true, confirmedDeliveryDate: true },
  });
  let dueThisWeek = 0;
  let overdue = 0;
  for (const r of rows) {
    // Shared with buildWhere's `overdue` branch through po-overdue.ts. The two halves cannot be one
    // implementation — this is JavaScript, that is a Prisma `where` — so they are written down side
    // by side and tested against the same table of cases. They last drifted on absent-vs-null.
    const eta = effectiveEta(r.confirmedDeliveryDate, r.expectedDeliveryDate);
    if (!eta || eta > soon) continue;
    if (isDeliveryOverdue(r.confirmedDeliveryDate, r.expectedDeliveryDate, dayStart)) overdue++;
    else dueThisWeek++;
  }
  return { dueThisWeek, overdue };
}

// Attention counts — the PO states where a human still owes an action, in the order the workflow
// hands them along. `awaitingSend` folds `approved` (nobody has routed or issued it yet) together with
// the pm_review rows THIS actor must issue; `receivable` is the warehouse's goods-in backlog.
// fully_received → awaiting close. Closed/cancelled are terminal and deliberately absent.
export async function countAttention(
  opts: { warehouseIds?: string[]; pmUserId?: string } = {},
): Promise<{
  awaitingApproval: number;
  awaitingSend: number;
  awaitingAcceptance: number;
  awaitingClose: number;
  receivable: number;
}> {
  const scoped = { deletedAt: null, ...whereWarehouse(opts.warehouseIds) };
  // Each queue is ONE count over the shared predicate rather than a sum of per-status counts, so the
  // badge cannot drift from the list `?status=awaiting_approval` / `?status=awaiting_send` opens.
  const [awaitingApproval, awaitingSend, sent, awaitingClose, receivable] = await Promise.all([
    prisma.purchaseOrder.count({ where: { OR: awaitingApprovalPoWhere(), ...scoped } }),
    prisma.purchaseOrder.count({ where: { OR: awaitingSendPoWhere(opts.pmUserId), ...scoped } }),
    prisma.purchaseOrder.count({ where: { status: "sent", ...scoped } }),
    // Through the shared predicate, not a bare status: a rental order whose kit is still out cannot
    // be closed, and counting it made the chip a list of work the server refuses.
    prisma.purchaseOrder.count({ where: { ...awaitingClosePoWhere(), ...scoped } }),
    // The warehouse's goods-in backlog. Through `receivableWhere`, so it counts exactly the rows
    // `?status=receivable` opens — a hire-only order has nothing to receive here and is in neither.
    prisma.purchaseOrder.count({ where: { ...receivableWhere(), ...scoped } }),
  ]);
  return {
    awaitingApproval,
    awaitingSend,
    awaitingAcceptance: sent,
    awaitingClose,
    receivable,
  };
}

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

/**
 * POs that can still receive GOODS (warehouse-scoped receive queue).
 *
 * Through `receivableWhere`, so a hire-only order is not in it. One used to appear here with a Receive
 * button that opened an empty goods-receipt form: hired kit is booked in as a hire delivery, which is
 * its own queue, because a GRN writes stock and hired kit is the supplier's.
 */
export async function receivableWorklist(warehouseIds?: string[]): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { ...receivableWhere(), deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: poWorklistSelect,
    orderBy: { expectedDeliveryDate: "asc" },
    take: WORKLIST_QUERY_CAP,
  });
  return rows.map(mapPoWorklist);
}

// --- rental hires (the committed hire rows on this order) ------------------------------------

export function findRentalLine(lineId: string) {
  return prisma.purchaseOrderRentalLine.findUnique({ where: { id: lineId } });
}

// --- hires as a source of kit for JOBS -------------------------------------------------------
//
// A hire that has been delivered is equipment sitting at a warehouse, and a job can send an engineer
// to collect it. These are the reads and writes that path needs.
//
// "Available at the warehouse" is `receivedQuantity − returnedQuantity − issuedQuantity`:
//   receivedQuantity  what the provider actually delivered to us
//   returnedQuantity  what has gone BACK to the provider (gone; not ours to lend out)
//   issuedQuantity    what is out with an engineer right now (ours, but not in the building)
// All three are maintained columns on the row, so the sum is arithmetic on one document rather than
// a re-tally of the movement ledger — see the `issuedQuantity` comment in schema.prisma.

/** A delivered hire with the numbers the job path needs, plus its order's delivery warehouse. */
export interface HireStockRow {
  id: string;
  rentalItemId: string;
  itemName: string;
  baseUnit: string | null;
  quantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity: number;
  hireEndDate: Date;
  hireStatus: string;
  purchaseOrderId: string;
  poCode: string | null;
  warehouseId: string;
  warehouseName: string | null;
  warehouseCode: string | null;
  /**
   * Whether the hire's ORDER is still live — not cancelled and not soft-deleted.
   *
   * Carried on the row so a caller that resolves ONE hire by id gets the same guarantee the list query
   * gets from `onHireWhere()`. The list can filter; a lookup by a client-supplied id cannot, and
   * without this `postIssue` would happily lend kit against an order the supplier-return path can no
   * longer even load — leaving the units permanently unsettleable.
   */
  orderLive: boolean;
}

const HIRE_STOCK_SELECT = {
  id: true,
  rentalItemId: true,
  itemName: true,
  baseUnit: true,
  quantity: true,
  receivedQuantity: true,
  returnedQuantity: true,
  issuedQuantity: true,
  hireEndDate: true,
  hireStatus: true,
  purchaseOrderId: true,
  // The hire's warehouse comes from its ORDER — a hire has none of its own, which is exactly why this
  // join exists. Name and code ride along so a picker can label the depot without a second query.
  purchaseOrder: { select: { code: true, warehouseId: true, status: true, deletedAt: true, warehouse: { select: { name: true, code: true } } } },
} satisfies Prisma.PurchaseOrderRentalLineSelect;

type HireStockQueryRow = Prisma.PurchaseOrderRentalLineGetPayload<{ select: typeof HIRE_STOCK_SELECT }>;

function mapHireStock(r: HireStockQueryRow): HireStockRow {
  return {
    id: r.id,
    rentalItemId: r.rentalItemId,
    itemName: r.itemName,
    baseUnit: r.baseUnit,
    quantity: r.quantity,
    receivedQuantity: r.receivedQuantity,
    returnedQuantity: r.returnedQuantity,
    issuedQuantity: r.issuedQuantity,
    hireEndDate: r.hireEndDate,
    hireStatus: r.hireStatus,
    purchaseOrderId: r.purchaseOrderId,
    poCode: r.purchaseOrder?.code ?? null,
    warehouseId: r.purchaseOrder.warehouseId,
    warehouseName: r.purchaseOrder.warehouse?.name ?? null,
    warehouseCode: r.purchaseOrder.warehouse?.code ?? null,
    orderLive: r.purchaseOrder.status !== "cancelled" && !r.purchaseOrder.deletedAt,
  };
}

/**
 * Every LIVE hire of the given catalogue items, soonest deadline first.
 *
 * "Live" is `onHireWhere()` from rentalHire.predicate.ts, NOT a hand-written `hireStatus: "on_hire"`.
 * That distinction is load-bearing and this function shipped without it: the predicate also requires
 * the hire's ORDER to be live, and on this database 15 of 31 `on_hire` lines hang off a SOFT-DELETED
 * purchase order. Matching on the status alone offered every one of them as collectable kit — which
 * is where a phantom "60 available" came from — and a unit issued against a deleted order can never
 * be settled, because the supplier-return path loads the order and refuses ("Purchase order not
 * found"). The badge and the sweep already exclude those rows, so the scan panel was the one reader
 * disagreeing with the rest of the module.
 *
 * That is exactly the drift the spec's "ONE predicate, two readers" rule exists to prevent, so this
 * composes the shared predicate instead of restating it. The warehouse is the ORDER's delivery
 * warehouse — a hire has no warehouse of its own, which is why the join exists.
 *
 * Sorted by `hireEndDate` ascending so a caller allocating units across hires drains the one due back
 * FIRST. That is not a display preference: sending out the tester with three weeks left while the one
 * due Friday sits on the shelf is how a hire goes overdue with kit nobody was using.
 */
export async function findLiveHiresByRentalItems(rentalItemIds: string[], warehouseIds?: string[]): Promise<HireStockRow[]> {
  if (rentalItemIds.length === 0) return [];
  const rows = await prisma.purchaseOrderRentalLine.findMany({
    // `atWarehouses` merges the warehouse scope INTO the predicate's own purchaseOrder clause. Spread
    // as a sibling instead, the second `purchaseOrder` key would overwrite the first and silently drop
    // the live-order guard this call exists to apply.
    where: {
      ...atWarehouses(onHireWhere(), warehouseIds && warehouseIds.length > 0 ? warehouseIds : undefined),
      rentalItemId: { in: rentalItemIds },
    },
    select: HIRE_STOCK_SELECT,
    orderBy: { hireEndDate: "asc" },
  });
  return rows.map(mapHireStock);
}

/** One hire, with the same numbers — the scan resolves a specific unit to exactly one of these. */
export async function findHireStockById(lineId: string): Promise<HireStockRow | null> {
  const row = await prisma.purchaseOrderRentalLine.findUnique({ where: { id: lineId }, select: HIRE_STOCK_SELECT });
  return row ? mapHireStock(row) : null;
}

/** The tx-aware twin, for the re-check inside the posting transaction. */
export async function findHireStockByIdTx(tx: Prisma.TransactionClient, lineId: string): Promise<HireStockRow | null> {
  const row = await tx.purchaseOrderRentalLine.findUnique({ where: { id: lineId }, select: HIRE_STOCK_SELECT });
  return row ? mapHireStock(row) : null;
}

/**
 * Move a hire's `issuedQuantity` by `delta` (+ out to an engineer, − back to the warehouse), and
 * refuse the move if it would break the arithmetic.
 *
 * CONDITIONAL, not a bare increment, and that is the whole point: the guard columns are in the same
 * `where` as the update, so the availability check and the decrement are ONE atomic operation on one
 * document. Two warehouses scanning the last tester at the same instant both read "1 available"; only
 * one of them satisfies the `where`, and the other gets `false` and a 409 telling it to refresh.
 * Reading first and then incrementing would let both succeed and leave the hire issued twice over.
 *
 * On the way OUT (`delta > 0`) the bound is `issuedQuantity <= received − returned − delta`, i.e.
 * never lend more than is actually in the building. On the way BACK (`delta < 0`) the bound is
 * `issuedQuantity >= −delta`, i.e. never credit a return of units that were never issued.
 */
/**
 * Record that an engineer brought units of this hire back damaged.
 *
 * Writes `fieldDamageQty` / `fieldDamageReportedAt` and NOTHING else — in particular not
 * `damagedQuantity`, which is recomputed as an absolute from the live damage notes and would erase
 * this the next time one was voided. See the column comments in schema.prisma.
 *
 * A plain increment rather than a conditional write: it moves no availability and gates no decision,
 * so there is no arithmetic for a concurrent write to break. It is a flag with a count on it.
 */
export async function flagHireDamagedTx(tx: Prisma.TransactionClient, lineId: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  await tx.purchaseOrderRentalLine.update({
    where: { id: lineId },
    data: { fieldDamageQty: { increment: qty }, fieldDamageReportedAt: new Date() },
  });
}

export async function adjustHireIssuedQtyTx(tx: Prisma.TransactionClient, lineId: string, delta: number): Promise<boolean> {
  if (delta === 0) return true;
  const line = await tx.purchaseOrderRentalLine.findUnique({
    where: { id: lineId },
    select: { receivedQuantity: true, returnedQuantity: true },
  });
  if (!line) return false;
  const heldByCompany = line.receivedQuantity - line.returnedQuantity;

  // ── ABSENT IS NOT ZERO ────────────────────────────────────────────────────────────────────────
  //
  // `issuedQuantity` carries `@default(0)`, but a Prisma default is applied by the CLIENT on create —
  // it is not a stored value, and `prisma db push` never writes one into rows that already exist. In
  // MongoDB a range comparison does not match a document that LACKS the field, so a bare
  // `{ issuedQuantity: { lte: n } }` matched nothing on every hire raised before this column existed:
  // the guard returned false for all of them and the warehouse was told "those units are no longer
  // available — stock changed" about hires with everything still on the shelf.
  //
  // `NOT: { gt: ceiling }` is the fix and it is not a stylistic variant of `lte`. `$gt` does not match
  // a missing field, so negating it matches BOTH a stored value within the ceiling AND a missing one —
  // which is exactly the reading a missing counter deserves: nothing has been issued. `lte` excludes
  // the missing row; `NOT gt` includes it. (Prisma has no `isSet` for a required scalar, so this is
  // also the only way to say it through the typed API.)
  //
  // It is correct only because the pre-check below has already refused any request bigger than the
  // hire physically holds — so `ceiling` is never negative here, and "missing" can never slip a row
  // past a bound it should have failed.
  if (delta > 0 && delta > heldByCompany) return false;
  const ceiling = heldByCompany - delta;

  const res = await tx.purchaseOrderRentalLine.updateMany({
    where: {
      id: lineId,
      // Re-assert the numbers the ceiling was computed from, so a delivery or a supplier-return
      // landing in the gap invalidates this write instead of silently shifting the ceiling under it.
      receivedQuantity: line.receivedQuantity,
      returnedQuantity: line.returnedQuantity,
      ...(delta > 0
        ? { NOT: { issuedQuantity: { gt: ceiling } } }
        // The other direction needs the OPPOSITE treatment: `gte` excludes a missing field, and that
        // is right — crediting back units a row never recorded issuing is exactly what to refuse.
        : { issuedQuantity: { gte: -delta } }),
    },
    data: { issuedQuantity: { increment: delta } },
  });
  return res.count === 1;
}

export function updateRentalLine(lineId: string, data: Prisma.PurchaseOrderRentalLineUpdateInput) {
  return prisma.purchaseOrderRentalLine.update({ where: { id: lineId }, data });
}

/**
 * Update a hire line only while it still looks the way the caller read it.
 *
 * The same optimistic guard the hire-note writes use (rental-receipt.repository's `applyHireWrite`),
 * and needed for the same reason: a write whose VALUE is derived from a pre-read quantity is wrong
 * the moment that quantity moves. Closing a hire short computes `cancelledQuantity` as
 * `quantity - receivedQuantity`; if a delivery lands in the window between the read and the write,
 * the stored shortfall describes a line that no longer exists and `received + cancelled` stops adding
 * up to `ordered`. The two writes never overlap in time, so Mongo raises no conflict of its own.
 *
 * `updateMany`, because `update` takes a UNIQUE where and cannot carry the guard columns. Returns
 * whether the row was still in the expected state; the caller turns `false` into a 409 with an
 * instruction, rather than a 500 they would retry straight back into.
 */
export async function updateRentalLineIf(
  lineId: string,
  expect: Prisma.PurchaseOrderRentalLineWhereInput,
  data: Prisma.PurchaseOrderRentalLineUncheckedUpdateInput,
): Promise<boolean> {
  const res = await prisma.purchaseOrderRentalLine.updateMany({ where: { id: lineId, ...expect }, data });
  return res.count === 1;
}

/**
 * Extend a hire: move the line AND record what moved it, in ONE transaction.
 *
 * The two must land together or not at all. `extensionChargePence` is a running total and this row is
 * the explanation of it — a breakdown that can disagree with the number it explains is worse than no
 * breakdown, because both look authoritative and only one is checked. Same rule the receipt writes
 * follow for `receivedQuantity`.
 */
export async function extendRentalLine(
  lineId: string,
  data: Prisma.PurchaseOrderRentalLineUpdateInput,
  extension: Prisma.HireExtensionUncheckedCreateInput,
  // Anything else that must move with the new deadline, run in THIS transaction. Today that is the
  // engineer-custody snapshot (see refreshHoldingDeadlinesForHireTx): the person holding the kit is
  // working to this date, so their copy of it cannot be updated separately and cannot survive a
  // rollback of the extension it came from. A callback rather than a direct call because the write
  // belongs to another module's repository, and repositories do not reach across domains.
  alsoInTx?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.purchaseOrderRentalLine.update({ where: { id: lineId }, data });
    await tx.hireExtension.create({ data: extension });
    if (alsoInTx) await alsoInTx(tx);
  });
}

// --- the extension register ------------------------------------------------------------------
//
// Every extension agreed in a period. The question `extensionChargePence` cannot answer, because a
// sum carries no dates: three extensions of £275, £300 and £150 read as £725 and nothing more.

export interface HireExtensionListFilters {
  /** Order code, supplier or item. */
  search?: string;
  purchaseOrderId?: string;
  /** Inclusive bounds on when the extension was AGREED — the reporting period. */
  dateFrom?: Date;
  dateTo?: Date;
}

function buildExtensionWhere(f: HireExtensionListFilters): Prisma.HireExtensionWhereInput {
  const where: Prisma.HireExtensionWhereInput = {};
  if (f.purchaseOrderId) where.purchaseOrderId = f.purchaseOrderId;
  if (f.dateFrom || f.dateTo) {
    where.createdAt = { ...(f.dateFrom ? { gte: f.dateFrom } : {}), ...(f.dateTo ? { lte: f.dateTo } : {}) };
  }
  if (f.search) {
    // escapeRegex, always: Prisma injects `contains` into a Mongo $regex unescaped, so a bare "(" in
    // a search box is a 500 rather than no results.
    const q = escapeRegex(f.search);
    where.OR = [
      { poCode: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { itemName: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export function findManyExtensions(filters: HireExtensionListFilters, skip = 0, take = 20) {
  return prisma.hireExtension.findMany({
    where: buildExtensionWhere(filters),
    // Newest agreement first, and the id as the tie-break so two extensions recorded in the same
    // moment cannot swap places between a page and its export.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip,
    take,
  });
}

export function countExtensions(filters: HireExtensionListFilters): Promise<number> {
  return prisma.hireExtension.count({ where: buildExtensionWhere(filters) });
}

// --- the deadline badge, the on-hire list and the reminder sweep ------------------------------
//
// All three build their filter from rentalHire.predicate, never from a local copy. A count and the
// list it opens computed by two predicates is the bug the attention registry already documents for
// `?status=rework` and `?status=awaiting_send`.

export function countExpiringHires(todayStart: Date): Promise<number> {
  return prisma.purchaseOrderRentalLine.count({ where: expiringSoonWhere(todayStart) });
}

export function countOverdueHires(todayStart: Date): Promise<number> {
  return prisma.purchaseOrderRentalLine.count({ where: overdueWhere(todayStart) });
}

/** Hires whose start date has passed with nobody confirming the kit arrived. */
export function countOverdueDeliveryHires(todayStart: Date): Promise<number> {
  return prisma.purchaseOrderRentalLine.count({ where: overdueDeliveryWhere(todayStart) });
}

/**
 * Hires still awaiting delivery at these warehouses — the warehouse floor's receiving queue.
 *
 * DELIBERATELY not `overdueDeliveryWhere`: that one asks "should this already be here?", which is
 * the chase. This one asks "is there kit to receive at my door?", which is the WORK, and it is the
 * exact set the warehouse's Rental deliveries pane lists (`onHireFilter("awaiting")`). Counting the
 * narrower set left every hire not yet due with a Receive button and no badge in the product.
 */
export function countAwaitingHireDeliveries(warehouseIds?: string[]): Promise<number> {
  return prisma.purchaseOrderRentalLine.count({ where: atWarehouses(awaitingDeliveryWhere(), warehouseIds) });
}

/**
 * The same queue split per receiving warehouse — the Warehouses list's per-row count and the
 * warehouse detail tab count.
 *
 * Tallied in memory rather than with a groupBy because the warehouse lives on the ORDER, not on the
 * line, and Prisma cannot group by a relation field. The set is small by construction: only hires
 * nobody has received yet, which is a desk-sized queue, not a history.
 */
export async function countAwaitingHireDeliveriesByWarehouse(
  warehouseIds?: string[],
): Promise<Record<string, number>> {
  const rows = await prisma.purchaseOrderRentalLine.findMany({
    where: atWarehouses(awaitingDeliveryWhere(), warehouseIds),
    select: { purchaseOrder: { select: { warehouseId: true } } },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    // An order with no warehouse would otherwise tally under "undefined" and render as a phantom row.
    const id = r.purchaseOrder?.warehouseId;
    if (id) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

// ONE list, so the endpoint's `?status=` whitelist cannot drift from the filter's own vocabulary. A
// value the filter resolves but the endpoint refuses is silently downgraded to "all" — which opens
// EVERY live hire under a badge that counted three.
// `returned` is the ODD ONE OUT and belongs here anyway: every other entry narrows the LIVE hires,
// and it selects the finished ones. A register of its own would need a second copy of every column,
// filter and export this list already has — and the row is the same row, at the end of the same life.
export const ON_HIRE_STATUSES = ["all", "expiring", "overdue", "awaiting", "late", "returned", "cancelled"] as const;
export type OnHireStatus = (typeof ON_HIRE_STATUSES)[number];

// The two pills that select rows OUTSIDE the live set — read, not worked, and so sorted as history.
// Their own list because `TERMINAL_HIRE_STATUSES` is a vocabulary of hire STATUSES and this is one of
// FILTERS; they happen to spell the same two words, and a shared constant would tie the day the
// register grows a pill that is not a bare status to the day a hire grows a state.
const TERMINAL_ON_HIRE_STATUSES: readonly OnHireStatus[] = ["returned", "cancelled"];

// Exported so the badge that links here can be tested against the filter it opens: "Hires not yet
// received" counted `overdueDeliveryWhere` while its link resolved to `awaiting`, so the badge read
// one number and the list showed a larger one.
export function onHireFilter(status: OnHireStatus, todayStart: Date): Prisma.PurchaseOrderRentalLineWhereInput {
  if (status === "expiring") return expiringSoonWhere(todayStart);
  if (status === "overdue") return overdueWhere(todayStart);
  // The receiving queue. Deliberately part of THIS list rather than a screen of its own: it is the
  // same rows at an earlier point in the same life, and a separate page would need its own copy of
  // every column, filter and export.
  if (status === "awaiting") return awaitingDeliveryWhere();
  // The narrower half of that queue — nothing has arrived AND the hire has already started. It is
  // what the `rentals.awaiting_delivery` badge counts, and it exists so that badge can open exactly
  // its own rows instead of the whole receiving queue.
  if (status === "late") return overdueDeliveryWhere(todayStart);
  // Finished hires — what a period report is built from. See returnedWhere for why it asks the
  // status rather than `fullyReturned`.
  if (status === "returned") return returnedWhere();
  // Kept OUT of `returned` on purpose — that pill is the finance register and a hire that never
  // happened is not hire spend. It still needs a home, or a short close would create a record found
  // on no screen.
  if (status === "cancelled") return cancelledWhere();
  return onHireWhere();
}

/**
 * Where a typed word is looked for on a hire — the item, the order, the supplier, the item's code.
 *
 * escapeRegex on every arm: Prisma injects `contains` into a Mongo $regex unescaped, so a bare "("
 * from a search box is a 500 rather than no results.
 */
function searchArms(raw: string): Prisma.PurchaseOrderRentalLineWhereInput[] {
  const q = escapeRegex(raw.trim());
  return [
    { itemName: { contains: q, mode: "insensitive" } },
    { purchaseOrder: { is: { code: { contains: q, mode: "insensitive" } } } },
    { purchaseOrder: { is: { supplierName: { contains: q, mode: "insensitive" } } } },
    { rentalItem: { is: { code: { contains: q, mode: "insensitive" } } } },
  ];
}

export async function listOnHire(args: {
  status: OnHireStatus;
  todayStart: Date;
  page: number;
  pageSize: number;
  /** Narrow to the hires arriving at ONE warehouse — the receiving pane on a warehouse page. */
  warehouseId?: string;
  /** Narrow to ONE catalogue item — the live hires shown on its own page, and where a scan lands. */
  rentalItemId?: string;
  /** Item, order code or supplier — the same free-text box every other register in the app carries. */
  search?: string;
}) {
  const base = onHireFilter(args.status, args.todayStart);
  // Every hire on an order addressed to this warehouse — including the lines carrying their own
  // delivery address.
  //
  // Those were excluded at first, on the reasoning that a line with a site address never reaches the
  // warehouse door. That reasoning hid rows: an order raised against this warehouse simply vanished
  // from its queue, with nothing on screen saying where it had gone, and the delivery it represents
  // still has to be confirmed by somebody. The order's warehouse is who chases it, so the row stays —
  // and the list shows the destination instead, which is the honest version of the same fact.
  // Narrowed through the SHARED helper, which is also what the receiving badge counts with — the
  // pane and the badge that opens it cannot select different rows.
  const where = {
    ...atWarehouses(base, args.warehouseId ? [args.warehouseId] : undefined),
    // Merged onto the shared predicate rather than replacing it: "this item's live hires" must mean
    // the same thing as the badge that counts them, only narrower.
    ...(args.rentalItemId ? { rentalItemId: args.rentalItemId } : {}),
    // The free-text box, ANDed on so it can only ever narrow the window the caller asked for — a
    // search that widened a badge's rows would put hires on screen the badge never counted.
    //
    // Under `AND` rather than a top-level `OR`, because the predicates above own the top level: an
    // `OR` written there would sit BESIDE them instead of inside, and a search for "Fibre" would
    // return every matching hire on every order, overdue or not.
    ...(args.search ? { AND: [{ OR: searchArms(args.search) }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.purchaseOrderRentalLine.findMany({
      where,
      include: {
        // `deliveryAddress` + the warehouse block come along so the collection point can be resolved
        // by the SAME function the order document uses (rentalReturn.ts) rather than a second guess.
        purchaseOrder: {
          select: {
            id: true, code: true, status: true, supplierName: true, warehouseId: true, deliveryAddress: true,
            warehouse: { select: { name: true, addressLine1: true, addressLine2: true, city: true, county: true, postcode: true, country: true } },
          },
        },
        rentalItem: { select: { id: true, code: true, name: true } },
      },
      // Soonest deadline first while a hire is LIVE — that list is a worklist, and the top of it is
      // what is owed next. A finished hire owes nothing, so its register reads as history instead:
      // most recently ended first. Descending on the same key, so `@@index([hireStatus, hireEndDate])`
      // still serves it and no second index is needed.
      //
      // BOTH terminal pills, not just `returned`: sorted ascending, the cancelled register presented
      // hires that never happened as a worklist with the most urgent at the top — a queue of work
      // nobody can do, which is the one reading a terminal list must never invite.
      orderBy: { hireEndDate: TERMINAL_ON_HIRE_STATUSES.includes(args.status) ? "desc" : "asc" },
      skip: (args.page - 1) * args.pageSize,
      take: args.pageSize,
    }),
    prisma.purchaseOrderRentalLine.count({ where }),
  ]);
  return { rows, total };
}

const REMINDER_LEASE_MS = 2 * 60 * 1000;

// Mongo: a field the create omitted does NOT match `{ f: null }`, so both arms are always needed.
const UNSET_NOTIFIED = { OR: [{ deadlineNotifiedAt: null }, { deadlineNotifiedAt: { isSet: false } }] };
const claimable = (now: Date) => ({
  OR: [
    { deadlineNotifyClaimExpires: null },
    { deadlineNotifyClaimExpires: { isSet: false } },
    { deadlineNotifyClaimExpires: { lt: now } },
  ],
});

/**
 * Live hires whose reminder is due, not yet sent, not held by a live lease, and still being tried.
 *
 * `maxAttempts` is the last of those and it is not cosmetic. Giving up writes neither
 * `deadlineNotifiedAt` nor a lease, so without this bound a given-up row keeps matching for as long
 * as it remains inside its notify window — and it sorts to the FRONT, because `hireEndDate asc` puts
 * the soonest first and a row that has burned every attempt is among the soonest. It therefore
 * consumes one of `take` slots on every pass. A few days of broken SMTP fills the batch with rows
 * that will never be sent, and a genuinely-due hire past position `take` gets no reminder at all.
 */
export function findDueForReminder(todayStart: Date, take: number, maxAttempts: number) {
  return prisma.purchaseOrderRentalLine.findMany({
    where: {
      ...expiringSoonWhere(todayStart),
      deadlineNotifyAttempts: { lt: maxAttempts },
      AND: [UNSET_NOTIFIED, claimable(new Date())],
    },
    include: { purchaseOrder: { select: { code: true, pmEmail: true, createdBy: true } } },
    take,
    orderBy: { hireEndDate: "asc" },
  });
}

/**
 * Take the reminder lease under THIS worker's token, or lose the race. The affected-row count is
 * the whole mechanism: two instances sweeping together means one of them simply skips the row.
 */
export async function claimReminder(lineId: string, token: string, leaseMs = REMINDER_LEASE_MS): Promise<boolean> {
  const now = new Date();
  const res = await prisma.purchaseOrderRentalLine.updateMany({
    where: { id: lineId, ...UNSET_NOTIFIED, AND: [claimable(now)] },
    data: { deadlineNotifyClaimToken: token, deadlineNotifyClaimExpires: new Date(now.getTime() + leaseMs) },
  });
  return res.count === 1;
}

/**
 * Complete the reminder — ONLY if this worker still holds the lease it claimed.
 *
 * Conditional on the TOKEN, not just the id. A worker whose lease expired inside a slow SMTP call
 * no longer owns the row, and an unconditional write here would stamp over whoever does. `false`
 * means the lease was lost mid-send; the caller records that and writes nothing else.
 */
export async function markReminderSent(lineId: string, token: string): Promise<boolean> {
  const res = await prisma.purchaseOrderRentalLine.updateMany({
    where: { id: lineId, deadlineNotifyClaimToken: token },
    data: { deadlineNotifiedAt: new Date(), deadlineNotifyClaimToken: null, deadlineNotifyClaimExpires: null },
  });
  return res.count === 1;
}

/**
 * Hand the row back after a failed send so the next pass can retry — again only if this worker
 * still holds it. THIS is the write the token exists for: an unconditional release by a stale
 * worker would clear the LIVE worker's lease, and a third worker could then claim mid-send, turning
 * a bounded duplicate into an unbounded one.
 */
export async function releaseReminderClaim(lineId: string, token: string, attempts: number): Promise<boolean> {
  const res = await prisma.purchaseOrderRentalLine.updateMany({
    where: { id: lineId, deadlineNotifyClaimToken: token },
    data: { deadlineNotifyClaimToken: null, deadlineNotifyClaimExpires: null, deadlineNotifyAttempts: attempts },
  });
  return res.count === 1;
}
