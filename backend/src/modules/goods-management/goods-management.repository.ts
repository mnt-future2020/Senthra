import { Prisma, type EngineerCustomerStockHolding, type EngineerCustomerStockTransaction, type DamagedStockBalance, type DamagedStockTransaction, type CustomerStockEntry, type JobStockSummary } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";

const GM_CODE_PREFIX = "GM";

const withRelations = {
  items: { include: { irmItem: { select: { id: true, code: true, name: true, baseUnit: true } } } },
  job: { select: { id: true, jobNumber: true, name: true, customerId: true, customerName: true } },
} satisfies Prisma.JobStockMovementInclude;
export type JobStockMovementWithRelations = Prisma.JobStockMovementGetPayload<{ include: typeof withRelations }>;

export interface MovementLineRow {
  source: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  condition: string;
  jobKitLineId: string | null;
  scannedCode: string | null;
  damagePhotoUrl: string | null;
  damageReason: string | null;
  notes: string | null;
}

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
async function highestGmNumber(): Promise<number> {
  const head = `${GM_CODE_PREFIX}-`;
  const rows = await prisma.jobStockMovement.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const s = code.slice(head.length);
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}
async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGmNumber();
  try {
    await prisma.counter.create({ data: { key: GM_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}
async function fastForwardCounter(): Promise<void> {
  const start = await highestGmNumber();
  try {
    await prisma.counter.upsert({ where: { key: GM_CODE_PREFIX }, create: { key: GM_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch { /* best-effort */ }
}

// Create a posted movement + its lines atomically with a unique GM-#### code, running the caller's
// balance/ledger writes inside the SAME transaction via the `apply` callback.
export async function createMovementWithCode(
  header: Omit<Prisma.JobStockMovementUncheckedCreateInput, "code" | "items">,
  lines: MovementLineRow[],
  apply: (tx: Prisma.TransactionClient, movementId: string, code: string) => Promise<void>,
): Promise<JobStockMovementWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${GM_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const m = await tx.jobStockMovement.create({
          data: { deletedAt: null, ...header, code, items: { create: lines.map((l) => ({ ...l })) } },
        });
        await apply(tx, m.id, code);
        return tx.jobStockMovement.findUniqueOrThrow({ where: { id: m.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique goods-management code.");
}

// Tx-aware GM-#### allocator — used by the engineer-transfer attribution path, which must write its
// JobStockMovement inside the transfer's OWN completion transaction (so the van-to-van stock move and
// the job attribution commit atomically). The counter row exists in any system that has ever issued
// goods; the upsert covers the near-impossible first-ever-GM-code path. A concurrent increment surfaces
// as a Mongo write-conflict (P2034) which the transfer's completeTransferTx retry wrapper already handles.
async function nextGmSequenceTx(tx: Prisma.TransactionClient): Promise<number> {
  try {
    const c = await tx.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGmNumber();
  const c = await tx.counter.upsert({ where: { key: GM_CODE_PREFIX }, create: { key: GM_CODE_PREFIX, seq: start + 1 }, update: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

export interface AttributionHeader {
  jobId: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  notes: string | null;
  performedBy: string | null;
  createdBy: string | null;
}

// Attribution-only issue movement: records that `lines` were issued to a job's engineer sourced from
// ANOTHER engineer's van (a job-scoped engineer→engineer transfer fulfilling a kit request), NOT a
// warehouse. It writes ONLY the JobStockMovement (direction "issue", no warehouse) + its lines — it does
// NOT touch any stock balance, because the transfer's own `transfer_in` already credited the recipient's
// van. This is precisely what makes the job's Issued tally rise: getJobKitTallies / kitLineSplit /
// getOpenDemand all sum posted issue lines by jobKitLineId. Runs inside the caller's transaction.
export async function createJobIssueAttributionTx(tx: Prisma.TransactionClient, header: AttributionHeader, lines: MovementLineRow[]): Promise<void> {
  const seq = await nextGmSequenceTx(tx);
  const code = `${GM_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
  // Create only — the caller ignores the returned row, so we skip the extra include-read (it was adding
  // a round-trip to the latency-sensitive transfer-completion transaction).
  await tx.jobStockMovement.create({
    data: {
      deletedAt: null,
      code,
      jobId: header.jobId,
      direction: "issue",
      engineerId: header.engineerId,
      engineerName: header.engineerName,
      engineerEmail: header.engineerEmail,
      warehouseId: null,
      warehouseName: null,
      warehouseCode: null,
      status: "posted",
      postedAt: new Date(),
      notes: header.notes,
      performedBy: header.performedBy,
      createdBy: header.createdBy,
      items: { create: lines.map((l) => ({ ...l })) },
    },
  });
}

// Recompute + persist a job's coarse goodsStatus from its posted movements. Runs OUTSIDE any transaction
// (non-tx `prisma`) — the engineer-transfer path calls this AFTER its completion transaction commits, so
// the derived-summary reads/write don't count against Mongo's 5s interactive-transaction limit. Best-
// effort: the per-line tallies are always correct from the movements; this coarse summary self-heals on
// the next movement if it's ever missed. "issued" only when EVERY kit line is fully issued (gross issue −
// return ≥ planned), else "partially_issued" — matching postIssue's semantics.
export async function recomputeGoodsStatus(jobId: string): Promise<void> {
  const kitLines = await prisma.jobKitLine.findMany({ where: { jobId }, select: { id: true, qty: true } });
  if (kitLines.length === 0) return;
  const movements = await prisma.jobStockMovement.findMany({
    where: { jobId, status: "posted", deletedAt: null },
    select: { direction: true, items: { select: { jobKitLineId: true, qty: true } } },
  });
  const issued = new Map<string, number>();
  for (const m of movements) {
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      if (m.direction === "issue") issued.set(l.jobKitLineId, (issued.get(l.jobKitLineId) ?? 0) + l.qty);
      else if (m.direction === "return") issued.set(l.jobKitLineId, (issued.get(l.jobKitLineId) ?? 0) - l.qty);
    }
  }
  const status = kitLines.every((kl) => (issued.get(kl.id) ?? 0) >= kl.qty) ? "issued" : "partially_issued";

  // ATOMIC guard (no read-then-write TOCTOU): only move the summary when it ISN'T already in a
  // return/reconcile state. This refresh owns ONLY the early issued/partially_issued transition;
  // awaiting_return and reconciled are owned by the return/reconcile flows and must never be regressed
  // by a late-completing job-scoped transfer. The conditional filter is evaluated atomically by Mongo.
  const res = await prisma.jobStockSummary.updateMany({
    where: { jobId, goodsStatus: { notIn: ["awaiting_return", "reconciled"] } },
    data: { goodsStatus: status, lastMovementAt: new Date() },
  });
  // count 0 ⇒ the summary is either in a guarded state (correctly skipped) or doesn't exist yet. A
  // summary is absent ONLY before any issuance, when there's no later state to clobber — create it then.
  // A concurrent create races on the unique jobId and is harmlessly swallowed.
  if (res.count === 0) {
    const exists = await prisma.jobStockSummary.findUnique({ where: { jobId }, select: { jobId: true } });
    if (!exists) await prisma.jobStockSummary.create({ data: { jobId, goodsStatus: status, lastMovementAt: new Date() } }).catch(() => {});
  }
}

export function findMovementsByJob(jobId: string): Promise<JobStockMovementWithRelations[]> {
  return prisma.jobStockMovement.findMany({ where: { jobId, deletedAt: null }, include: withRelations, orderBy: { createdAt: "asc" } });
}
// Batch movements for many jobs in ONE query (queue page enrichment); caller groups by jobId.
export function findMovementsByJobs(jobIds: string[]): Promise<JobStockMovementWithRelations[]> {
  if (jobIds.length === 0) return Promise.resolve([]);
  return prisma.jobStockMovement.findMany({ where: { jobId: { in: jobIds }, deletedAt: null }, include: withRelations, orderBy: { createdAt: "asc" } });
}

// Per-kit-line ISSUED totals for many jobs in ONE query — the minimum needed to tell whether a given
// kit line still has work outstanding. Deliberately lean: no `include: withRelations` (which pulls
// item/warehouse/customer joins for every movement) because the queue's pre-pagination filter runs
// over ALL candidate jobs, not just the page. Returns a Map<jobKitLineId, issuedQty>; a line with no
// movements is simply absent (treat as 0). Returns REDUCE the total — a returned unit is outstanding
// again — matching issuedForKitLine's accounting in the service.
export async function findIssuedQtyByKitLine(jobIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jobIds.length === 0) return out;
  const movements = await prisma.jobStockMovement.findMany({
    where: { jobId: { in: jobIds }, deletedAt: null, status: "posted" },
    select: { direction: true, items: { select: { jobKitLineId: true, qty: true } } },
  });
  for (const m of movements) {
    if (m.direction !== "issue" && m.direction !== "return") continue;
    const sign = m.direction === "issue" ? 1 : -1;
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      out.set(l.jobKitLineId, (out.get(l.jobKitLineId) ?? 0) + sign * l.qty);
    }
  }
  return out;
}

// --- per-job summary -------------------------------------------------------------------------
export function getSummary(jobId: string): Promise<JobStockSummary | null> {
  return prisma.jobStockSummary.findUnique({ where: { jobId } });
}
// Batch summaries for many jobs in ONE query (queue filtering by goodsStatus).
export function getSummariesByJobs(jobIds: string[]): Promise<JobStockSummary[]> {
  if (jobIds.length === 0) return Promise.resolve([]);
  return prisma.jobStockSummary.findMany({ where: { jobId: { in: jobIds } } });
}
export function upsertSummaryTx(tx: Prisma.TransactionClient, jobId: string, data: Prisma.JobStockSummaryUncheckedUpdateInput & { goodsStatus?: string }): Promise<JobStockSummary> {
  return tx.jobStockSummary.upsert({
    where: { jobId },
    create: { jobId, goodsStatus: (data.goodsStatus as string) ?? "not_issued", workSummary: (data.workSummary as string) ?? null, lastMovementAt: new Date() },
    update: { ...data, lastMovementAt: new Date() },
  });
}

// --- engineer customer-stock holding (tx-aware) ----------------------------------------------
export async function upsertCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string, delta: number, snap: { customerId: string | null; customerName?: string | null; itemName: string }): Promise<EngineerCustomerStockHolding> {
  const bal = await tx.engineerCustomerStockHolding.upsert({
    where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } },
    create: { customerStockEntryId, engineerId, quantityOnHand: delta, customerId: snap.customerId, customerName: snap.customerName ?? null, itemName: snap.itemName },
    update: { quantityOnHand: { increment: delta } },
  });
  if (bal.quantityOnHand < 0) throw conflict("Engineer doesn't hold that much of this customer item. Refresh and try again.");
  return bal;
}
export function findCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string): Promise<EngineerCustomerStockHolding | null> {
  return tx.engineerCustomerStockHolding.findUnique({ where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } } });
}
// Non-tx read of one engineer's holding of a customer-stock item — used to cap returns (same source
// the post-return guard checks), so the scan panel's "Held" matches what the server will accept.
export function findCustomerHolding(customerStockEntryId: string, engineerId: string): Promise<EngineerCustomerStockHolding | null> {
  return prisma.engineerCustomerStockHolding.findUnique({ where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } } });
}
export function insertCustomerHoldingTxnTx(tx: Prisma.TransactionClient, data: Prisma.EngineerCustomerStockTransactionUncheckedCreateInput): Promise<EngineerCustomerStockTransaction> {
  return tx.engineerCustomerStockTransaction.create({ data });
}
export function findCustomerHoldingsByEngineer(engineerId: string) {
  return prisma.engineerCustomerStockHolding.findMany({ where: { engineerId, quantityOnHand: { gt: 0 } }, orderBy: { updatedAt: "desc" } });
}
// Resolve customer display names by id — used to backfill holdings whose customerName snapshot is null.
export function findCustomerNamesByIds(ids: string[]) {
  return prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}
// Misc kit-line items issued to an engineer (free-text, no stock balance) — derived from their posted
// issue movements. Misc isn't returned, so "held" = total issued. Returns the raw lines; the service sums.
export async function findMiscIssueLinesByEngineer(engineerId: string): Promise<{ itemName: string; qty: number }[]> {
  const movements = await prisma.jobStockMovement.findMany({
    where: { engineerId, direction: "issue", status: "posted", deletedAt: null },
    select: { items: { where: { source: "misc" }, select: { itemName: true, qty: true } } },
  });
  return movements.flatMap((m) => m.items);
}

// --- customer stock entry quantity (warehouse pool) ------------------------------------------
export async function adjustCustomerStockEntryQtyTx(tx: Prisma.TransactionClient, entryId: string, delta: number): Promise<CustomerStockEntry> {
  const e = await tx.customerStockEntry.update({ where: { id: entryId }, data: { quantity: { increment: delta } } });
  if (e.quantity < 0) throw conflict("Insufficient customer stock for this movement. Refresh and try again.");
  return e;
}
export function findCustomerStockEntryById(entryId: string) {
  return prisma.customerStockEntry.findFirst({
    where: { id: entryId, status: "active" },
    include: { customer: { select: { name: true } } },
  });
}
// Batch active customer-stock entries (id + quantity) for queue-page "available" tallies — ONE query.
export function findCustomerStockEntriesByIds(ids: string[]): Promise<{ id: string; quantity: number }[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.customerStockEntry.findMany({ where: { id: { in: ids }, status: "active" }, select: { id: true, quantity: true } });
}
export function findCustomerStockEntryQtyTx(tx: Prisma.TransactionClient, entryId: string) {
  return tx.customerStockEntry.findUnique({ where: { id: entryId }, select: { quantity: true } });
}
export function findCustomerStockEntryByBarcode(barcode: string) {
  return prisma.customerStockEntry.findFirst({ where: { barcode, status: "active" } });
}

// --- damaged pool (tx-aware) -----------------------------------------------------------------
export interface DamagedKey { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null; customerId: string | null; itemName: string; }
export async function upsertDamagedBalanceTx(tx: Prisma.TransactionClient, key: DamagedKey, delta: number): Promise<DamagedStockBalance> {
  // Find-or-create by the natural key, then increment. Integrity is enforced by the compound unique
  // index (warehouseId, ownerType, irmItemId, customerStockEntryId): if two concurrent reports for the
  // same item+warehouse both miss the find and race to create, the DB rejects the second insert (and
  // aborts its transaction → the caller surfaces a retryable error) instead of silently splitting the
  // balance across duplicate rows. (Prisma can't express null compound-unique keys, so no upsert here.)
  const existing = await tx.damagedStockBalance.findFirst({
    where: { warehouseId: key.warehouseId, ownerType: key.ownerType, irmItemId: key.irmItemId, customerStockEntryId: key.customerStockEntryId },
  });
  if (!existing) {
    return tx.damagedStockBalance.create({ data: { ...key, quantity: delta } });
  }
  return tx.damagedStockBalance.update({ where: { id: existing.id }, data: { quantity: { increment: delta } } });
}
export function insertDamagedTxnTx(tx: Prisma.TransactionClient, data: Prisma.DamagedStockTransactionUncheckedCreateInput): Promise<DamagedStockTransaction> {
  return tx.damagedStockTransaction.create({ data });
}

// ── Stock Movement History — keyset-paginated customer-consignment + damaged ledger pages ──────────
export interface MovementKeyset { createdAt: Date; id: string }

export interface CustomerTxnFilters {
  dateFrom?: Date;
  dateTo?: Date;
  engineerId?: string;
  customerStockEntryIds?: string[]; // resolved from a customerId filter by the service
  type?: string;
  sourceType?: string;
}
export function findEngineerCustomerTxnPage(f: CustomerTxnFilters, before: MovementKeyset | null, take: number) {
  const and: Prisma.EngineerCustomerStockTransactionWhereInput[] = [];
  if (f.dateFrom) and.push({ createdAt: { gte: f.dateFrom } });
  if (f.dateTo) and.push({ createdAt: { lte: f.dateTo } });
  if (f.engineerId) and.push({ engineerId: f.engineerId });
  if (f.customerStockEntryIds) and.push({ customerStockEntryId: { in: f.customerStockEntryIds } });
  if (f.type) and.push({ type: f.type });
  if (f.sourceType) and.push({ sourceType: f.sourceType });
  if (before) and.push({ OR: [{ createdAt: { lt: before.createdAt } }, { AND: [{ createdAt: before.createdAt }, { id: { lt: before.id } }] }] });
  return prisma.engineerCustomerStockTransaction.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}

export interface DamagedTxnFilters {
  dateFrom?: Date;
  dateTo?: Date;
  warehouseId?: string;
  ownerType?: string;
  irmItemId?: string;
  customerId?: string;
  customerStockEntryIds?: string[];
  sourceType?: string;
  sign?: "pos" | "neg"; // write_off (+) | restore (−), derived from the `type` filter
}
export function findDamagedTxnPage(f: DamagedTxnFilters, before: MovementKeyset | null, take: number) {
  const and: Prisma.DamagedStockTransactionWhereInput[] = [];
  if (f.dateFrom) and.push({ createdAt: { gte: f.dateFrom } });
  if (f.dateTo) and.push({ createdAt: { lte: f.dateTo } });
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId });
  if (f.ownerType) and.push({ ownerType: f.ownerType });
  if (f.irmItemId) and.push({ irmItemId: f.irmItemId });
  if (f.customerId) and.push({ customerId: f.customerId });
  if (f.customerStockEntryIds) and.push({ customerStockEntryId: { in: f.customerStockEntryIds } });
  if (f.sourceType) and.push({ sourceType: f.sourceType });
  if (f.sign === "pos") and.push({ quantityDelta: { gt: 0 } });
  if (f.sign === "neg") and.push({ quantityDelta: { lt: 0 } });
  if (before) and.push({ OR: [{ createdAt: { lt: before.createdAt } }, { AND: [{ createdAt: before.createdAt }, { id: { lt: before.id } }] }] });
  return prisma.damagedStockTransaction.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}

// Resolve customer-stock-entry metadata by id — the customer ledgers carry only the entry id.
export interface CustomerEntryMeta { itemName: string; sku: string | null; customerId: string | null; customerName: string | null }
export async function findCustomerEntryMetaByIds(ids: string[]): Promise<Map<string, CustomerEntryMeta>> {
  const out = new Map<string, CustomerEntryMeta>();
  if (!ids.length) return out;
  const rows = await prisma.customerStockEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, itemName: true, sku: true, customerId: true, customer: { select: { name: true } } },
  });
  for (const r of rows) out.set(r.id, { itemName: r.itemName, sku: r.sku ?? null, customerId: r.customerId ?? null, customerName: r.customer?.name ?? null });
  return out;
}
// Resolve the warehouse each customer-stock entry is stored in, by id — batched (one query) for the
// kit-request approve modal, which shows the pickup location per customer_stock line read-only.
export async function findCustomerEntryWarehousesByIds(ids: string[]): Promise<Map<string, { name: string | null; code: string | null }>> {
  const out = new Map<string, { name: string | null; code: string | null }>();
  if (!ids.length) return out;
  const rows = await prisma.customerStockEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, warehouse: { select: { name: true, code: true } } },
  });
  for (const r of rows) out.set(r.id, { name: r.warehouse?.name ?? null, code: r.warehouse?.code ?? null });
  return out;
}

// Resolve customer-stock-entry ids belonging to a customer — to translate a customerId filter for the
// consignment ledger (which stores only the entry id).
export async function findCustomerStockEntryIdsByCustomer(customerId: string): Promise<string[]> {
  const rows = await prisma.customerStockEntry.findMany({ where: { customerId }, select: { id: true } });
  return rows.map((r) => r.id);
}

// Search a single customer's ACTIVE, in-stock consignment entries by name/sku — powers the kit-request
// composer's "add a customer-owned item" search. Scoped HARD to customerId (never leaks another
// customer's stock), active-only, quantity > 0. One row per entry (a serialized item is one row per
// serial). `contains` is a raw Mongo regex, so escape the term (see irm.repository search).
export interface CustomerStockSearchRow {
  id: string;
  itemName: string;
  sku: string | null;
  uom: string | null;
  quantity: number;
  serialNumber: string | null;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
}
export async function searchActiveCustomerStock(customerId: string, term: string, take = 20): Promise<CustomerStockSearchRow[]> {
  const q = escapeRegex(term);
  const rows = await prisma.customerStockEntry.findMany({
    where: {
      customerId,
      status: "active",
      quantity: { gt: 0 },
      OR: [
        { itemName: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: { itemName: "asc" },
    take,
    select: {
      id: true,
      itemName: true,
      sku: true,
      uom: true,
      quantity: true,
      serialNumber: true,
      warehouseId: true,
      warehouse: { select: { name: true, code: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    itemName: r.itemName,
    sku: r.sku ?? null,
    uom: r.uom ?? null,
    quantity: r.quantity,
    serialNumber: r.serialNumber ?? null,
    warehouseId: r.warehouseId,
    warehouseName: r.warehouse?.name ?? "",
    warehouseCode: r.warehouse?.code ?? null,
  }));
}
const damagedBalanceInclude = {
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.DamagedStockBalanceInclude;

export type DamagedBalanceWithWarehouse = Prisma.DamagedStockBalanceGetPayload<{
  include: typeof damagedBalanceInclude;
}>;

export function findDamagedByWarehouse(warehouseId: string): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { warehouseId, quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}
export function findDamagedByCustomer(customerId: string): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { customerId, quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}
export function findAllDamaged(): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({ where: { quantity: { gt: 0 } }, include: damagedBalanceInclude, orderBy: { updatedAt: "desc" } });
}
// Company-owned damaged balances for ONE IRM item — the item-scoped slice of findAllDamaged (identical
// include/order, narrowed to ownerType="company" + this irmItemId). Company damaged is the only damaged
// flavour an IRM item has (customer-owned damaged rows map to customer_stock, never to this item).
// No dedicated irmItemId index on DamagedStockBalance: the damaged pool is small and this already reads a
// strict subset of the old whole-pool assembleAll scan, so an index isn't warranted yet. If that pool ever
// grows large, add @@index([ownerType, irmItemId]) and revisit.
export function findCompanyDamagedByIrmItem(irmItemId: string): Promise<DamagedBalanceWithWarehouse[]> {
  return prisma.damagedStockBalance.findMany({
    where: { quantity: { gt: 0 }, ownerType: "company", irmItemId },
    include: damagedBalanceInclude,
    orderBy: { updatedAt: "desc" },
  });
}

// EVERY damaged-ledger row for ONE balance's natural key, newest first — the drill-down behind a
// damaged row. The list view can only ever show the LATEST reason/photo per balance (see
// findLatestDamagedTxnsByBalances), so without this the reason and photo captured on every EARLIER
// report were stored but unreachable from any screen. Ordered by (createdAt, id) desc so
// same-millisecond rows still come back in a stable, deterministic order.
//
// Deliberately unpaginated: this is one item at one warehouse, so the row count is the number of
// times that item was damaged there — single digits in practice. `take` caps it defensively so a
// pathological key can never stream an unbounded result set into memory; the service reports when
// the cap was hit rather than silently truncating.
export function findDamagedTxnsByKey(
  key: { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null },
  take: number,
): Promise<DamagedStockTransaction[]> {
  return prisma.damagedStockTransaction.findMany({
    where: {
      warehouseId: key.warehouseId,
      ownerType: key.ownerType,
      irmItemId: key.irmItemId,
      customerStockEntryId: key.customerStockEntryId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}

// Thresholds for the self-measurement in findLatestDamagedTxnsByBalances below. Deliberately quiet
// in normal operation: at realistic damage volume a call reads tens of rows in single-digit
// milliseconds, so nothing is logged and the log stays useful. Crossing either line is the EVIDENCE
// that the accepted ceiling documented on that function has actually been reached.
const DAMAGED_LOOKUP_ROWS_WARN = 2_000; // ledger rows read in one call
const DAMAGED_LOOKUP_MS_WARN = 500; // wall-clock for the single query

/** Returns the most-recent DamagedStockTransaction for each balance row, keyed by balanceId.
 *  We match on warehouseId + ownerType + irmItemId + customerStockEntryId (the natural key).
 *
 *  KNOWN, ACCEPTED CEILING — read before changing. This reads EVERY ledger row belonging to the
 *  balances it is given and reduces in memory to one value each, so the rows it READS grow with the
 *  damage history forever while the rows it RETURNS stay constant (one per list row). It is indexed
 *  (warehouseId, ownerType, irmItemId, customerStockEntryId, createdAt) so this is a seek, not a
 *  scan — but the index bounds the cost per row, not the row count.
 *
 *  DO NOT "fix" this with a plain `take`. The query orders by createdAt across ALL balances at once,
 *  so a global limit can come back holding only the busiest item's rows and leave every OTHER row's
 *  reason column silently BLANK — wrong data that looks right, which is worse than a slow query.
 *  Server-side pagination is also ruled out: the damaged list's search filters the full set
 *  client-side. The only correct fix is denormalising latestReason/latestPhotoUrl onto
 *  DamagedStockBalance, written where the quantity is written — which touches the damage WRITE path
 *  in four places plus a backfill for existing rows.
 *
 *  That fix is deliberately NOT done on prediction. The call measures itself instead and stays
 *  silent until the numbers say otherwise; when the warning below starts recurring in production
 *  logs, that is the trigger to implement the denormalised design.
 */
export async function findLatestDamagedTxnsByBalances(
  balances: Pick<DamagedBalanceWithWarehouse, "id" | "warehouseId" | "ownerType" | "irmItemId" | "customerStockEntryId">[],
): Promise<Map<string, { reason: string; photoUrl: string | null }>> {
  const result = new Map<string, { reason: string; photoUrl: string | null }>();
  if (balances.length === 0) return result;

  // Fetch the latest transaction per natural key via a single query, then pick the max.
  // We fetch all matching transactions (in practice each balance has few txns) and reduce in-memory.
  const startedAt = Date.now();
  const txns = await prisma.damagedStockTransaction.findMany({
    where: {
      OR: balances.map((b) => ({
        warehouseId: b.warehouseId,
        ownerType: b.ownerType,
        irmItemId: b.irmItemId ?? null,
        customerStockEntryId: b.customerStockEntryId ?? null,
      })),
    },
    select: { warehouseId: true, ownerType: true, irmItemId: true, customerStockEntryId: true, reason: true, photoUrl: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const durationMs = Date.now() - startedAt;

  // Amplification = rows READ per row RETURNED. This is the number that actually argues for
  // denormalising (a 1× call wastes nothing; a 15× call throws away 14 rows out of every 15), so it
  // is logged alongside the raw counts rather than left to be inferred from them.
  if (txns.length >= DAMAGED_LOOKUP_ROWS_WARN || durationMs >= DAMAGED_LOOKUP_MS_WARN) {
    const amplification = (txns.length / balances.length).toFixed(1);
    console.warn(
      `[damaged-stock] latest-txn lookup read ${txns.length} ledger row(s) in ${durationMs}ms to enrich ` +
        `${balances.length} damaged row(s) (${amplification}x amplification). If this recurs, denormalise ` +
        `latestReason/latestPhotoUrl onto DamagedStockBalance — see the note on this function.`,
    );
  }

  // Build a lookup: natural-key → latest txn seen (since query is desc, first hit wins).
  const seen = new Set<string>();
  const latestByKey = new Map<string, { reason: string; photoUrl: string | null }>();
  for (const t of txns) {
    const key = `${t.warehouseId}|${t.ownerType}|${t.irmItemId ?? ""}|${t.customerStockEntryId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      latestByKey.set(key, { reason: t.reason, photoUrl: t.photoUrl });
    }
  }

  // Map balanceId → latest txn data.
  for (const b of balances) {
    const key = `${b.warehouseId}|${b.ownerType}|${b.irmItemId ?? ""}|${b.customerStockEntryId ?? ""}`;
    const txn = latestByKey.get(key);
    if (txn) result.set(b.id, txn);
  }

  return result;
}

// --- overdue holdings (jobs whose stock is still out > N days) --------------------------------
// `warehouseId` narrows to the issues made FROM one warehouse — the Goods Management tab is a
// per-warehouse surface, so its Overdue section must not report another warehouse's holdings.
// Omitted (the Inventory Hub's company-wide read) returns every warehouse's.
export function findRecentMovementsForOverdue(cutoff: Date, warehouseId?: string) {
  return prisma.jobStockMovement.findMany({
    where: {
      direction: "issue",
      status: "posted",
      deletedAt: null,
      createdAt: { lt: cutoff },
      ...(warehouseId ? { warehouseId } : {}),
    },
    include: withRelations,
    orderBy: { createdAt: "asc" },
  });
}

// --- Inventory Hub aggregation reads --------------------------------------------------
export function findAllCustomerHoldings() {
  return prisma.engineerCustomerStockHolding.findMany({ where: { quantityOnHand: { gt: 0 } } });
}
export function countOverdueIssues(beforeDate: Date): Promise<number> {
  return prisma.jobStockMovement.count({
    where: { direction: "issue", status: "posted", deletedAt: null, createdAt: { lt: beforeDate } },
  });
}

/** Dashboard read-model: DISTINCT unreconciled jobs with a posted issue older than `cutoff` —
 *  the same population OverdueHoldingsView lists, as a cheap count (no per-job enrichment).
 *  A job with no jobStockSummary yet counts as unreconciled (summary is created on first issue,
 *  so an old posted issue without one is a legacy/edge row — still outstanding). */
export async function countOverdueUnreconciledJobs(cutoff: Date, warehouseIds?: string[]): Promise<number> {
  const movements = await prisma.jobStockMovement.findMany({
    where: {
      direction: "issue",
      status: "posted",
      deletedAt: null,
      createdAt: { lt: cutoff },
      ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
    },
    select: { jobId: true },
    distinct: ["jobId"],
  });
  if (movements.length === 0) return 0;
  const jobIds = movements.map((m) => m.jobId);
  const reconciled = await prisma.jobStockSummary.count({
    where: { jobId: { in: jobIds }, goodsStatus: "reconciled" },
  });
  return jobIds.length - reconciled;
}
// Gross units WRITTEN OFF as damaged since `since` — write-offs only (quantityDelta > 0). Restores
// carry a negative delta; netting them in here would understate the "damaged this month" KPI and could
// even render it negative when this month's restores exceed this month's write-offs.
export async function countDamagedUnitsSince(since: Date): Promise<number> {
  const agg = await prisma.damagedStockTransaction.aggregate({
    _sum: { quantityDelta: true },
    where: { createdAt: { gte: since }, quantityDelta: { gt: 0 } },
  });
  return Number(agg._sum.quantityDelta ?? 0);
}
export function findRecentJobMovementsAll(skip: number, take: number) {
  return prisma.jobStockMovement.findMany({
    where: { status: "posted", deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: { items: true },
  });
}

// --- Damaged restore (reverse a write-off) -------------------------------------------

// Load the DamagedStockBalance by natural key (warehouseId + ownerType + irmItemId/customerStockEntryId).
export function findDamagedBalance(key: { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null }): Promise<DamagedStockBalance | null> {
  return prisma.damagedStockBalance.findFirst({
    where: {
      warehouseId: key.warehouseId,
      ownerType: key.ownerType,
      irmItemId: key.irmItemId,
      customerStockEntryId: key.customerStockEntryId,
    },
  });
}

// Decrement a DamagedStockBalance by qty inside an existing transaction and append a reversal ledger row.
// Returns the updated balance quantity (balanceAfter).
export async function decrementDamagedBalanceTx(
  tx: Prisma.TransactionClient,
  balanceId: string,
  qty: number,
  txnData: Omit<Prisma.DamagedStockTransactionUncheckedCreateInput, "balanceAfter">,
): Promise<number> {
  // Atomic guard: decrement ONLY when enough damaged units remain (quantity >= qty). restoreDamaged
  // validates availability before opening the tx, but that read is outside this transaction, so two
  // concurrent (or back-to-back) restores could both pass it. The `gte` filter makes the write itself
  // the check — the loser matches zero rows and we roll the whole restore back instead of driving the
  // damaged balance negative and over-crediting usable stock.
  const res = await tx.damagedStockBalance.updateMany({
    where: { id: balanceId, quantity: { gte: qty } },
    data: { quantity: { decrement: qty } },
  });
  if (res.count === 0) throw conflict("Damaged stock changed — refresh and try again.");
  const balance = await tx.damagedStockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true } });
  const balanceAfter = balance.quantity;
  await tx.damagedStockTransaction.create({ data: { ...txnData, balanceAfter } });
  return balanceAfter;
}
