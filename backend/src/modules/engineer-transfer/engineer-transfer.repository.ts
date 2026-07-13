import { Prisma, type EngineerStockTransfer, type EngineerStockTransferLine } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";
import { upsertEngineerBalanceTx, findEngineerBalanceTx, insertEngineerTxnTx } from "#modules/engineer-stock/engineer-stock.repository.js";
import { upsertCustomerHoldingTx, findCustomerHoldingTx, insertCustomerHoldingTxnTx, createJobIssueAttributionTx, recomputeGoodsStatus } from "#modules/goods-management/goods-management.repository.js";
import type { MovementLineRow } from "#modules/goods-management/goods-management.repository.js";

// ---- Types -----------------------------------------------------------------------------------

export type TransferWithLines = EngineerStockTransfer & { lines: EngineerStockTransferLine[] };

// ---- Payload type for createTransfer ---------------------------------------------------------

export interface CreateTransferData {
  code: string;
  status: string;
  fromEngineerId: string;
  fromEngineerName: string;
  fromEngineerEmail: string;
  fromEngineerPhone?: string | null;
  toEngineerId: string;
  toEngineerName: string;
  toEngineerEmail: string;
  requestedById: string;
  requestedByEmail: string;
  requestedByKind: string;
  reason: string;
  notes?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  attachments: string[];
  requireSignature: boolean;
  createdBy?: string | null;
}

export interface CreateTransferLineData {
  ownership: string;
  irmItemId?: string | null;
  customerStockEntryId?: string | null;
  itemName: string;
  sku?: string | null;
  uom?: string | null;
  quantity: number;
  // Set when this transfer fulfils a job kit request — the kit line to attribute the received qty to.
  jobKitLineId?: string | null;
}

// ---- Code allocation (ENG-####, atomic Counter + retry) -------------------------------------

const ENG_CODE_PREFIX = "ENG";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}

