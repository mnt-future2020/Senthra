import * as financeRepo from "./finance.repository.js";
import type { FinanceLine } from "./finance.repository.js";
import type { BreakdownRow, FinanceDetailRow, FinanceSummary, MoneyTotals, TrendPoint } from "./finance.types.js";
import {
  EXCLUDED_PO_STATUSES,
  lineVatPence,
  OTHER_BREAKDOWN_KEY,
  PRE_ISSUE_PO_STATUSES,
  REPORTABLE_PO_STATUSES,
  UNATTRIBUTED_PROJECT_KEY,
  UNATTRIBUTED_PROJECT_LABEL,
} from "./reports.constants.js";
import { dayKeysBetween, monthKeysBetween, resolvePeriod, trendGrain, type ReportPeriod } from "./reports.period.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import { warehouseScopeFilter } from "../../lib/warehouse-access.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

// ── THE canonical Finance computation ──────────────────────────────────────────────────────────
//
// One function, `getFinanceSummary`, produces every figure the product reports. The dashboard, the
// report screen and the CSV all call it and render its result; none of them adds, filters or rounds
// anything of its own. That is the whole design: three surfaces cannot disagree about a number they
// did not each compute.
//
// The two rules that decide whether the numbers are right:
//
//   1. IRM spend comes from PurchaseOrderItem.lineTotalPence — NEVER from the PO header.
//      `computeTotals` is fed `[...lineRows, ...rentalItems]`, so subtotalPence / vatPence /
//      grandTotalPence are ORDER totals including hire. Reading them as "IRM cost" over-states IRM by
//      the entire hire value of every order that carries one.
//
//   2. VAT is rounded PER LINE and then summed, mirroring `computeTotals` exactly. Rounding a bucket
//      subtotal instead would drift from the orders the bucket is built from, and a finance reader
//      would find a supplier total that reconciles to none of that supplier's purchase orders.

const EMPTY: MoneyTotals = { netPence: 0, vatPence: 0, grossPence: 0 };

/** Accumulator for one breakdown bucket. Separate from BreakdownRow so PO ids can be de-duplicated. */
interface Bucket extends MoneyTotals {
  key: string;
  label: string;
  sublabel?: string;
  poIds: Set<string>;
  lineCount: number;
  orderedPence: number;
  receivedPence: number;
  orderedQty: number;
  receivedQty: number;
}

function bucketOf(map: Map<string, Bucket>, key: string, label: string, sublabel?: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { key, label, sublabel, ...EMPTY, poIds: new Set(), lineCount: 0, orderedPence: 0, receivedPence: 0, orderedQty: 0, receivedQty: 0 };
    map.set(key, b);
  }
  return b;
}

/**
 * Add one line's money to a bucket. The ONLY place a bucket's figures grow.
 *
 * Money AND the commitment view together, because they are the same line: computing ordered/received
 * per row in a second pass is how a supplier's ordered value drifts from the headline `tracking`
 * block that was built from the same lines.
 */
function addLine(b: Bucket, netPence: number, vatPence: number, poId: string, line: FinanceLine): void {
  b.netPence += netPence;
  b.vatPence += vatPence;
  b.grossPence += netPence + vatPence;
  b.poIds.add(poId);
  b.lineCount += 1;
  b.orderedPence += line.quantity * line.unitPricePence;
  b.receivedPence += line.receivedQuantity * line.unitPricePence;
  b.orderedQty += line.quantity;
  b.receivedQty += line.receivedQuantity;
}

/** One bucket → one row. `poIds.size` is why a PO with 5 lines counts once. */
const bucketToRow = ({ poIds, ...rest }: Bucket): BreakdownRow => ({
  ...rest,
  poCount: poIds.size,
  // Derived, never accumulated — the same subtraction the headline uses, so the two agree by
  // construction rather than by two independent sums happening to match.
  outstandingPence: rest.orderedPence - rest.receivedPence,
});

