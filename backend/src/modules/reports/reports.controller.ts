import * as financeService from "./finance.service.js";
import { financeLinesCsv, financeSummaryCsv } from "./finance.csv.js";
import { buildFinanceWorkbook, financeWorkbookFilename, XLSX_MIME } from "./finance.xlsx.js";
import * as customReportsService from "./customReports.service.js";
import * as scheduleService from "./reportSchedule.service.js";
import { customReportCsv } from "./customReports.csv.js";
import { buildCustomReportWorkbook, customReportFilename } from "./customReports.xlsx.js";
import { assertRangeWithinLimit, financeQuerySchema, parseLimit, type ScheduleWriteInput } from "./reports.validation.js";
import { SCREEN_BREAKDOWN_ROWS } from "./reports.constants.js";
import * as audit from "#modules/audit/audit.service.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import { actorFrom } from "../../utils/actor.js";
import { param, queryStr } from "../../utils/request.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { EXPORT_CAPPED_HEADER, sendCsv } from "../../utils/csv-response.js";
import { parseFilterDate } from "../../utils/filter-date.js";
import { badRequest, forbidden } from "../../utils/http-error.js";
import type { Request } from "express";

// Thin HTTP glue. Every figure comes from finance.service — nothing is computed here.

function parseQuery(req: Request) {
  const parsed = financeQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid report filters.");
  const q = parsed.data;
  // The SHARED date parser, so a report's bounds mean exactly what they mean on every other filtered
  // screen — start-of-day / end-of-day, one convention.
  const from = parseFilterDate(q.from, "start");
  const to = parseFilterDate(q.to, "end");

  // A custom window is the one input here with no natural ceiling, and the read behind it loads every
  // order in range. Bounded at THIS boundary rather than in the service, because the service also
  // serves the scheduler, whose range comes from a cadence and cannot be pathological.
  assertRangeWithinLimit(from, to);

  return { period: q.period, from, to, supplierId: q.supplierId };
}

// GET /reports/finance/summary
//
// The SCREEN's read, and the only caller that caps the breakdowns: a year by item can be thousands of
// rows, which is a payload and a DOM nobody benefits from. The exports below deliberately pass no
// limit — detail belongs in the file — and both still total to the same headline, because the
// remainder is folded into one row rather than dropped.
export const financeSummary = asyncHandler(async (req, res) => {
  const summary = await financeService.getFinanceSummary(actorFrom(req), {
    ...parseQuery(req),
    breakdownLimit: SCREEN_BREAKDOWN_ROWS,
  });
  res.json({ summary });
});

// GET /reports/finance/summary/export.csv
export const financeSummaryExport = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const summary = await financeService.getFinanceSummary(actor, parseQuery(req));
  // Audited: "Report generated" is an explicit client audit requirement, and an export of financial
  // data is the one reporting action worth a permanent record of who took it and for what period.
  audit.record({
    actor,
    action: "report.exported",
    targetType: "report",
    targetLabel: `Finance summary — ${summary.period.label}`,
    metadata: { report: "finance.summary", period: summary.period.label, netPence: summary.totals.netPence },
  });
  sendCsv(res, "finance-summary", financeSummaryCsv(summary));
});

// GET /reports/finance/lines/export.csv
export const financeLinesExport = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const { periodLabel, rows } = await financeService.getFinanceDetail(actor, parseQuery(req));
  audit.record({
    actor,
    action: "report.exported",
    targetType: "report",
    targetLabel: `Finance lines — ${periodLabel}`,
    metadata: { report: "finance.lines", format: "csv", period: periodLabel, rows: rows.length },
  });
  sendCsv(res, "finance-lines", financeLinesCsv(periodLabel, rows));
});

// GET /reports/finance/export.xlsx
//
// The workbook is built from the SAME canonical result the dashboard and the CSVs render — the two
// service calls below are the only source of any figure in the file. Both are bounded by the period
// and the actor's warehouse scope, and both use the existing two-step read, so there is no per-row
// query behind the spreadsheet.
export const financeWorkbookExport = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const query = parseQuery(req);
  const [summary, detail] = await Promise.all([
    financeService.getFinanceSummary(actor, query),
    financeService.getFinanceDetail(actor, query),
  ]);

  const buffer = await buildFinanceWorkbook(summary, detail.rows);
  audit.record({
    actor,
    action: "report.exported",
    targetType: "report",
    targetLabel: `Finance workbook — ${summary.period.label}`,
    metadata: {
      report: "finance.workbook",
      format: "xlsx",
      period: summary.period.label,
      netPence: summary.totals.netPence,
      rows: detail.rows.length,
    },
  });

  // Binary, not base64 — the response helper convention every other download here follows.
  const filename = financeWorkbookFilename(summary.generatedAt);
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(buffer.byteLength));
  res.end(buffer);
});

