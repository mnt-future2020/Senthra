import ExcelJS from "exceljs";

import type { BreakdownRow, FinanceDetailRow, FinanceSummary } from "./finance.types.js";

// ── Finance workbook — a RENDERER, not a calculation ──────────────────────────────────────────
//
// Takes the already-computed FinanceSummary + detail rows and writes cells. It performs no financial
// arithmetic whatsoever: no summing, no VAT, no percentages, and deliberately NO spreadsheet formulas
// over money. A `=SUM()` in a totals cell would be a second accounting path that could disagree with
// the figure the dashboard shows — which is the one thing this module exists to prevent.
//
// The single conversion it does perform is pence → pounds for DISPLAY. Money is integer pence
// everywhere upstream; Excel has no integer-pence concept, so the cell carries a number in pounds
// with a currency number-format applied. Division by 100 is exact in IEEE-754 for every value in
// range, and the pence figure remains the source of truth — the workbook is an output, never an input.

/** Excel's built-in GBP format: thousands separators, two decimals, negatives in parentheses. */
const GBP = '£#,##0.00;(£#,##0.00)';
const INT = "#,##0";

/** Pence → pounds, for a numeric cell. The ONLY transformation applied to money in this file. */
const pounds = (pence: number): number => pence / 100;

type Col = { header: string; key: string; width: number; fmt?: string };

/** Header styling applied identically to every sheet, so the workbook reads as one document. */
function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  row.alignment = { vertical: "middle" };
  row.height = 20;
}

function addTable(sheet: ExcelJS.Worksheet, cols: Col[], rows: Record<string, string | number>[]): void {
  sheet.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(sheet.getRow(1));
  for (const r of rows) sheet.addRow(r);
  // Number formats are applied per COLUMN after the rows land, so every cell in a money column is
  // formatted identically — including the ones a later row adds.
  cols.forEach((c, i) => {
    if (c.fmt) sheet.getColumn(i + 1).numFmt = c.fmt;
  });
  // Freeze the header and enable filtering: on a 5,000-row detail sheet these are the difference
  // between a usable file and a dump.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  }
}

/** A label/value pair on the Summary sheet. `fmt` present ⇒ the value is money in pence. */
function kv(sheet: ExcelJS.Worksheet, label: string, value: string | number, fmt?: string): void {
  const row = sheet.addRow({ label, value });
  if (fmt) row.getCell(2).numFmt = fmt;
}

function sectionHeading(sheet: ExcelJS.Worksheet, title: string): void {
  sheet.addRow({});
  const row = sheet.addRow({ label: title });
  row.font = { bold: true, size: 12 };
}

/** The breakdown sheets are the same shape three times — supplier, project, item. */
const BREAKDOWN_COLS = (labelHeader: string, withQty: boolean): Col[] => [
  { header: labelHeader, key: "label", width: 38 },
  ...(withQty ? [{ header: "Item Code", key: "sublabel", width: 20 }] : []),
  { header: "PO Count", key: "poCount", width: 11, fmt: INT },
  ...(withQty
    ? [
        { header: "Ordered Qty", key: "orderedQty", width: 13, fmt: INT },
        { header: "Received Qty", key: "receivedQty", width: 13, fmt: INT },
      ]
    : []),
  { header: "Net", key: "net", width: 15, fmt: GBP },
  { header: "VAT", key: "vat", width: 15, fmt: GBP },
  { header: "Gross", key: "gross", width: 15, fmt: GBP },
  { header: "Ordered Value", key: "ordered", width: 16, fmt: GBP },
  { header: "Received Value", key: "received", width: 16, fmt: GBP },
  { header: "Outstanding Value", key: "outstanding", width: 17, fmt: GBP },
];