/**
 * Buckets → rows, biggest spend first, optionally folding the tail into one row.
 *
 * FOLDED, never truncated. A breakdown by item over a year can run to thousands of rows — more than a
 * screen shows and more than a reader uses — but dropping the tail leaves a table whose column no
 * longer adds up to the headline above it, and reconciling those two figures is the first thing a
 * finance reader does. The remainder becomes one row, so the total still ties and the collapse is
 * visible on the page rather than inferred from a suspiciously round row count.
 *
 * The fold happens at BUCKET level, before `poIds` is reduced to a count, so the "N more" row unions
 * the id sets instead of summing counts. That distinction is real: on the by-item and by-project
 * breakdowns one order appears in every bucket it has a line in, so summing their `poCount`s would
 * report an order once per item it contains.
 */
function toRows(map: Map<string, Bucket>, limit?: number): BreakdownRow[] {
  const buckets = [...map.values()].sort((a, b) => b.netPence - a.netPence || a.label.localeCompare(b.label));
  if (!limit || buckets.length <= limit) return buckets.map(bucketToRow);

  const tail = buckets.slice(limit);
  const rest: Bucket = {
    key: OTHER_BREAKDOWN_KEY,
    label: `${tail.length} more`,
    sublabel: `Below the top ${limit} — included in the totals above`,
    poIds: new Set(tail.flatMap((b) => [...b.poIds])),
    ...EMPTY,
    lineCount: 0,
    orderedPence: 0,
    receivedPence: 0,
    orderedQty: 0,
    receivedQty: 0,
  };
  for (const b of tail) {
    rest.netPence += b.netPence;
    rest.vatPence += b.vatPence;
    rest.grossPence += b.grossPence;
    rest.lineCount += b.lineCount;
    rest.orderedPence += b.orderedPence;
    rest.receivedPence += b.receivedPence;
    rest.orderedQty += b.orderedQty;
    rest.receivedQty += b.receivedQty;
  }
  return [...buckets.slice(0, limit).map(bucketToRow), bucketToRow(rest)];
}

export interface FinanceQuery {
  period?: ReportPeriod;
  from?: Date;
  to?: Date;
  supplierId?: string;
  /**
   * Fold each breakdown to this many rows plus a remainder. Set by the SCREEN endpoint; the exports
   * leave it undefined and carry every row, because the file is where the detail belongs. Either way
   * the columns total to the same headline — see `toRows`.
   */
  breakdownLimit?: number;
}

/**
 * Compute the Finance summary for a period.
 *
 * Warehouse scoping follows `warehouseScopeFilter`, the same rule every other module uses. Note the
 * consequence for a warehouse-scoped actor: they see only their own warehouses' spend. That is
 * correct for a warehouse manager and WRONG for a Finance Director — which is why the finance
 * permission is not granted to warehouse-scoped roles by default (see reports.routes.ts).
 */