// ── Custom Reports (FLOW 10B) ──────────────────────────────────────────────────────────────────

/**
 * Only the filters the registry knows. Anything else is rejected by the service, not ignored.
 *
 * Every scalar is read through `queryStr`, the codebase's shared reader, rather than off a
 * `Record<string, string | undefined>` cast. The cast was a lie about Express: a DUPLICATED parameter
 * (`?irmItemId=a&irmItemId=b`) arrives as an ARRAY, and an array is neither `undefined` nor `""`, so
 * it sailed past the service's emptiness check and reached Prisma as an array on a scalar ObjectId
 * equality — a 500 on what is a malformed request. `queryStr` collapses a duplicate to its first
 * value, which is the behaviour every other list endpoint here already has.
 */
function customRequestFrom(req: Request) {
  const q = req.query;
  return {
    reportKey: queryStr(q.report) ?? "",
    filters: {
      dateFrom: queryStr(q.dateFrom),
      dateTo: queryStr(q.dateTo),
      customerId: queryStr(q.customerId),
      projectId: queryStr(q.projectId),
      warehouseId: queryStr(q.warehouseId),
      irmItemId: queryStr(q.irmItemId),
      engineerId: queryStr(q.engineerId),
      itemKind: queryStr(q.itemKind),
    },
    limit: parseLimit(queryStr(q.limit)),
    cursor: queryStr(q.cursor) ?? null,
  };
}


// GET /reports/custom/types — the dropdown's ONLY source. The client never names a report we did not
// offer it, because it can only choose a key from here.
export const customReportTypes = asyncHandler(async (req, res) => {
  res.json({ reports: customReportsService.listAvailableReports(actorFrom(req), false) });
});

// GET /reports/custom
export const runCustomReport = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const result = await customReportsService.runCustomReport(actor, customRequestFrom(req));
  audit.record({
    actor,
    action: "report.generated",
    targetType: "report",
    targetLabel: result.report.label,
    metadata: { report: result.report.key, filters: result.appliedFilters, rows: result.rows.length },
  });
  res.json({ result });
});

// GET /reports/custom/export.csv
export const exportCustomReportCsv = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  // The whole bounded set, not the page on screen — an export is "everything matching what I'm
  // looking at", the same rule every other export in this codebase follows.
  const result = await customReportsService.runCustomReport(actor, {
    ...customRequestFrom(req),
    limit: customReportsService.REPORT_MAX_ROWS,
    cursor: null,
  });
  audit.record({
    actor,
    action: "report.exported",
    targetType: "report",
    targetLabel: result.report.label,
    metadata: { report: result.report.key, format: "csv", filters: result.appliedFilters, rows: result.rows.length },
  });
  sendCsv(res, result.report.key.replace(/_/g, "-"), customReportCsv(result));
});

// GET /reports/custom/export.xlsx
export const exportCustomReportXlsx = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const result = await customReportsService.runCustomReport(actor, {
    ...customRequestFrom(req),
    limit: customReportsService.REPORT_MAX_ROWS,
    cursor: null,
  });
  const buffer = await buildCustomReportWorkbook(result);
  // The CSV path has always said when it stopped short; a workbook that does not is worse, because it
  // opens looking complete. Same header, so the client handles both downloads identically.
  if (result.capped) res.setHeader(EXPORT_CAPPED_HEADER, "true");
  audit.record({
    actor,
    action: "report.exported",
    targetType: "report",
    targetLabel: result.report.label,
    metadata: { report: result.report.key, format: "xlsx", filters: result.appliedFilters, rows: result.rows.length },
  });
  const filename = customReportFilename(result.report.key, result.generatedAt);
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(buffer.byteLength));
  res.end(buffer);
});

// ── Customer-facing reports (FLOW 9) ───────────────────────────────────────────────────────────
//
// A SEPARATE route with its own scoping, not the internal endpoint with columns hidden. The customer
// id is taken from `req.principal` and nothing else, so a customer cannot address another's data by
// any query string; and the registry only offers them reports marked `customerVisible`, all of which
// are built without a single money column. The client requirement is explicit: "NO pricing / cost
// data shown" in customer reports.

function portalCustomerId(req: Request): string {
  if (req.principal?.type !== "customer") throw forbidden("Customer access required.");
  return req.principal.customerId;
}

// GET /customer/reports/types
export const customerReportTypes = asyncHandler(async (req, res) => {
  portalCustomerId(req); // asserts the caller IS a customer before anything is listed
  res.json({ reports: customReportsService.listAvailableReports(undefined, true) });
});

