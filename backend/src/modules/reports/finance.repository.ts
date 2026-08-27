import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { financePoWhere, LIVE_PO, MAX_FINANCE_POS, PRE_ISSUE_PO_STATUSES, REPORTABLE_PO_STATUSES } from "./reports.constants.js";
import { badRequest } from "../../utils/http-error.js";

// ── Finance data access — the ONLY place reporting touches Prisma ──────────────────────────────
//
// Two facts about Prisma-on-Mongo shape everything here, both already documented elsewhere in this
// codebase and both re-confirmed for reporting:
//
//   1. You CAN filter a line query by its parent (`where: { purchaseOrder: { is: {…} } }`) — that
//      ships in four places in the purchase-order repository.
//   2. You CANNOT group BY a parent field. supplierId, orderDate and jobId live on the ORDER, not on
//      the line, so a "spend by supplier" groupBy over lines is impossible.
//
// Hence the two-step every read below uses: resolve the matching PO headers first (small — one row
// per order, and the [status, orderDate] index serves it), then read their lines by `purchaseOrderId
// in [...]`. The headers carry the grouping dimensions; the lines carry the money.
//
// The deletedAt guard is carried EXPLICITLY into step two. PurchaseOrderItem has no deletedAt of its
// own, so a line query that forgot it would happily sum the lines of a soft-deleted order.

/** The header fields Finance groups by. One row per order — deliberately lean. */
export interface FinancePoHeader {
  id: string;
  code: string;
  status: string;
  orderDate: Date;
  supplierId: string;
  supplierName: string | null;
  warehouseId: string;
  jobId: string | null;
}

/** One IRM line, with the money Finance actually sums. */
export interface FinanceLine {
  purchaseOrderId: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  quantity: number;
  receivedQuantity: number;
  unitPricePence: number;
  vatRate: number;
  lineTotalPence: number;
}

/** One hire line. Kept in its own shape so it can never be summed into IRM spend by accident. */
export interface FinanceRentalLine {
  purchaseOrderId: string;
  rentalItemId: string;
  itemName: string;
  quantity: number;
  lineTotalPence: number;
  vatRate: number;
  extensionChargePence: number;
}

/**
 * Every purchase order in the reporting window.
 *
 * Step one of the two-step. `select` rather than `include` — a finance sweep does not need the
 * supplier record, the warehouse record, the attachments or the lines' relations, and pulling them
 * would turn a lean header read into the unbounded fetch this module exists to avoid.
 */
export async function findFinancePoHeaders(
  range: { from: Date; to: Date },
  scope?: { warehouseIds?: string[]; supplierId?: string },
): Promise<FinancePoHeader[]> {
  const where: Prisma.PurchaseOrderWhereInput = { ...financePoWhere(range) };
  if (scope?.warehouseIds) where.warehouseId = { in: scope.warehouseIds };
  if (scope?.supplierId) where.supplierId = scope.supplierId;
  const rows = await prisma.purchaseOrder.findMany({
    where,
    select: {
      id: true,
      code: true,
      status: true,
      orderDate: true,
      supplierId: true,
      supplierName: true,
      warehouseId: true,
      jobId: true,
    },
    orderBy: { orderDate: "asc" },
    // One MORE than the ceiling, so the overflow is detectable rather than indistinguishable from a
    // period that happens to hold exactly that many orders.
    take: MAX_FINANCE_POS + 1,
  });
  // REFUSED, never truncated. Every figure on the page is a sum over these rows, so a silently short
  // list is a wrong total presented as a right one — the one outcome a finance report may not have.
  if (rows.length > MAX_FINANCE_POS) {
    throw badRequest(
      `This period covers more than ${MAX_FINANCE_POS.toLocaleString("en-GB")} purchase orders, which is more than one report can total accurately. Narrow the period, the supplier or the warehouse.`,
    );
  }
  return rows;
}

