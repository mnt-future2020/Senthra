import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { buildFinanceWorkbook, financeWorkbookFilename, FINANCE_SHEETS, XLSX_MIME } from "./finance.xlsx.js";
import type { BreakdownRow, FinanceDetailRow, FinanceSummary } from "./finance.types.js";
import { UNATTRIBUTED_PROJECT_KEY, UNATTRIBUTED_PROJECT_LABEL } from "./reports.constants.js";

// These tests GENERATE a real workbook and READ IT BACK with the same library, so they prove the file
// actually parses — not merely that the builder returned a Buffer. A corrupt workbook and a valid one
// are both Buffers; only a round-trip tells them apart.
//
// What is being protected: the XLSX layer must render the canonical Finance result and change NOTHING.
// Every assertion below compares a cell against the figure the service produced.

const row = (over: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key: "k1",
  label: "Acme Ltd",
  poCount: 2,
  lineCount: 3,
  netPence: 50_000,
  vatPence: 10_000,
  grossPence: 60_000,
  orderedPence: 50_000,
  receivedPence: 20_000,
  outstandingPence: 30_000,
  orderedQty: 10,
  receivedQty: 4,
  ...over,
});

const summary = (over: Partial<FinanceSummary> = {}): FinanceSummary => ({
  period: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z", period: "month", label: "Sep 2026", timeZone: "Europe/London" },
  basis: { statuses: ["sent", "closed"], excluded: ["draft", "cancelled"], dateField: "orderDate", currency: "GBP" },
  totals: { netPence: 123_456, vatPence: 24_691, grossPence: 148_147 },
  tracking: {
    orderedPence: 200_000,
    receivedPence: 80_000,
    outstandingPence: 120_000,
    poCount: 7,
    supplierCount: 3,
    preIssuePoCount: 2,
    preIssueNetPence: 15_000,
    partiallyReceivedLines: 4,
  },
  trend: { grain: "day", points: [{ bucket: "2026-09-01", netPence: 1000, poCount: 1 }] },
  bySupplier: [row({ key: "sup1", label: "Acme Ltd" })],
  byProject: [row({ key: "prj1", label: "BT Core Migration" })],
  byItem: [row({ key: "irm1", label: "SFP-LX", sublabel: "IRM-SFP-LX" })],
  rental: { hireNetPence: 90_000, hireVatPence: 18_000, hireLineCount: 2, extensionChargePence: 5_000, damageChargePence: 1_500, damageChargeLines: 1, lossChargePence: 42_000, lossChargeLines: 1 },
  excluded: { draftPoCount: 3, cancelledPoCount: 1 },
  generatedAt: "2026-09-15T10:30:00.000Z",
  ...over,
});

const detail = (over: Partial<FinanceDetailRow> = {}): FinanceDetailRow => ({
  poCode: "PO-0001",
  poStatus: "sent",
  orderDate: "2026-09-04",
  supplierName: "Acme Ltd",
  projectLabel: "BT Core Migration",
  itemName: "SFP-LX",
  itemCode: "IRM-SFP-LX",
  quantity: 10,
  receivedQuantity: 4,
  outstandingQuantity: 6,
  unitPricePence: 5_000,
  vatRate: 20,
  netPence: 50_000,
  vatPence: 10_000,
  grossPence: 60_000,
  ...over,
});

