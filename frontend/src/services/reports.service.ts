import { api, apiFile } from "@/lib/api";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";

// Typed wrapper over the Finance reporting endpoint. A hand-maintained mirror of the backend's
// finance.types.ts — keep them structurally identical.
//
// The important contract: EVERY figure here is computed server-side by the canonical finance service.
// Nothing in the frontend adds, filters or rounds money. That is what stops the dashboard and the CSV
// export disagreeing — they render the same object.

export type ReportPeriod = "week" | "month" | "custom";

export interface MoneyTotals {
  netPence: number;
  vatPence: number;
  grossPence: number;
}

export interface BreakdownRow extends MoneyTotals {
  key: string;
  label: string;
  sublabel?: string;
  poCount: number;
  lineCount: number;
  /** Per-row commitment view, accumulated in the same server pass as the money above. */
  orderedPence: number;
  receivedPence: number;
  outstandingPence: number;
  orderedQty: number;
  receivedQty: number;
}

export interface TrendPoint {
  bucket: string;
  netPence: number;
  poCount: number;
}

export interface PoTracking {
  orderedPence: number;
  receivedPence: number;
  outstandingPence: number;
  poCount: number;
  supplierCount: number;
  preIssuePoCount: number;
  preIssueNetPence: number;
  partiallyReceivedLines: number;
}

/** Hire money — reported beside IRM spend, never inside it. */
export interface RentalTotals {
  hireNetPence: number;
  hireVatPence: number;
  hireLineCount: number;
  extensionChargePence: number;
  damageChargePence: number;
  damageChargeLines: number;
  /** Replacement charges for kit that is gone — a different event from damage, reported separately. */
  lossChargePence: number;
  lossChargeLines: number;
}

export interface FinanceSummary {
  period: { from: string; to: string; period: ReportPeriod; label: string; timeZone: string };
  /** What the report means by "spend" — rendered on the screen so the basis is never assumed. */
  basis: { statuses: string[]; excluded: string[]; dateField: string; currency: string };
  totals: MoneyTotals;
  tracking: PoTracking;
  trend: { grain: "day" | "month"; points: TrendPoint[] };
  bySupplier: BreakdownRow[];
  byItem: BreakdownRow[];
  byProject: BreakdownRow[];
  rental: RentalTotals;
  excluded: { draftPoCount: number; cancelledPoCount: number };
  generatedAt: string;
}

export interface FinanceQuery {
  period?: ReportPeriod;
  from?: string;
  to?: string;
  supplierId?: string;
}

