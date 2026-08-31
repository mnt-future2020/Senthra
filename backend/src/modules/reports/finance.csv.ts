import { EXPORT_MAX, toCsv } from "../../utils/csv.js";
import type { CsvExport } from "../../utils/csv-response.js";
import type { BreakdownRow, FinanceDetailRow, FinanceSummary } from "./finance.types.js";

// ── Finance CSV — a RENDERER, not a second calculation ────────────────────────────────────────
//
// Takes the already-computed FinanceSummary and writes it out. It performs no filtering, no
// aggregation and no rounding of its own: every number here was produced by finance.service.ts, so
// the export and the screen cannot disagree. That is the one rule this file exists to keep.

const pounds = (pence: number): string => (pence / 100).toFixed(2);

/**
 * The summary export — one file carrying the whole report, section by section.
 *
 * Sectioned rather than one flat table because a finance report IS sections (totals, then supplier,
 * then project, then item), and flattening them into a single grid with a "section" column is harder
 * to read in Excel than the blank-line separation below. This is also why real XLSX is on the roadmap:
 * CSV cannot carry the header block, the currency formatting or the grouped subtotals properly.
 */
export function financeSummaryCsv(summary: FinanceSummary): CsvExport {
  const rows: (string | number)[][] = [];
  const section = (title: string) => {
    rows.push([]);
    rows.push([title]);
  };

  // Header block — a finance file that does not say what it covers is unauditable.
  rows.push(["Report", "Finance Summary"]);
  rows.push(["Period", summary.period.label]);
  rows.push(["From", summary.period.from.slice(0, 10)]);
  rows.push(["To", summary.period.to.slice(0, 10)]);
  rows.push(["Timezone", summary.period.timeZone]);
  rows.push(["Currency", summary.basis.currency]);
  // The basis is printed, not assumed. "Spend" is a business definition and the reader has to be able
  // to see which one this file used.
  rows.push(["Basis", `Purchase orders dated by ${summary.basis.dateField}, statuses: ${summary.basis.statuses.join(" | ")}`]);
  rows.push(["Excluded", summary.basis.excluded.join(" | ")]);
  rows.push(["Generated", summary.generatedAt]);

  section("TOTALS (IRM purchase spend — excludes rental/hire)");
  rows.push(["Net", pounds(summary.totals.netPence)]);
  rows.push(["VAT", pounds(summary.totals.vatPence)]);
  rows.push(["Gross", pounds(summary.totals.grossPence)]);

  section("PURCHASE ORDER TRACKING");
  rows.push(["Ordered value", pounds(summary.tracking.orderedPence)]);
  rows.push(["Received value", pounds(summary.tracking.receivedPence)]);
  rows.push(["Outstanding value", pounds(summary.tracking.outstandingPence)]);
  rows.push(["Purchase orders", summary.tracking.poCount]);
  rows.push(["Suppliers", summary.tracking.supplierCount]);
  rows.push(["Awaiting issue to supplier (orders)", summary.tracking.preIssuePoCount]);
  rows.push(["Awaiting issue to supplier (net)", pounds(summary.tracking.preIssueNetPence)]);
  rows.push(["Partially received lines", summary.tracking.partiallyReceivedLines]);

  const breakdown = (title: string, list: BreakdownRow[], labelCol: string) => {
    section(title);
    rows.push([labelCol, "Reference", "Net", "VAT", "Gross", "POs", "Lines"]);
    for (const r of list) {
      rows.push([r.label, r.sublabel ?? "", pounds(r.netPence), pounds(r.vatPence), pounds(r.grossPence), r.poCount, r.lineCount]);
    }
  };
  breakdown("SPEND BY SUPPLIER", summary.bySupplier, "Supplier");
  breakdown("SPEND BY PROJECT", summary.byProject, "Project");
  breakdown("SPEND BY ITEM", summary.byItem, "Item");

  section("SPEND TREND");
  rows.push([summary.trend.grain === "day" ? "Day" : "Month", "Net", "POs"]);
  for (const p of summary.trend.points) rows.push([p.bucket, pounds(p.netPence), p.poCount]);

  // Hire is its own section, never folded into the totals above. The two undecided treatments are
  // labelled in the file itself so nobody reading the export assumes they are already in "spend".
  section("RENTAL / HIRE (reported separately — NOT included in the totals above)");
  rows.push(["Hire net", pounds(summary.rental.hireNetPence)]);
  rows.push(["Hire VAT", pounds(summary.rental.hireVatPence)]);
  rows.push(["Hire lines", summary.rental.hireLineCount]);
  rows.push(["Extension charges (treatment not yet defined)", pounds(summary.rental.extensionChargePence)]);
  rows.push(["Damage charges quoted (treatment not yet defined)", pounds(summary.rental.damageChargePence)]);
  rows.push(["Damage charge lines", summary.rental.damageChargeLines]);
  // Separate from damage: a loss is kit that is gone, charged at replacement — a different event.
  rows.push(["Loss charges quoted (treatment not yet defined)", pounds(summary.rental.lossChargePence)]);
  rows.push(["Loss charge lines", summary.rental.lossChargeLines]);

  section("EXCLUDED FROM ALL FIGURES");
  rows.push(["Draft purchase orders", summary.excluded.draftPoCount]);
  rows.push(["Cancelled purchase orders", summary.excluded.cancelledPoCount]);

  return { csv: toCsv(["Finance Summary"], rows), capped: false };
}

/**
 * One row per PO line — the detail file an accountant reconciles against, or imports elsewhere.
 *
 * Renders the CANONICAL detail rows: every money value was priced by finance.service (per-line VAT,
 * the same rule as everywhere else), so this and the XLSX detail sheet are the same numbers.
 */
export function financeLinesCsv(periodLabel: string, rows: FinanceDetailRow[]): CsvExport {
  const capped = rows.length > EXPORT_MAX;
  const slice = capped ? rows.slice(0, EXPORT_MAX) : rows;
  return {
    csv: toCsv(
      [
        "PO",
        "PO Date",
        "Status",
        "Supplier",
        "Project",
        "IRM Item",
        "Item Code",
        "Ordered Qty",
        "Received Qty",
        "Outstanding Qty",
        "Unit Price",
        "VAT %",
        "Net",
        "VAT",
        "Gross",
        "Period",
      ],
      slice.map((r) => [
        r.poCode,
        r.orderDate,
        r.poStatus,
        r.supplierName,
        r.projectLabel,
        r.itemName,
        r.itemCode,
        r.quantity,
        r.receivedQuantity,
        r.outstandingQuantity,
        pounds(r.unitPricePence),
        r.vatRate,
        pounds(r.netPence),
        pounds(r.vatPence),
        pounds(r.grossPence),
        periodLabel,
      ]),
    ),
    capped,
  };
}