/** Build, then parse back with the same library — the only honest test of a binary format. */
async function roundTrip(s: FinanceSummary, d: FinanceDetailRow[]): Promise<ExcelJS.Workbook> {
  const buffer = await buildFinanceWorkbook(s, d);
  expect(buffer.byteLength).toBeGreaterThan(0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  return wb;
}

/** Find a Summary-sheet value by its label — the sheet is label/value pairs, not a fixed grid. */
function summaryValue(wb: ExcelJS.Workbook, label: string): unknown {
  const sheet = wb.getWorksheet(FINANCE_SHEETS.summary)!;
  let found: unknown;
  sheet.eachRow((r) => {
    if (String(r.getCell(1).value ?? "").trim() === label) found = r.getCell(2).value;
  });
  return found;
}

/** Header strings of a table sheet, in order. */
function headers(wb: ExcelJS.Workbook, name: string): string[] {
  const sheet = wb.getWorksheet(name)!;
  const out: string[] = [];
  sheet.getRow(1).eachCell((c) => out.push(String(c.value ?? "")));
  return out;
}

/** Data rows of a table sheet as label→value maps, keyed by the header row. */
function tableRows(wb: ExcelJS.Workbook, name: string): Record<string, unknown>[] {
  const sheet = wb.getWorksheet(name)!;
  const cols = headers(wb, name);
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((r, i) => {
    if (i === 1) return;
    const o: Record<string, unknown> = {};
    cols.forEach((h, ci) => (o[h] = r.getCell(ci + 1).value));
    rows.push(o);
  });
  return rows;
}

describe("the workbook is a real, parseable XLSX", () => {
  it("round-trips through exceljs with every expected sheet", async () => {
    const wb = await roundTrip(summary(), [detail()]);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      FINANCE_SHEETS.summary,
      FINANCE_SHEETS.supplier,
      FINANCE_SHEETS.project,
      FINANCE_SHEETS.item,
      FINANCE_SHEETS.detail,
    ]);
  });

  it("declares the Excel MIME type and a safe, deterministic filename", () => {
    expect(XLSX_MIME).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(financeWorkbookFilename("2026-09-15T10:30:00.000Z")).toBe("Finance_Report_2026-09-15.xlsx");
    // No user string reaches the name — nothing to escape, nothing to inject.
    expect(financeWorkbookFilename("2026-09-15T10:30:00.000Z")).toMatch(/^Finance_Report_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("carries the report period, basis and generation time so the file is self-describing", async () => {
    const wb = await roundTrip(summary(), [detail()]);
    expect(summaryValue(wb, "Period")).toBe("Sep 2026");
    expect(summaryValue(wb, "Currency")).toBe("GBP");
    expect(String(summaryValue(wb, "Basis"))).toContain("orderDate");
    expect(String(summaryValue(wb, "Excluded from all totals"))).toContain("cancelled");
  });
});

describe("XLSX changes NO figure — it renders the canonical result", () => {
  // The core guarantee. Cells are in POUNDS for display; the source of truth stays integer pence, so
  // each assertion is `pence / 100` against the exact value the service produced.
  it("writes Net, VAT and Gross exactly as the service computed them", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(summaryValue(wb, "Net")).toBe(s.totals.netPence / 100);
    expect(summaryValue(wb, "VAT")).toBe(s.totals.vatPence / 100);
    expect(summaryValue(wb, "Gross")).toBe(s.totals.grossPence / 100);
  });

  it("writes ordered, received and outstanding exactly as the service computed them", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(summaryValue(wb, "Ordered value")).toBe(s.tracking.orderedPence / 100);
    expect(summaryValue(wb, "Received value")).toBe(s.tracking.receivedPence / 100);
    expect(summaryValue(wb, "Outstanding value")).toBe(s.tracking.outstandingPence / 100);
    expect(summaryValue(wb, "Purchase orders")).toBe(s.tracking.poCount);
    expect(summaryValue(wb, "Suppliers")).toBe(s.tracking.supplierCount);
  });

  // A VAT figure recomputed in the spreadsheet could differ from the per-line-rounded one the whole
  // Finance module is built on. The workbook must contain NO formula over money.
  it("contains no spreadsheet formulas that could re-derive a money value", async () => {
    const wb = await roundTrip(summary(), [detail(), detail({ poCode: "PO-0002" })]);
    for (const sheet of wb.worksheets) {
      sheet.eachRow((r) =>
        r.eachCell((c) => {
          expect(c.type, `${sheet.name} contains a formula cell — money must never be recomputed in Excel`).not.toBe(
            ExcelJS.ValueType.Formula,
          );
        }),
      );
    }
  });

  // 24,691p must land as 246.91, not 246.9 or 246.910000000001.
  it("converts pence to pounds exactly, with a currency number format", async () => {
    const wb = await roundTrip(summary({ totals: { netPence: 123_456, vatPence: 24_691, grossPence: 148_147 } }), [detail()]);
    expect(summaryValue(wb, "VAT")).toBe(246.91);
    const sheet = wb.getWorksheet(FINANCE_SHEETS.supplier)!;
    // The format is applied to the column, so the cell renders as £ rather than a bare number.
    expect(String(sheet.getColumn(3).numFmt ?? "")).toContain("£");
  });
});