/**
 * The IRM lines of the given orders.
 *
 * Step two. `purchaseOrderId in ids` uses the existing @@index([purchaseOrderId]). The parent filter
 * is carried as well — belt and braces against an id list assembled from a stale read, and the only
 * way this query can express "not soft-deleted" at all.
 *
 * Chunked because an `in` list is a query document: an unbounded one over a year of orders would push
 * Mongo's 16MB command limit. 500 ids per call is well inside it and costs a handful of round trips.
 */
export async function findFinanceLines(purchaseOrderIds: string[]): Promise<FinanceLine[]> {
  if (purchaseOrderIds.length === 0) return [];
  const out: FinanceLine[] = [];
  for (let i = 0; i < purchaseOrderIds.length; i += 500) {
    const chunk = purchaseOrderIds.slice(i, i + 500);
    const rows = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: { in: chunk }, purchaseOrder: { is: LIVE_PO } },
      select: {
        purchaseOrderId: true,
        irmItemId: true,
        itemName: true,
        sku: true,
        quantity: true,
        receivedQuantity: true,
        unitPricePence: true,
        vatRate: true,
        lineTotalPence: true,
      },
    });
    out.push(...rows);
  }
  return out;
}

/**
 * The HIRE lines of the given orders — reported beside IRM spend, never inside it.
 *
 * `extensionChargePence` is read here because it is the running total the hire already carries; the
 * individual HireExtension rows are its breakdown, so reading BOTH and adding them would double-count
 * every extension. Damage charges are NOT here: they live on rental receipt lines, are nullable
 * (null = not yet quoted, which is not the same as zero) and have no agreed accounting treatment —
 * see the service.
 */
export async function findFinanceRentalLines(purchaseOrderIds: string[]): Promise<FinanceRentalLine[]> {
  if (purchaseOrderIds.length === 0) return [];
  const out: FinanceRentalLine[] = [];
  for (let i = 0; i < purchaseOrderIds.length; i += 500) {
    const chunk = purchaseOrderIds.slice(i, i + 500);
    const rows = await prisma.purchaseOrderRentalLine.findMany({
      where: { purchaseOrderId: { in: chunk }, purchaseOrder: { is: LIVE_PO } },
      select: {
        purchaseOrderId: true,
        rentalItemId: true,
        itemName: true,
        quantity: true,
        lineTotalPence: true,
        vatRate: true,
        extensionChargePence: true,
      },
    });
    out.push(...rows);
  }
  return out;
}

/**
 * Supplier charges against hires in the window, SPLIT BY WHAT HAPPENED.
 *
 * Damage and loss both write `damageChargePence` — the column predates the loss direction — but they
 * are different financial events and the rental module is emphatic about it: a `loss` note (HLS) is
 * "equipment that is never coming back, and what the provider is charging to replace it", kept a
 * separate direction because folding one into the other "would state on a supplier-facing record that
 * a missing tester was merely broken". Reporting them as one figure repeats exactly that mistake in
 * the accounts.
 *
 *   damage — HDM (found in service) and the HRN return leg (found at collection): kit we still hand
 *            back, charged for its condition.
 *   loss   — HLS only: kit that is gone, charged at replacement.
 *
 * The `in` (arrival) leg never carries a charge — the service refuses one there, because damage that
 * came WITH the kit is the supplier's own fault.
 *
 * `damageChargePence: { not: null }` matters: null is "no figure quoted yet", which is NOT zero, and
 * treating them alike would report an unpriced dispute as settled at £0. Only LIVE notes count — a
 * reversed note moved nothing, and a recovered loss is undone by reversing its note, so the same
 * filter also keeps recoveries out without needing a credit model.
 */