// GET /customer/reports
export const runCustomerReport = asyncHandler(async (req, res) => {
  const customerId = portalCustomerId(req);
  const result = await customReportsService.runCustomReport(actorFrom(req), customRequestFrom(req), {
    isCustomer: true,
    customerId,
  });
  res.json({ result });
});

// GET /customer/reports/export.csv
export const exportCustomerReportCsv = asyncHandler(async (req, res) => {
  const customerId = portalCustomerId(req);
  const result = await customReportsService.runCustomReport(
    actorFrom(req),
    { ...customRequestFrom(req), limit: customReportsService.REPORT_MAX_ROWS, cursor: null },
    { isCustomer: true, customerId },
  );
  sendCsv(res, `${result.report.key.replace(/_/g, "-")}`, customReportCsv(result));
});

// GET /customer/reports/export.xlsx
export const exportCustomerReportXlsx = asyncHandler(async (req, res) => {
  const customerId = portalCustomerId(req);
  const result = await customReportsService.runCustomReport(
    actorFrom(req),
    { ...customRequestFrom(req), limit: customReportsService.REPORT_MAX_ROWS, cursor: null },
    { isCustomer: true, customerId },
  );
  const buffer = await buildCustomReportWorkbook(result);
  if (result.capped) res.setHeader(EXPORT_CAPPED_HEADER, "true");
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${customReportFilename(result.report.key, result.generatedAt)}"`);
  res.setHeader("Content-Length", String(buffer.byteLength));
  res.end(buffer);
});

// ── Scheduled report management ────────────────────────────────────────────────────────────────
//
// Thin HTTP glue over reportSchedule.service, which owns every authorisation and validation decision.
// The scheduler CORE is untouched — this manages what it will run, never how it runs.

// GET /reports/schedules/types — the schedule form's ONLY source of report options.
//
// Carries the company timezone with it. Scheduling has no timezone of its own: Settings → Company →
// Timezone is the single setting, and the form shows it read-only rather than asking for it a second
// time. Sent on this existing call so the form still bootstraps in ONE request.
export const schedulableReportTypes = asyncHandler(async (req, res) => {
  res.json({
    reports: scheduleService.schedulableReports(actorFrom(req)),
    companyTimeZone: await getCompanyTimezone(),
  });
});

// GET /reports/schedules/recipients?reportKey=… — who may be sent this report.
//
// The picker's only source, and the same set the save re-derives, so the form can never offer a
// recipient the server would then refuse.
export const scheduleRecipientOptions = asyncHandler(async (req, res) => {
  // Same reader as every other scalar here — a duplicated `?reportKey=` must not become "a,b".
  const reportKey = queryStr(req.query.reportKey) ?? "";
  res.json({ recipients: await scheduleService.listRecipientOptions(actorFrom(req), reportKey) });
});

// GET /reports/schedules
export const listSchedules = asyncHandler(async (req, res) => {
  res.json({ schedules: await scheduleService.listSchedules(actorFrom(req)) });
});

// GET /reports/schedules/:id
export const getSchedule = asyncHandler(async (req, res) => {
  res.json({ schedule: await scheduleService.getSchedule(actorFrom(req), param(req, "id")) });
});

// GET /reports/schedules/:id/runs
export const listScheduleRuns = asyncHandler(async (req, res) => {
  res.json({ runs: await scheduleService.listRuns(actorFrom(req), param(req, "id")) });
});

// POST /reports/schedules
//
// `req.body` is the PARSED value `validateBody(scheduleWriteSchema)` put back on the request, so the
// cast below is a fact rather than the claim it used to be. The service still owns every semantic
// rule; this layer now only guarantees the shape those rules assume.
export const createSchedule = asyncHandler(async (req, res) => {
  const schedule = await scheduleService.createSchedule(actorFrom(req), req.body as ScheduleWriteInput);
  res.status(201).json({ schedule });
});

// PUT /reports/schedules/:id
export const updateSchedule = asyncHandler(async (req, res) => {
  const schedule = await scheduleService.updateSchedule(actorFrom(req), param(req, "id"), req.body as ScheduleWriteInput);
  res.json({ schedule });
});

// PATCH /reports/schedules/:id/enabled
export const setScheduleEnabled = asyncHandler(async (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  res.json({ schedule: await scheduleService.setEnabled(actorFrom(req), param(req, "id"), enabled) });
});

// DELETE /reports/schedules/:id
export const deleteSchedule = asyncHandler(async (req, res) => {
  await scheduleService.deleteSchedule(actorFrom(req), param(req, "id"));
  res.status(204).end();
});