describe("breakdown sheets match the canonical rows", () => {
  it("By Supplier carries the service's supplier totals", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(headers(wb, FINANCE_SHEETS.supplier)).toEqual([
      "Supplier",
      "PO Count",
      "Net",
      "VAT",
      "Gross",
      "Ordered Value",
      "Received Value",
      "Outstanding Value",
    ]);
    const [r] = tableRows(wb, FINANCE_SHEETS.supplier);
    const src = s.bySupplier[0]!;
    expect(r).toMatchObject({
      Supplier: src.label,
      "PO Count": src.poCount,
      Net: src.netPence / 100,
      VAT: src.vatPence / 100,
      Gross: src.grossPence / 100,
      "Ordered Value": src.orderedPence / 100,
      "Received Value": src.receivedPence / 100,
      "Outstanding Value": src.outstandingPence / 100,
    });
  });

  it("By Item adds the item code and the quantity columns, IRM only", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(headers(wb, FINANCE_SHEETS.item)).toContain("Item Code");
    expect(headers(wb, FINANCE_SHEETS.item)).toContain("Ordered Qty");
    const [r] = tableRows(wb, FINANCE_SHEETS.item);
    expect(r).toMatchObject({ "IRM Item": "SFP-LX", "Item Code": "IRM-SFP-LX", "Ordered Qty": 10, "Received Qty": 4 });
  });

  it("PO Detail renders the priced rows without touching them", async () => {
    const d = detail();
    const wb = await roundTrip(summary(), [d]);
    const [r] = tableRows(wb, FINANCE_SHEETS.detail);
    expect(r).toMatchObject({
      PO: d.poCode,
      "PO Date": d.orderDate,
      Status: d.poStatus,
      Supplier: d.supplierName,
      Project: d.projectLabel,
      "IRM Item": d.itemName,
      "Ordered Qty": d.quantity,
      "Received Qty": d.receivedQuantity,
      "Outstanding Qty": d.outstandingQuantity,
      "Unit Price": d.unitPricePence / 100,
      Net: d.netPence / 100,
      VAT: d.vatPence / 100,
      Gross: d.grossPence / 100,
    });
  });
});

describe("rental safety — hire never becomes IRM spend", () => {
  it("keeps hire, extensions and damage in their own section with the undecided treatment stated", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(summaryValue(wb, "Hire net")).toBe(s.rental.hireNetPence / 100);
    expect(summaryValue(wb, "Extension charges (treatment not yet defined)")).toBe(s.rental.extensionChargePence / 100);
    expect(summaryValue(wb, "Damage charges quoted (treatment not yet defined)")).toBe(s.rental.damageChargePence / 100);
    // Loss is its OWN line, not folded into damage — kit that is gone, charged at replacement.
    expect(summaryValue(wb, "Loss charges quoted (treatment not yet defined)")).toBe(s.rental.lossChargePence / 100);
    // The IRM headline is untouched by any of it.
    expect(summaryValue(wb, "Net")).toBe(s.totals.netPence / 100);
  });

  // A rental-only period: hire money exists, IRM spend is zero. The workbook must not "helpfully"
  // surface the hire value as spend.
  it("a rental-only period reports zero IRM spend", async () => {
    const s = summary({
      totals: { netPence: 0, vatPence: 0, grossPence: 0 },
      bySupplier: [],
      byItem: [],
      byProject: [],
    });
    const wb = await roundTrip(s, []);
    expect(summaryValue(wb, "Net")).toBe(0);
    expect(summaryValue(wb, "Hire net")).toBe(900);
    expect(tableRows(wb, FINANCE_SHEETS.item)).toEqual([]);
  });
});