export async function getFinanceSummary(
  actor: AuditActor | undefined,
  query: FinanceQuery = {},
  now: Date = new Date(),
): Promise<FinanceSummary> {
  const timeZone = await getCompanyTimezone();
  const range = resolvePeriod(timeZone, query.period ?? "month", now, { from: query.from, to: query.to });
  const warehouseIds = warehouseScopeFilter(actor);

  // ── Step one: the headers. Small (one row per order) and served by [status, orderDate]. ────────
  const headers = await financeRepo.findFinancePoHeaders(range, { warehouseIds, supplierId: query.supplierId });
  const poIds = headers.map((h) => h.id);
  const byPoId = new Map(headers.map((h) => [h.id, h]));

  // ── Step two: the lines + the project resolution, in parallel — none depends on another. ───────
  const jobIds = [...new Set(headers.map((h) => h.jobId).filter((v): v is string => Boolean(v)))];
  const [lines, rentalLines, jobProjects, charges, excluded] = await Promise.all([
    financeRepo.findFinanceLines(poIds),
    financeRepo.findFinanceRentalLines(poIds),
    financeRepo.findJobProjects(jobIds),
    // The SAME scope the headers were read with — a figure narrowed differently from the ones beside
    // it does not reconcile with anything on the page.
    financeRepo.sumSupplierCharges(range, { warehouseIds, supplierId: query.supplierId }),
    financeRepo.countExcluded(range, { warehouseIds, supplierId: query.supplierId }),
  ]);

  const totals: MoneyTotals = { ...EMPTY };
  const tracking = {
    orderedPence: 0,
    receivedPence: 0,
    partiallyReceivedLines: 0,
  };
  const supplierMap = new Map<string, Bucket>();
  const itemMap = new Map<string, Bucket>();
  const projectMap = new Map<string, Bucket>();
  const trendMap = new Map<string, { netPence: number; poIds: Set<string> }>();

  const grain = trendGrain(range);
  const bucketKeyFor = (d: Date) => (grain === "day" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 7));

  // ── One pass over the lines. Every figure above grows here and nowhere else. ───────────────────
  for (const line of lines) {
    const po = byPoId.get(line.purchaseOrderId);
    // A line whose header is not in the window cannot arrive (the ids came FROM the headers), but the
    // guard keeps the arithmetic honest rather than silently attributing money to `undefined`.
    if (!po) continue;

    const net = line.lineTotalPence;
    // PER LINE, then summed — mirrors computeTotals. See the header note.
    const vat = lineVatPence(net, line.vatRate);

    totals.netPence += net;
    totals.vatPence += vat;
    totals.grossPence += net + vat;

    tracking.orderedPence += line.quantity * line.unitPricePence;
    tracking.receivedPence += line.receivedQuantity * line.unitPricePence;
    if (line.receivedQuantity > 0 && line.receivedQuantity < line.quantity) tracking.partiallyReceivedLines += 1;

    addLine(bucketOf(supplierMap, po.supplierId, po.supplierName ?? "(unnamed supplier)"), net, vat, po.id, line);
    addLine(bucketOf(itemMap, line.irmItemId, line.itemName, line.sku ?? undefined), net, vat, po.id, line);

    // Project attribution: PO → Job → Project when the order names a job, otherwise the explicit
    // Unattributed bucket. `projectRef` is deliberately NOT consulted — it is unnormalised free text,
    // so "Fibre Rollout", "fibre rollout" and "FR-2026" would be three different projects to a group.
    const jp = po.jobId ? jobProjects.get(po.jobId) : undefined;
    const projectKey = jp?.projectId ?? UNATTRIBUTED_PROJECT_KEY;
    const projectLabel = jp?.projectName ?? UNATTRIBUTED_PROJECT_LABEL;
    addLine(bucketOf(projectMap, projectKey, projectLabel), net, vat, po.id, line);

    const bk = bucketKeyFor(po.orderDate);
    let tb = trendMap.get(bk);
    if (!tb) {
      tb = { netPence: 0, poIds: new Set() };
      trendMap.set(bk, tb);
    }
    tb.netPence += net;
    tb.poIds.add(po.id);
  }

  // Zero-filled so a trend renders a continuous axis rather than skipping quiet periods.
  const keys = grain === "day" ? dayKeysBetween(range.from, range.to) : monthKeysBetween(range.from, range.to);
  const points: TrendPoint[] = keys.map((bucket) => ({
    bucket,
    netPence: trendMap.get(bucket)?.netPence ?? 0,
    poCount: trendMap.get(bucket)?.poIds.size ?? 0,
  }));

  // Hire, kept entirely apart from `totals`.
  const rental = {
    hireNetPence: rentalLines.reduce((n, r) => n + r.lineTotalPence, 0),
    hireVatPence: rentalLines.reduce((n, r) => n + lineVatPence(r.lineTotalPence, r.vatRate), 0),
    hireLineCount: rentalLines.length,
    extensionChargePence: rentalLines.reduce((n, r) => n + r.extensionChargePence, 0),
    damageChargePence: charges.damagePence,
    damageChargeLines: charges.damageLines,
    lossChargePence: charges.lossPence,
    lossChargeLines: charges.lossLines,
  };

  const preIssue = headers.filter((h) => (PRE_ISSUE_PO_STATUSES as readonly string[]).includes(h.status));
  const preIssueIds = new Set(preIssue.map((h) => h.id));
  const preIssueNetPence = lines
    .filter((l) => preIssueIds.has(l.purchaseOrderId))
    .reduce((n, l) => n + l.lineTotalPence, 0);

  return {
    period: { from: range.from.toISOString(), to: range.to.toISOString(), period: range.period, label: range.label, timeZone },
    basis: {
      statuses: [...REPORTABLE_PO_STATUSES],
      excluded: [...EXCLUDED_PO_STATUSES],
      dateField: "orderDate",
      currency: "GBP",
    },
    totals,
    tracking: {
      ...tracking,
      outstandingPence: tracking.orderedPence - tracking.receivedPence,
      poCount: headers.length,
      supplierCount: new Set(headers.map((h) => h.supplierId)).size,
      preIssuePoCount: preIssue.length,
      preIssueNetPence,
    },
    trend: { grain, points },
    bySupplier: toRows(supplierMap, query.breakdownLimit),
    byItem: toRows(itemMap, query.breakdownLimit),
    byProject: toRows(projectMap, query.breakdownLimit),
    rental,
    excluded: { draftPoCount: excluded.draft, cancelledPoCount: excluded.cancelled },
    generatedAt: now.toISOString(),
  };
}

