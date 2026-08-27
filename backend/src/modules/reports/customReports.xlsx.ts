import ExcelJS from "exceljs";

import type { CustomReportResult } from "./customReports.service.js";

/**
 * Custom report → XLSX. Registry-driven: columns, headings and alignment all come from the report
 * definition, so a new report type gets a correct workbook with no code here.
 *
 * Two sheets — the data, and the parameters that produced it. A report whose filters are not recorded
 * beside it cannot be reproduced or audited later, which is the same reason the Finance workbook
 * prints its basis.
 */
export async function buildCustomReportWorkbook(result: CustomReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Senthra";
  wb.created = new Date(result.generatedAt);

  const sheet = wb.addWorksheet(result.report.label.slice(0, 31)); // Excel caps sheet names at 31 chars
  sheet.columns = result.report.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.numeric ? 12 : 24,
  }));
  const head = sheet.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  head.height = 20;
  for (const r of result.rows) sheet.addRow(r);
  result.report.columns.forEach((c, i) => {
    if (c.numeric) sheet.getColumn(i + 1).numFmt = "#,##0";
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (result.rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: result.report.columns.length } };
  }

  const meta = wb.addWorksheet("Report Info");
  meta.columns = [
    { header: "", key: "k", width: 26 },
    { header: "", key: "v", width: 52 },
  ];
  meta.addRow({ k: "Report", v: result.report.label });
  meta.addRow({ k: "Description", v: result.report.description });
  meta.addRow({ k: "Generated", v: result.generatedAt });
  meta.addRow({ k: "Rows", v: result.rows.length });
  if (result.capped) meta.addRow({ k: "Truncated", v: "Yes — narrow the filters to see everything" });
  meta.addRow({});
  meta.addRow({ k: "FILTERS APPLIED" }).font = { bold: true };
  const applied = Object.entries(result.appliedFilters);
  if (applied.length === 0) meta.addRow({ k: "(none)", v: "" });
  for (const [k, v] of applied) meta.addRow({ k, v });

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/** Deterministic and safe — the report KEY is a registry constant, never a user string. */
export function customReportFilename(reportKey: string, generatedAt: string): string {
  const name = reportKey.replace(/[^a-z0-9_]/gi, "").replace(/_/g, "-");
  return `${name}-${generatedAt.slice(0, 10)}.xlsx`;
}