const breakdownRow = (r: BreakdownRow, withQty: boolean) => ({
  label: r.label,
  ...(withQty ? { sublabel: r.sublabel ?? "", orderedQty: r.orderedQty, receivedQty: r.receivedQty } : {}),
  poCount: r.poCount,
  net: pounds(r.netPence),
  vat: pounds(r.vatPence),
  gross: pounds(r.grossPence),
  ordered: pounds(r.orderedPence),
  received: pounds(r.receivedPence),
  outstanding: pounds(r.outstandingPence),
});

/** Sheet names, exported so the tests assert against the same strings the workbook is built from. */
export const FINANCE_SHEETS = {
  summary: "Summary",
  supplier: "By Supplier",
  project: "By Project",
  item: "By Item",
  detail: "PO Detail",
} as const;

/**
 * Build the Finance workbook.
 *
 * Every value written here came from `getFinanceSummary` / `getFinanceDetail`. Nothing is recomputed.
 */
export async function buildFinanceWorkbook(summary: FinanceSummary, detail: FinanceDetailRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Senthra";
  wb.created = new Date(summary.generatedAt);

  // ── Sheet 1: Summary ────────────────────────────────────────────────────────────────────────
  const s1 = wb.addWorksheet(FINANCE_SHEETS.summary);
  s1.columns = [
    { header: "", key: "label", width: 40 },
    { header: "", key: "value", width: 26 },
  ];
  const title = s1.addRow({ label: "Finance Report" });
  title.font = { bold: true, size: 16 };
  kv(s1, "Period", summary.period.label);
  kv(s1, "From", summary.period.from.slice(0, 10));
  kv(s1, "To", summary.period.to.slice(0, 10));
  kv(s1, "Timezone", summary.period.timeZone);
  kv(s1, "Currency", summary.basis.currency);
  kv(s1, "Generated", summary.generatedAt);
  // The basis is stated in the file itself: "spend" is a business definition and a reader must be
  // able to see which one produced these figures without asking.
  kv(s1, "Basis", `Dated by ${summary.basis.dateField}; statuses: ${summary.basis.statuses.join(", ")}`);
  kv(s1, "Excluded from all totals", summary.basis.excluded.join(", "));

  sectionHeading(s1, "IRM PURCHASE SPEND (excludes rental / hire)");
  kv(s1, "Net", pounds(summary.totals.netPence), GBP);
  kv(s1, "VAT", pounds(summary.totals.vatPence), GBP);
  kv(s1, "Gross", pounds(summary.totals.grossPence), GBP);

  sectionHeading(s1, "PURCHASE ORDER TRACKING");
  kv(s1, "Ordered value", pounds(summary.tracking.orderedPence), GBP);
  kv(s1, "Received value", pounds(summary.tracking.receivedPence), GBP);
  kv(s1, "Outstanding value", pounds(summary.tracking.outstandingPence), GBP);
  kv(s1, "Purchase orders", summary.tracking.poCount, INT);
  kv(s1, "Suppliers", summary.tracking.supplierCount, INT);
  kv(s1, "Partially received lines", summary.tracking.partiallyReceivedLines, INT);

  // Context, NOT spend. Kept in its own section so no reader can mistake these for totals.
  sectionHeading(s1, "CONTEXT — NOT INCLUDED IN ANY TOTAL ABOVE");
  kv(s1, "Approved, not yet sent to supplier (orders)", summary.tracking.preIssuePoCount, INT);
  kv(s1, "Approved, not yet sent to supplier (net)", pounds(summary.tracking.preIssueNetPence), GBP);
  kv(s1, "Draft purchase orders", summary.excluded.draftPoCount, INT);
  kv(s1, "Cancelled purchase orders", summary.excluded.cancelledPoCount, INT);

  // Hire, entirely apart from the IRM figures. The two undecided treatments are labelled in the file
  // so nobody assumes they are already counted somewhere above.
  sectionHeading(s1, "RENTAL / HIRE — REPORTED SEPARATELY, NOT IRM SPEND");
  kv(s1, "Hire net", pounds(summary.rental.hireNetPence), GBP);
  kv(s1, "Hire VAT", pounds(summary.rental.hireVatPence), GBP);
  kv(s1, "Hire lines", summary.rental.hireLineCount, INT);
  kv(s1, "Extension charges (treatment not yet defined)", pounds(summary.rental.extensionChargePence), GBP);
  kv(s1, "Damage charges quoted (treatment not yet defined)", pounds(summary.rental.damageChargePence), GBP);
  kv(s1, "Damage charge lines", summary.rental.damageChargeLines, INT);
  // Loss is its own line: kit that is gone, charged at replacement. Not a flavour of damage.
  kv(s1, "Loss charges quoted (treatment not yet defined)", pounds(summary.rental.lossChargePence), GBP);
  kv(s1, "Loss charge lines", summary.rental.lossChargeLines, INT);

  // ── Sheets 2–4: the breakdowns ──────────────────────────────────────────────────────────────
  addTable(
    wb.addWorksheet(FINANCE_SHEETS.supplier),
    BREAKDOWN_COLS("Supplier", false),
    summary.bySupplier.map((r) => breakdownRow(r, false)),
  );
  addTable(
    wb.addWorksheet(FINANCE_SHEETS.project),
    BREAKDOWN_COLS("Project", false),
    // Includes the "Unattributed / General Procurement" row exactly as the service produced it —
    // dropping it would make this sheet disagree with the Summary total.
    summary.byProject.map((r) => breakdownRow(r, false)),
  );
  addTable(
    wb.addWorksheet(FINANCE_SHEETS.item),
    BREAKDOWN_COLS("IRM Item", true),
    // IRM only. Hire items never reach this sheet — they are not in `byItem`.
    summary.byItem.map((r) => breakdownRow(r, true)),
  );

  // ── Sheet 5: PO detail ──────────────────────────────────────────────────────────────────────
  addTable(
    wb.addWorksheet(FINANCE_SHEETS.detail),
    [
      { header: "PO", key: "poCode", width: 14 },
      { header: "PO Date", key: "orderDate", width: 12 },
      { header: "Status", key: "poStatus", width: 18 },
      { header: "Supplier", key: "supplierName", width: 28 },
      { header: "Project", key: "projectLabel", width: 30 },
      { header: "IRM Item", key: "itemName", width: 32 },
      { header: "Item Code", key: "itemCode", width: 20 },
      { header: "Ordered Qty", key: "quantity", width: 12, fmt: INT },
      { header: "Received Qty", key: "receivedQuantity", width: 13, fmt: INT },
      { header: "Outstanding Qty", key: "outstandingQuantity", width: 15, fmt: INT },
      { header: "Unit Price", key: "unitPrice", width: 13, fmt: GBP },
      { header: "VAT %", key: "vatRate", width: 8 },
      { header: "Net", key: "net", width: 15, fmt: GBP },
      { header: "VAT", key: "vat", width: 15, fmt: GBP },
      { header: "Gross", key: "gross", width: 15, fmt: GBP },
    ],
    detail.map((r) => ({
      poCode: r.poCode,
      orderDate: r.orderDate,
      poStatus: r.poStatus,
      supplierName: r.supplierName,
      projectLabel: r.projectLabel,
      itemName: r.itemName,
      itemCode: r.itemCode,
      quantity: r.quantity,
      receivedQuantity: r.receivedQuantity,
      outstandingQuantity: r.outstandingQuantity,
      unitPrice: pounds(r.unitPricePence),
      vatRate: r.vatRate,
      net: pounds(r.netPence),
      vat: pounds(r.vatPence),
      gross: pounds(r.grossPence),
    })),
  );

  // exceljs types this as its own Buffer-like; the runtime value IS a Node Buffer.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Deterministic, safe filename — no user-supplied string ever reaches it.
 *
 * The period LABEL is not interpolated (it can contain an en-dash and spaces); the ISO date of
 * generation is stable, sortable and always filesystem-safe.
 */
export function financeWorkbookFilename(generatedAt: string): string {
  return `Finance_Report_${generatedAt.slice(0, 10)}.xlsx`;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