export type { FinanceSummary };
export { UNATTRIBUTED_PROJECT_KEY, UNATTRIBUTED_PROJECT_LABEL };

/** Exported for the header-tie-out test — the mirror of computeTotals this module relies on. */
export { lineVatPence };

/**
 * The PO-detail rows for a period — one priced row per IRM line.
 *
 * CANONICAL, like the summary: every money field is computed HERE, with the same per-line VAT rule,
 * so a renderer (CSV or XLSX) only ever displays what it is handed. A formatter that multiplied a
 * unit price itself would be a second accounting path, which is exactly what this module exists to
 * prevent.
 *
 * Bounded by the same period + scope as the summary, and it reuses the identical two-step read — no
 * per-row query, no N+1.
 */
export async function getFinanceDetail(
  actor: AuditActor | undefined,
  query: FinanceQuery = {},
  now: Date = new Date(),
): Promise<{ periodLabel: string; rows: FinanceDetailRow[] }> {
  const timeZone = await getCompanyTimezone();
  const range = resolvePeriod(timeZone, query.period ?? "month", now, { from: query.from, to: query.to });
  const headers = await financeRepo.findFinancePoHeaders(range, {
    warehouseIds: warehouseScopeFilter(actor),
    supplierId: query.supplierId,
  });
  const byPoId = new Map(headers.map((h) => [h.id, h]));
  const jobIds = [...new Set(headers.map((h) => h.jobId).filter((v): v is string => Boolean(v)))];
  const [lines, jobProjects] = await Promise.all([
    financeRepo.findFinanceLines(headers.map((h) => h.id)),
    financeRepo.findJobProjects(jobIds),
  ]);

  const rows = lines.flatMap<FinanceDetailRow>((l) => {
    const po = byPoId.get(l.purchaseOrderId);
    if (!po) return [];
    const jp = po.jobId ? jobProjects.get(po.jobId) : undefined;
    const netPence = l.lineTotalPence;
    const vatPence = lineVatPence(netPence, l.vatRate);
    return [
      {
        poCode: po.code,
        poStatus: po.status,
        orderDate: po.orderDate.toISOString().slice(0, 10),
        supplierName: po.supplierName ?? "(unnamed supplier)",
        // Same rule as the summary's project bucket — job→project, else Unattributed. projectRef is
        // never consulted.
        projectLabel: jp?.projectName ?? UNATTRIBUTED_PROJECT_LABEL,
        itemName: l.itemName,
        itemCode: l.sku ?? "",
        quantity: l.quantity,
        receivedQuantity: l.receivedQuantity,
        outstandingQuantity: l.quantity - l.receivedQuantity,
        unitPricePence: l.unitPricePence,
        vatRate: l.vatRate,
        netPence,
        vatPence,
        grossPence: netPence + vatPence,
      },
    ];
  });

  // Newest order first, then by PO so a reader scanning one order sees its lines together.
  rows.sort((a, b) => b.orderDate.localeCompare(a.orderDate) || a.poCode.localeCompare(b.poCode));
  return { periodLabel: range.label, rows };
}