function qs(q: FinanceQuery): string {
  const p = new URLSearchParams();
  if (q.period) p.set("period", q.period);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.supplierId) p.set("supplierId", q.supplierId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function getFinanceSummary(q: FinanceQuery = {}): Promise<FinanceSummary> {
  const { summary } = await api<{ summary: FinanceSummary }>(`/reports/finance/summary${qs(q)}`);
  return summary;
}

/** Every download shares the screen's current filters — see lib/csvExport. */
export const financeSummaryCsvUrl = (q: FinanceQuery = {}) => `/reports/finance/summary/export.csv${qs(q)}`;
export const financeLinesCsvUrl = (q: FinanceQuery = {}) => `/reports/finance/lines/export.csv${qs(q)}`;

/**
 * The Excel workbook — the same period, the same filters, the same server-computed figures as the
 * screen and the CSVs. Only the container differs.
 *
 * Goes through `apiFile` like the CSV path rather than a bare fetch: that is what keeps the shared
 * client's silent refresh-on-401, so a download fired seconds after the access token expires
 * refreshes and replays instead of failing. The server names the file, so the fallback below is only
 * reached if the Content-Disposition header is stripped.
 */
export async function downloadFinanceWorkbook(q: FinanceQuery = {}): Promise<void> {
  const { blob, headers } = await apiFile(`/reports/finance/export.xlsx${qs(q)}`);
  const fallback = `Finance_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(blob, filenameFromDisposition(headers["content-disposition"] ?? null, fallback));
}

// ── Custom Reports (FLOW 10B) ──────────────────────────────────────────────────────────────────
//
// The report catalogue comes from the SERVER. The client picks a key from this list and a set of
// filters; it never names a table, column or sort — there is no surface here on which to construct a
// query, which is the whole point of the backend registry.

export interface CustomReportColumn {
  key: string;
  header: string;
  numeric?: boolean;
}

export interface CustomReportType {
  key: string;
  label: string;
  description: string;
  filters: string[];
  columns: CustomReportColumn[];
  customerVisible: boolean;
  financial: boolean;
}

export interface CustomReportResult {
  report: { key: string; label: string; description: string; columns: CustomReportColumn[] };
  rows: Record<string, string | number>[];
  /** True when the row cap was hit — surfaced to the user, never silently truncated. */
  capped: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  appliedFilters: Record<string, string>;
  generatedAt: string;
}

export interface CustomReportQuery {
  report: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  projectId?: string;
  warehouseId?: string;
  irmItemId?: string;
  engineerId?: string;
  itemKind?: string;
  cursor?: string | null;
  limit?: number;
}

function customQs(q: CustomReportQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v != null && v !== "") p.set(k, String(v));
  return p.toString() ? `?${p.toString()}` : "";
}

export async function listCustomReportTypes(): Promise<CustomReportType[]> {
  const { reports } = await api<{ reports: CustomReportType[] }>("/reports/custom/types");
  return reports;
}

export async function runCustomReport(q: CustomReportQuery): Promise<CustomReportResult> {
  const { result } = await api<{ result: CustomReportResult }>(`/reports/custom${customQs(q)}`);
  return result;
}

export const customReportCsvUrl = (q: CustomReportQuery) => `/reports/custom/export.csv${customQs(q)}`;

/** Binary download through the shared apiFile path, so 401-refresh-and-replay still works. */
/**
 * Returns `capped` for the same reason `downloadCsv` does: a workbook that stopped short opens
 * looking complete, so the caller has to be able to say so.
 */
export async function downloadCustomReportXlsx(q: CustomReportQuery): Promise<{ capped: boolean }> {
  const { blob, headers } = await apiFile(`/reports/custom/export.xlsx${customQs(q)}`);
  const fallback = `${q.report}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(blob, filenameFromDisposition(headers["content-disposition"] ?? null, fallback));
  return { capped: String(headers["x-export-capped"] ?? "") === "true" };
}

// ── Scheduled reports ──────────────────────────────────────────────────────────────────────────
//
// The report catalogue for the schedule form comes from `/reports/schedules/types` — filtered by what
// the CALLER may schedule, so a user is never offered a report the save would then refuse. Finance
// schedules require the finance permission; the server enforces it on every read and write, and this
// module only reflects the answer.

export interface SchedulableReport {
  key: string;
  label: string;
  description: string;
  filters: string[];
  financial: boolean;
}

export interface ReportSchedule {
  id: string;
  name: string;
  reportKey: string;
  cadence: "weekly" | "monthly";
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timeZone: string | null;
  format: "xlsx" | "csv";
  /** The stored selection — user ids. What the edit form selects against. */
  recipients: string[];
  /**
   * The same list made readable, in the same order. Server-resolved: the client holds no user
   * directory, and a column of raw ObjectIds is not a recipient list.
   */
  recipientLabels: string[];
  filters: Record<string, string> | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /**
   * The last run's outcome, so the LIST can show that a schedule is failing.
   *
   * `null` where it has never run. Status and the operator's error string only — never a figure from
   * the report it produced, which is the same rule the run-history modal follows.
   */
  lastRunStatus: "pending" | "running" | "delivered" | "failed" | null;
  lastRunError: string | null;
  /**
   * The most recent run burnt every attempt.
   *
   * THE signal the list was missing. Once a run is out of attempts the scheduler gives up on that
   * period and advances, so the row goes back to an "Active" badge and a future "Next run" while the
   * report is, in fact, no longer arriving — visible only to somebody who opened that one schedule's
   * run history. A report that silently stopped is the failure the whole module exists to prevent.
   */
  lastRunExhausted: boolean;
}

export interface ReportRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  status: "pending" | "running" | "delivered" | "failed";
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  deliveredTo: string[];
  error: string | null;
  rowCount: number | null;
}

export interface SchedulePayload {
  name: string;
  reportKey: string;
  cadence: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  hour?: number;
  minute?: number;
  format?: string;
  recipients: string[];
  filters?: Record<string, string>;
  enabled?: boolean;
}

/** A user who may be put on a schedule's recipient list. Derived server-side, never guessed here. */
export interface ScheduleRecipient {
  id: string;
  name: string;
  email: string;
}

export interface SchedulableReportsResponse {
  reports: SchedulableReport[];
  /** Settings -> Company -> Timezone. Shown read-only; the form never asks for a timezone. */
  companyTimeZone: string;
}

export async function listSchedulableReports(): Promise<SchedulableReportsResponse> {
  return api<SchedulableReportsResponse>("/reports/schedules/types");
}

export async function listScheduleRecipients(reportKey: string): Promise<ScheduleRecipient[]> {
  const qs = new URLSearchParams({ reportKey });
  return (await api<{ recipients: ScheduleRecipient[] }>(`/reports/schedules/recipients?${qs}`)).recipients;
}

export async function listSchedules(): Promise<ReportSchedule[]> {
  return (await api<{ schedules: ReportSchedule[] }>("/reports/schedules")).schedules;
}

export async function listScheduleRuns(id: string): Promise<ReportRun[]> {
  return (await api<{ runs: ReportRun[] }>(`/reports/schedules/${id}/runs`)).runs;
}

export async function createSchedule(payload: SchedulePayload): Promise<ReportSchedule> {
  return (await api<{ schedule: ReportSchedule }>("/reports/schedules", { method: "POST", body: payload })).schedule;
}

export async function updateSchedule(id: string, payload: SchedulePayload): Promise<ReportSchedule> {
  return (await api<{ schedule: ReportSchedule }>(`/reports/schedules/${id}`, { method: "PUT", body: payload })).schedule;
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<ReportSchedule> {
  return (
    await api<{ schedule: ReportSchedule }>(`/reports/schedules/${id}/enabled`, { method: "PATCH", body: { enabled } })
  ).schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  await api(`/reports/schedules/${id}`, { method: "DELETE" });
}