function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestEngNumber(): Promise<number> {
  const head = `${ENG_CODE_PREFIX}-`;
  const rows = await prisma.engineerStockTransfer.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextEngSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: ENG_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestEngNumber();
  try {
    await prisma.counter.create({ data: { key: ENG_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: ENG_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardEngCounter(): Promise<void> {
  const start = await highestEngNumber();
  try {
    await prisma.counter.upsert({ where: { key: ENG_CODE_PREFIX }, create: { key: ENG_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch { /* best-effort */ }
}

// Allocate a unique ENG-#### code and create the transfer + its lines atomically. An optional
// `afterCreate` runs INSIDE the same transaction with the new transfer id — used by the kit-request
// approve to stamp the originating request's transferId atomically with the transfer, so a retry can
// never create a duplicate transfer (the request's checkpoint and the transfer commit together).
export async function createTransfer(
  data: CreateTransferData,
  lines: CreateTransferLineData[],
  afterCreate?: (tx: Prisma.TransactionClient, transferId: string) => Promise<void>,
): Promise<TransferWithLines> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextEngSequence();
    const code = `${ENG_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const transfer = await tx.engineerStockTransfer.create({
          data: {
            deletedAt: null,
            ...data,
            code,
            lines: { create: lines },
          },
        });
        if (afterCreate) await afterCreate(tx, transfer.id);
        return tx.engineerStockTransfer.findUniqueOrThrow({ where: { id: transfer.id }, include: { lines: true } });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardEngCounter();
    }
  }
  throw new Error("Could not allocate a unique engineer-transfer code.");
}

// ---- Reads -----------------------------------------------------------------------------------

export function findById(id: string): Promise<TransferWithLines | null> {
  if (!id) return Promise.resolve(null);
  return prisma.engineerStockTransfer.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
}

export interface ListForEngineerParams {
  role?: "incoming" | "outgoing" | "all";
  status?: string;
  sort?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

// Free-text search across the denormalised, list-visible fields (code, reason, both party names).
// The term is escaped: Prisma's Mongo connector compiles `contains` into an unescaped `$regularExpression`,
// so a raw "(" or "[" throws P2010 (→ 500) and ".*" would match everything — see escapeRegex.
function searchOr(s: string): Prisma.EngineerStockTransferWhereInput[] {
  const term = escapeRegex(s);
  return [
    { code: { contains: term, mode: "insensitive" } },
    { reason: { contains: term, mode: "insensitive" } },
    { fromEngineerName: { contains: term, mode: "insensitive" } },
    { toEngineerName: { contains: term, mode: "insensitive" } },
  ];
}

function engineerWhere(engineerId: string, role: "incoming" | "outgoing" | "all" = "all", status?: string, search?: string): Prisma.EngineerStockTransferWhereInput {
  const and: Prisma.EngineerStockTransferWhereInput[] = [{ deletedAt: null }];
  if (role === "incoming") and.push({ fromEngineerId: engineerId });
  else if (role === "outgoing") and.push({ toEngineerId: engineerId });
  else and.push({ OR: [{ fromEngineerId: engineerId }, { toEngineerId: engineerId }] });
  if (status) and.push({ status });
  if (search?.trim()) and.push({ OR: searchOr(search.trim()) });
  return { AND: and };
}

function transferOrderBy(sort?: string): Prisma.EngineerStockTransferOrderByWithRelationInput {
  return sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" };
}

export async function listForEngineer(engineerId: string, params: ListForEngineerParams = {}): Promise<{ transfers: TransferWithLines[]; total: number }> {
  const { role, status, sort, search, page = 1, pageSize = 20 } = params;
  const where = engineerWhere(engineerId, role, status, search);
  const skip = (page - 1) * pageSize;
  const [transfers, total] = await Promise.all([
    prisma.engineerStockTransfer.findMany({ where, include: { lines: true }, orderBy: transferOrderBy(sort), skip, take: pageSize }),
    prisma.engineerStockTransfer.count({ where }),
  ]);
  return { transfers, total };
}

export interface ListAllParams {
  status?: string;
  engineerId?: string;
  ownership?: string;
  sort?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listAll(params: ListAllParams = {}): Promise<{ transfers: TransferWithLines[]; total: number }> {
  const { status, engineerId, ownership, sort, search, page = 1, pageSize = 20 } = params;
  const and: Prisma.EngineerStockTransferWhereInput[] = [{ deletedAt: null }];
  if (status) and.push({ status });
  if (engineerId) and.push({ OR: [{ fromEngineerId: engineerId }, { toEngineerId: engineerId }] });
  if (ownership) and.push({ lines: { some: { ownership } } });
  if (search?.trim()) and.push({ OR: searchOr(search.trim()) });
  const where: Prisma.EngineerStockTransferWhereInput = { AND: and };
  const skip = (page - 1) * pageSize;
  const [transfers, total] = await Promise.all([
    prisma.engineerStockTransfer.findMany({ where, include: { lines: true }, orderBy: transferOrderBy(sort), skip, take: pageSize }),
    prisma.engineerStockTransfer.count({ where }),
  ]);
  return { transfers, total };
}

// Who currently holds a given IRM item (excluding the requester)?
export async function findHoldersForIrm(irmItemId: string, excludeEngineerId: string): Promise<{ engineerId: string; name: string; available: number }[]> {
  const balances = await prisma.engineerStockBalance.findMany({
    where: { irmItemId, quantityOnHand: { gt: 0 }, engineerId: { not: excludeEngineerId } },
    include: { engineer: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { quantityOnHand: "desc" },
  });
  return balances.map((b) => ({
    engineerId: b.engineerId,
    name: b.engineer ? `${b.engineer.firstName} ${b.engineer.lastName}`.trim() : b.engineerId,
    available: b.quantityOnHand,
  }));
}

// Who currently holds a given customer stock entry (excluding the requester)?
export async function findHoldersForCustomer(customerStockEntryId: string, excludeEngineerId: string): Promise<{ engineerId: string; name: string; available: number }[]> {
  const holdings = await prisma.engineerCustomerStockHolding.findMany({
    where: { customerStockEntryId, quantityOnHand: { gt: 0 }, engineerId: { not: excludeEngineerId } },
    include: { engineer: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { quantityOnHand: "desc" },
  });
  return holdings.map((h) => ({
    engineerId: h.engineerId,
    name: h.engineer ? `${h.engineer.firstName} ${h.engineer.lastName}`.trim() : h.engineerId,
    available: h.quantityOnHand,
  }));
}

// A specific engineer's CURRENT transferable holdings (company IRM + customer consignment), with the
// ids + available qty needed to build a transfer line. Used by the admin "New transfer" picker
// (admin already knows the source engineer, so we list what they hold rather than discover holders).
export interface EngineerHoldingOption {
  ownership: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  available: number;
  customerName: string | null;
}
export async function findEngineerHoldings(engineerId: string): Promise<EngineerHoldingOption[]> {
  const [company, customer] = await Promise.all([
    prisma.engineerStockBalance.findMany({
      where: { engineerId, quantityOnHand: { gt: 0 } },
      include: { irmItem: { select: { id: true, code: true, name: true, sku: true, baseUnit: true } } },
      orderBy: { quantityOnHand: "desc" },
    }),
    prisma.engineerCustomerStockHolding.findMany({
      where: { engineerId, quantityOnHand: { gt: 0 } },
      orderBy: { quantityOnHand: "desc" },
    }),
  ]);
  return [
    ...company.map((b) => ({
      ownership: "company" as const,
      irmItemId: b.irmItemId,
      customerStockEntryId: null,
      itemName: b.irmItem?.name ?? "",
      code: b.irmItem?.code ?? null,
      sku: b.irmItem?.sku ?? b.irmItem?.code ?? null,
      uom: b.irmItem?.baseUnit ?? null,
      available: b.quantityOnHand,
      customerName: null,
    })),
    ...customer.map((h) => ({
      ownership: "customer" as const,
      irmItemId: null,
      customerStockEntryId: h.customerStockEntryId,
      itemName: h.itemName,
      code: null,
      sku: null,
      uom: null,
      available: h.quantityOnHand,
      customerName: h.customerName ?? null,
    })),
  ];
}

// Company (IRM) items currently held by OTHER engineers, matching a search term — the engineer-portal
// discovery flow for company stock. Engineers can't browse the IRM catalogue (no irm.view), and SHOULD
// only ever see items that are actually transferable, so we query the HELD balances directly and match
// the joined catalogue row via a relation filter. Querying balances-first (rather than catalogue-first
// + `take`) means the result cap and ordering apply to the actually-held set, so a held match can never
// be dropped because its catalogue row fell outside an arbitrary pre-slice. We also scope the catalogue
// match to live, active items (`deletedAt: null`, `status: "active"`) — every other IrmItem read does —
// so a soft-deleted/deactivated item can't be offered only to be rejected at create time.
export interface CompanyCandidate {
  irmItemId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}
export async function findCompanyHoldingsBySearch(search: string, excludeEngineerId: string): Promise<CompanyCandidate[]> {
  const term = escapeRegex(search.trim());
  if (!term) return [];
  const balances = await prisma.engineerStockBalance.findMany({
    where: {
      quantityOnHand: { gt: 0 },
      engineerId: { not: excludeEngineerId },
      irmItem: {
        is: {
          deletedAt: null,
          status: "active",
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { code: { contains: term, mode: "insensitive" } },
            { sku: { contains: term, mode: "insensitive" } },
          ],
        },
      },
    },
    include: {
      engineer: { select: { firstName: true, lastName: true } },
      irmItem: { select: { name: true, sku: true, code: true, baseUnit: true } },
    },
    orderBy: { quantityOnHand: "desc" },
    take: 50,
  });
  return balances.map((b) => ({
    irmItemId: b.irmItemId,
    itemName: b.irmItem?.name ?? "",
    code: b.irmItem?.code ?? null,
    sku: b.irmItem?.sku ?? b.irmItem?.code ?? null,
    uom: b.irmItem?.baseUnit ?? null,
    engineerId: b.engineerId,
    engineerName: b.engineer ? `${b.engineer.firstName} ${b.engineer.lastName}`.trim() : b.engineerId,
    available: b.quantityOnHand,
  }));
}

// Customer-consignment items currently held by OTHER engineers, matching a search term — the
// engineer-portal discovery flow for customer stock. Customer entries have no shared catalogue to
// browse, so we discover via the HELD items (only what another engineer actually holds, never the
// requester's own), privacy-preserving in the same spirit as the per-item holder discovery.
//
// The holding rows are denormalised to `itemName` only, so matching just `itemName` MISSED items
// searched by their code (sku / barcode / serial). We mirror the company/IRM path instead: resolve
// the matching catalogue entries across all searchable identifiers first, then the live holdings
// other engineers hold for those entries.
export interface CustomerCandidate {
  customerStockEntryId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  barcode: string | null;
  uom: string | null;
  customerName: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}
export async function findCustomerHoldingsBySearch(search: string, excludeEngineerId: string): Promise<CustomerCandidate[]> {
  const term = escapeRegex(search.trim());
  if (!term) return [];
  // EngineerCustomerStockHolding rows are denormalised to `itemName` only and carry no relation back
  // to CustomerStockEntry, so (unlike the company path) we can't reverse-join. We resolve the matching
  // entries first, then the live holdings. The entry pre-query is ordered deterministically and given a
  // generous cap so identical searches are stable and common terms don't silently drop holders.
  const entries = await prisma.customerStockEntry.findMany({
    where: {
      OR: [
        { itemName: { contains: term, mode: "insensitive" } },
        { sku: { contains: term, mode: "insensitive" } },
        { barcode: { contains: term, mode: "insensitive" } },
        { serialNumber: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, sku: true, barcode: true, serialNumber: true, uom: true },
    orderBy: { itemName: "asc" },
    take: 200,
  });
  if (!entries.length) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const holdings = await prisma.engineerCustomerStockHolding.findMany({
    where: {
      quantityOnHand: { gt: 0 },
      engineerId: { not: excludeEngineerId },
      customerStockEntryId: { in: entries.map((e) => e.id) },
    },
    include: { engineer: { select: { firstName: true, lastName: true } } },
    orderBy: { quantityOnHand: "desc" },
    take: 50,
  });
  return holdings.map((h) => {
    const e = byId.get(h.customerStockEntryId);
    return {
      customerStockEntryId: h.customerStockEntryId,
      itemName: h.itemName,
      code: e?.sku ?? e?.barcode ?? e?.serialNumber ?? null,
      sku: e?.sku ?? null,
      barcode: e?.barcode ?? null,
      uom: e?.uom ?? null,
      customerName: h.customerName ?? null,
      engineerId: h.engineerId,
      engineerName: h.engineer ? `${h.engineer.firstName} ${h.engineer.lastName}`.trim() : h.engineerId,
      available: h.quantityOnHand,
    };
  });
}

// ---- Atomic completion (moves stock, writes ledger rows, sets status=completed) --------------

export interface CompleteOptions {
  approverEmail: string;
  overrideByAdmin: boolean;
}

// A transient MongoDB transaction write-conflict (Prisma surfaces it as P2034). Two concurrent
// completions of the same transfer or the same balance doc can hit this; we retry, then degrade to
// a clean business error rather than leaking a raw transaction failure.
function isTxWriteConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

export async function completeTransferTx(transferId: string, opts: CompleteOptions): Promise<TransferWithLines> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completed = await completeTransferOnce(transferId, opts);
      // Job attribution wrote an issue movement inside the tx above; refresh the job's coarse goodsStatus
      // OUTSIDE the tx to keep the completion transaction under Mongo's 5s limit. Best-effort: the per-line
      // tallies are already correct from the movement, and the summary self-heals on the next movement.
      if (completed.jobId && completed.lines.some((l) => l.jobKitLineId)) {
        await recomputeGoodsStatus(completed.jobId).catch((e) => console.error(`goodsStatus refresh after transfer ${completed.code} failed:`, e instanceof Error ? e.message : e));
      }
      return completed;
    } catch (e) {
      if (isTxWriteConflict(e) && attempt < 2) continue;
      if (isTxWriteConflict(e)) throw conflict("This transfer is being processed concurrently. Refresh and try again.");
      throw e;
    }
  }
  throw conflict("Could not complete the transfer. Refresh and try again.");
}

async function completeTransferOnce(transferId: string, opts: CompleteOptions): Promise<TransferWithLines> {
  return withTransaction(async (tx) => {
    const transfer = await tx.engineerStockTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } });

    if (transfer.status !== "pending") throw conflict(`Cannot complete a ${transfer.status} transfer.`);

    const from = transfer.fromEngineerId;
    const to = transfer.toEngineerId;
    const code = transfer.code;
    const now = new Date();

    for (const line of transfer.lines) {
      if (line.ownership === "company") {
        const irmItemId = line.irmItemId!;

        // Guard: holder must still have enough
        const bal = await findEngineerBalanceTx(tx, irmItemId, from);
        if (!bal || bal.quantityOnHand < line.quantity) {
          throw conflict(`Holder no longer has enough of this item (${line.itemName}). Refresh and try again.`);
        }

        // Debit from-engineer
        const fromBal = await upsertEngineerBalanceTx(tx, irmItemId, from, -line.quantity);
        // Defensive floor: the company balance helper has no built-in negative guard (the customer
        // helper does). Belt-and-suspenders alongside the pre-read check above.
        if (fromBal.quantityOnHand < 0) {
          throw conflict(`Holder no longer has enough of this item (${line.itemName}). Refresh and try again.`);
        }
        await insertEngineerTxnTx(tx, {
          irmItemId,
          engineerId: from,
          type: "transfer_out",
          quantityDelta: -line.quantity,
          balanceAfter: fromBal.quantityOnHand,
          sourceType: "engineer_transfer",
          sourceId: transfer.id,
          sourceCode: code,
          notes: null,
        });

        // Credit to-engineer
        const toBal = await upsertEngineerBalanceTx(tx, irmItemId, to, line.quantity);
        await insertEngineerTxnTx(tx, {
          irmItemId,
          engineerId: to,
          type: "transfer_in",
          quantityDelta: line.quantity,
          balanceAfter: toBal.quantityOnHand,
          sourceType: "engineer_transfer",
          sourceId: transfer.id,
          sourceCode: code,
          notes: null,
        });
      } else {
        // customer ownership
        const customerStockEntryId = line.customerStockEntryId!;

        // Guard: holder must have enough
        const holding = await findCustomerHoldingTx(tx, customerStockEntryId, from);
        if (!holding || holding.quantityOnHand < line.quantity) {
          throw conflict(`Holder no longer has enough of this customer item (${line.itemName}). Refresh and try again.`);
        }

        // Debit from-engineer
        const fromHolding = await upsertCustomerHoldingTx(tx, customerStockEntryId, from, -line.quantity, {
          customerId: holding.customerId,
          customerName: holding.customerName,
          itemName: holding.itemName,
        });
        await insertCustomerHoldingTxnTx(tx, {
          customerStockEntryId,
          engineerId: from,
          type: "transfer_out",
          quantityDelta: -line.quantity,
          balanceAfter: fromHolding.quantityOnHand,
          sourceType: "engineer_transfer",
          sourceId: transfer.id,
          sourceCode: code,
          notes: null,
        });

        // Credit to-engineer
        const toHolding = await upsertCustomerHoldingTx(tx, customerStockEntryId, to, line.quantity, {
          customerId: holding.customerId,
          customerName: holding.customerName,
          itemName: holding.itemName,
        });
        await insertCustomerHoldingTxnTx(tx, {
          customerStockEntryId,
          engineerId: to,
          type: "transfer_in",
          quantityDelta: line.quantity,
          balanceAfter: toHolding.quantityOnHand,
          sourceType: "engineer_transfer",
          sourceId: transfer.id,
          sourceCode: code,
          notes: null,
        });
      }
    }

    // Job attribution: when this transfer FULFILS a job kit request (jobId set + lines carry a
    // jobKitLineId), record the received qty as ISSUED against the job — sourced from a van, not a
    // warehouse. This writes an attribution-only JobStockMovement (NO balance change; the transfer_in
    // above already credited the recipient's van) so the job's Issued tally rises, then refreshes the
    // job's coarse goodsStatus. All inside this same transaction, so the move + attribution are atomic.
    const jobLines = transfer.lines.filter((l) => l.jobKitLineId);
    if (transfer.jobId && jobLines.length > 0) {
      const attributionLines: MovementLineRow[] = jobLines.map((l) => ({
        source: l.ownership === "company" ? "irm" : "customer",
        irmItemId: l.ownership === "company" ? l.irmItemId : null,
        customerStockEntryId: l.ownership === "customer" ? l.customerStockEntryId : null,
        itemName: l.itemName,
        sku: l.sku,
        uom: l.uom,
        qty: l.quantity,
        condition: "good",
        jobKitLineId: l.jobKitLineId,
        scannedCode: null,
        damagePhotoUrl: null,
        damageReason: null,
        notes: null,
      }));
      await createJobIssueAttributionTx(
        tx,
        {
          jobId: transfer.jobId,
          engineerId: to,
          engineerName: transfer.toEngineerName,
          engineerEmail: transfer.toEngineerEmail,
          notes: `Issued via engineer transfer ${code}`,
          performedBy: opts.approverEmail,
          createdBy: opts.approverEmail,
        },
        attributionLines,
      );
      // NOTE: the job's coarse goodsStatus is refreshed AFTER this transaction commits (see
      // completeTransferTx) — kept out of the tx so its reads/write don't blow Mongo's 5s limit.
    }

    // Mark completed
    return tx.engineerStockTransfer.update({
      where: { id: transferId },
      data: {
        status: "completed",
        completedAt: now,
        approvedBy: opts.approverEmail,
        approvedAt: now,
        overrideByAdmin: opts.overrideByAdmin,
      },
      include: { lines: true },
    });
  });
}

// ---- Other status transitions -----------------------------------------------------------------

export async function declineTx(transferId: string, declinedBy: string, declineReason?: string): Promise<TransferWithLines> {
  return withTransaction(async (tx) => {
    const transfer = await tx.engineerStockTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } });
    if (transfer.status !== "pending") throw conflict(`Cannot decline a ${transfer.status} transfer.`);
    return tx.engineerStockTransfer.update({
      where: { id: transferId },
      data: { status: "declined", declinedBy, declineReason: declineReason ?? null, declinedAt: new Date() },
      include: { lines: true },
    });
  });
}

export async function cancelTx(transferId: string): Promise<TransferWithLines> {
  return withTransaction(async (tx) => {
    const transfer = await tx.engineerStockTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } });
    if (transfer.status !== "pending") throw conflict(`Cannot cancel a ${transfer.status} transfer.`);
    return tx.engineerStockTransfer.update({
      where: { id: transferId },
      data: { status: "cancelled", cancelledAt: new Date() },
      include: { lines: true },
    });
  });
}

export async function acknowledgeTx(transferId: string, receiverSignatureUrl: string): Promise<TransferWithLines> {
  return prisma.engineerStockTransfer.update({
    where: { id: transferId },
    data: { receiverSignatureUrl, acknowledgedAt: new Date() },
    include: { lines: true },
  });
}