export async function sumSupplierCharges(
  range: { from: Date; to: Date },
  scope?: { warehouseIds?: string[]; supplierId?: string },
): Promise<{
  damagePence: number;
  damageLines: number;
  lossPence: number;
  lossLines: number;
}> {
  // Scoped by the SAME rule as every other figure on the page. A note carries its own warehouse and
  // supplier, so this is a direct filter rather than a join through the order — but leaving it off
  // was not a smaller answer, it was a DIFFERENT one: company-wide damage and loss totals sitting
  // beside spend narrowed to one warehouse or one supplier, with nothing on screen to say so.
  const receipt: Prisma.RentalReceiptWhereInput = {
    deliveryDate: { gte: range.from, lte: range.to },
    OR: [{ reversedAt: null }, { reversedAt: { isSet: false } }],
  };
  if (scope?.warehouseIds) receipt.warehouseId = { in: scope.warehouseIds };
  if (scope?.supplierId) receipt.supplierId = scope.supplierId;

  const rows = await prisma.rentalReceiptLine.findMany({
    where: {
      damageChargePence: { not: null },
      rentalReceipt: { is: receipt },
    },
    // The direction lives on the parent note, so it is selected through the relation rather than
    // grouped on — Prisma-on-Mongo cannot group by a parent field.
    select: { damageChargePence: true, rentalReceipt: { select: { direction: true } } },
  });
  let damagePence = 0;
  let damageLines = 0;
  let lossPence = 0;
  let lossLines = 0;
  for (const r of rows) {
    const pence = r.damageChargePence ?? 0;
    if (r.rentalReceipt?.direction === "loss") {
      lossPence += pence;
      lossLines += 1;
    } else {
      damagePence += pence;
      damageLines += 1;
    }
  }
  return { damagePence, damageLines, lossPence, lossLines };
}

/**
 * Job → project resolution for the orders that name a job.
 *
 * `Job.projectId` is a REQUIRED relation, so every job resolves to exactly one project — the optional
 * hop is PO→Job, not Job→Project. Orders with no jobId never reach here and are reported under
 * "Unattributed / General Procurement" by the service.
 *
 * Soft-deleted jobs are still resolved deliberately: the order was genuinely raised against that job
 * and its spend is historical fact. Dropping the label would move real spend into Unattributed and
 * make last month's report change retrospectively.
 */
export async function findJobProjects(
  jobIds: string[],
): Promise<Map<string, { jobId: string; jobNumber: string; projectId: string; projectName: string }>> {
  const map = new Map<string, { jobId: string; jobNumber: string; projectId: string; projectName: string }>();
  if (jobIds.length === 0) return map;
  for (let i = 0; i < jobIds.length; i += 500) {
    const rows = await prisma.job.findMany({
      where: { id: { in: jobIds.slice(i, i + 500) } },
      select: {
        id: true,
        jobNumber: true,
        projectId: true,
        projectName: true,
        project: { select: { name: true } },
      },
    });
    for (const r of rows) {
      map.set(r.id, {
        jobId: r.id,
        jobNumber: r.jobNumber,
        projectId: r.projectId,
        // The live project name wins; the snapshot is the fallback for a project row that has since
        // been hard-deleted (CustomerProject has no soft delete), which is exactly the case the
        // snapshot column exists for.
        projectName: r.project?.name ?? r.projectName ?? "(deleted project)",
      });
    }
  }
  return map;
}

/**
 * Orders excluded from spend, reported as context so the headline figure is never a silent subset.
 *
 * Carries the caller's scope for the same reason every other read here does: "£0 spent, 12 drafts
 * excluded" is only true of the same warehouses and supplier the £0 was measured over. An unscoped
 * count beside a scoped total describes orders the reader cannot see on any other line of the page.
 */
export async function countExcluded(
  range: { from: Date; to: Date },
  scope?: { warehouseIds?: string[]; supplierId?: string },
): Promise<{ draft: number; cancelled: number }> {
  const base: Prisma.PurchaseOrderWhereInput = { ...LIVE_PO, orderDate: { gte: range.from, lte: range.to } };
  if (scope?.warehouseIds) base.warehouseId = { in: scope.warehouseIds };
  if (scope?.supplierId) base.supplierId = scope.supplierId;

  const [draft, cancelled] = await Promise.all([
    prisma.purchaseOrder.count({ where: { ...base, status: "draft" } }),
    prisma.purchaseOrder.count({ where: { ...base, status: "cancelled" } }),
  ]);
  return { draft, cancelled };
}

export { PRE_ISSUE_PO_STATUSES, REPORTABLE_PO_STATUSES };