describe("project safety", () => {
  it("renders the Unattributed bucket rather than dropping it", async () => {
    const s = summary({
      byProject: [row({ key: UNATTRIBUTED_PROJECT_KEY, label: UNATTRIBUTED_PROJECT_LABEL, netPence: 50_000 })],
    });
    const wb = await roundTrip(s, [detail({ projectLabel: UNATTRIBUTED_PROJECT_LABEL })]);
    expect(tableRows(wb, FINANCE_SHEETS.project)[0]).toMatchObject({ Project: UNATTRIBUTED_PROJECT_LABEL, Net: 500 });
    expect(tableRows(wb, FINANCE_SHEETS.detail)[0]).toMatchObject({ Project: UNATTRIBUTED_PROJECT_LABEL });
  });

  it("project rows in the workbook still sum to the sheet-1 net total", async () => {
    const s = summary({
      totals: { netPence: 75_000, vatPence: 15_000, grossPence: 90_000 },
      byProject: [
        row({ key: "prj1", label: "P1", netPence: 50_000 }),
        row({ key: UNATTRIBUTED_PROJECT_KEY, label: UNATTRIBUTED_PROJECT_LABEL, netPence: 25_000 }),
      ],
    });
    const wb = await roundTrip(s, [detail()]);
    const sum = tableRows(wb, FINANCE_SHEETS.project).reduce((n, r) => n + Number(r.Net), 0);
    expect(sum).toBe(Number(summaryValue(wb, "Net")));
  });
});

describe("context rows are never mistaken for spend", () => {
  it("reports draft, cancelled and awaiting-issue counts outside every total", async () => {
    const s = summary();
    const wb = await roundTrip(s, [detail()]);
    expect(summaryValue(wb, "Draft purchase orders")).toBe(3);
    expect(summaryValue(wb, "Cancelled purchase orders")).toBe(1);
    expect(summaryValue(wb, "Approved, not yet sent to supplier (orders)")).toBe(2);
    expect(summaryValue(wb, "Approved, not yet sent to supplier (net)")).toBe(150);
  });
});

describe("empty state", () => {
  // A period with no purchase orders must still produce a VALID workbook that states its period and
  // its zeros — an empty or corrupt file would look like a failure the user cannot distinguish.
  it("produces a valid workbook with every sheet and zeroed totals", async () => {
    const s = summary({
      totals: { netPence: 0, vatPence: 0, grossPence: 0 },
      tracking: { orderedPence: 0, receivedPence: 0, outstandingPence: 0, poCount: 0, supplierCount: 0, preIssuePoCount: 0, preIssueNetPence: 0, partiallyReceivedLines: 0 },
      bySupplier: [],
      byItem: [],
      byProject: [],
      rental: { hireNetPence: 0, hireVatPence: 0, hireLineCount: 0, extensionChargePence: 0, damageChargePence: 0, damageChargeLines: 0, lossChargePence: 0, lossChargeLines: 0 },
      excluded: { draftPoCount: 0, cancelledPoCount: 0 },
    });
    const wb = await roundTrip(s, []);
    expect(wb.worksheets).toHaveLength(5);
    expect(summaryValue(wb, "Net")).toBe(0);
    expect(summaryValue(wb, "Period")).toBe("Sep 2026");
    // Headers still present, so the file is usable rather than blank.
    expect(headers(wb, FINANCE_SHEETS.detail)).toContain("PO");
    expect(tableRows(wb, FINANCE_SHEETS.detail)).toEqual([]);
  });
});
