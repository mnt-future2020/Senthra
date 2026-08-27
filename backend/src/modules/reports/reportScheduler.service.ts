import { randomUUID } from "node:crypto";

import * as scheduleRepo from "./reportSchedule.repository.js";
import * as scheduleService from "./reportSchedule.service.js";
import type { ReportSchedule } from "./reportSchedule.repository.js";
import * as financeService from "./finance.service.js";
import * as customReportsService from "./customReports.service.js";
import { buildFinanceWorkbook, financeWorkbookFilename, XLSX_MIME } from "./finance.xlsx.js";
import { buildCustomReportWorkbook, customReportFilename } from "./customReports.xlsx.js";
import { financeSummaryCsv } from "./finance.csv.js";
import { customReportCsv } from "./customReports.csv.js";
import { completedPeriod, nextRunAfter, SCHEDULE_CADENCES, type ScheduleCadence } from "./reports.period.js";
import { findReport } from "./customReports.registry.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import * as emailTemplateRepo from "#modules/email/emailTemplate.repository.js";
import * as audit from "#modules/audit/audit.service.js";

// ── The scheduler CORE — provider-neutral ──────────────────────────────────────────────────────
//
// One entry point, `runDueSchedules()`. It knows nothing about how it was invoked and deliberately
// contains no timer, no cron expression and no HTTP handler. Whatever wakes it — a platform cron
// hitting a secured route, a worker process, a long-running host's timer, a queue consumer — calls
// this same function, so the production runtime can be chosen (or changed) without touching any of
// the logic below. See docs/reports-scheduler-runtime.md for what an environment must provide.
//
// Safety comes from the database, never from being the only copy running:
//
//   1. IDEMPOTENCY — the run row is keyed `(scheduleId, periodStart)` with a UNIQUE constraint.
//      periodStart is derived purely from cadence + timezone + clock, so a retry an hour later or on
//      another instance computes the same value and collides. A cron platform that retries on a
//      non-2xx cannot double-send.
//   2. MUTUAL EXCLUSION — a run is CLAIMED by a conditional update carrying a token. Two workers that
//      both see the same pending run: exactly one claim succeeds.
//   3. LIVENESS — the claim has a lease. A worker killed mid-flight releases its run to the next
//      sweep rather than stranding the period forever.
//   4. BOUNDED RETRY — the attempt is counted AT CLAIM TIME, so even a crash burns one. A transient
//      SMTP outage recovers next sweep; a permanently broken schedule stops after MAX_ATTEMPTS.

/** How long a worker owns a run before another sweep may reclaim it. */
const CLAIM_LEASE_MS = 10 * 60_000;

/** Excel-friendly CSV, matching what the download path sends. */
const CSV_MIME = "text/csv; charset=utf-8";

/** Schedules processed per sweep. A backlog drains over several sweeps rather than one huge pass. */
const SWEEP_BATCH = 25;

export interface SweepResult {
  /** Schedules that were due when the sweep started. */
  due: number;
  /** Runs this sweep actually delivered. */
  delivered: number;
  /** Periods another worker already owned or had completed — the normal, healthy case for a retry. */
  skipped: number;
  failed: number;
}

/** One line per report kind: how it is produced, and what the email carries. */
interface Generated {
  filename: string;
  contentType: string;
  content: Buffer;
  rowCount: number;
  /** Human summary for the email body — never a financial figure a recipient may not see. */
  summary: string;
}

/**
 * Produce the report a schedule names, for a period.
 *
 * Both branches go through the EXISTING canonical layers — `getFinanceSummary` for finance,
 * `runCustomReport` for everything else. The scheduler computes no figure of its own, so a scheduled
 * report and the same report run by hand are the same numbers by construction.
 *
 * The actor is `undefined`: a schedule runs unattended and is NOT somebody's session. That means no
 * warehouse scoping is applied, which is correct — a schedule is configured by an administrator for a
 * fixed recipient list, and silently narrowing it to whoever last edited it would be worse.
 */
/** A schedule's stored filters, trimmed to the ones the report still declares. */
function pickAccepted(def: { filters: readonly string[] }, filters: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of def.filters) {
    const v = filters[key];
    if (v) out[key] = v;
  }
  return out;
}

async function generate(schedule: ReportSchedule, range: { from: Date; to: Date; label: string }): Promise<Generated> {
  const filters = (schedule.filters ?? {}) as Record<string, string>;

  const asCsv = schedule.format === "csv";

  if (schedule.reportKey === "finance.summary") {
    const query = { period: "custom" as const, from: range.from, to: range.to };
    const [summary, detail] = await Promise.all([
      financeService.getFinanceSummary(undefined, query),
      financeService.getFinanceDetail(undefined, query),
    ]);
    // Both formats render the SAME canonical result — the schedule chooses a container, never a
    // second calculation.
    return {
      filename: asCsv
        ? financeWorkbookFilename(summary.generatedAt).replace(/\.xlsx$/, ".csv")
        : financeWorkbookFilename(summary.generatedAt),
      contentType: asCsv ? CSV_MIME : XLSX_MIME,
      content: asCsv
        ? Buffer.from("﻿" + financeSummaryCsv(summary).csv, "utf8")
        : await buildFinanceWorkbook(summary, detail.rows),
      rowCount: detail.rows.length,
      // Deliberately not a spend figure: an email is not an authorised surface, and the workbook
      // behind it is already gated by who was put on the recipient list.
      summary: `${summary.tracking.poCount} purchase order(s) across ${summary.tracking.supplierCount} supplier(s).`,
    };
  }

  // A report removed from the registry must not keep firing — the schedule is now pointing at nothing.
  const def = findReport(schedule.reportKey);
  if (!def) throw new Error(`Report type "${schedule.reportKey}" no longer exists.`);

  // The period is applied ONLY to a report that declares the date filters.
  //
  // `resolve()` REJECTS a filter a report does not accept — deliberately, so a user is never handed a
  // wider result than they asked for — and injecting the range unconditionally therefore made every
  // run of a position report (Engineer Stock: `engineerId`/`irmItemId`, no dates) throw and burn its
  // attempts. A position report is "what is held right now"; it has no period to narrow, so the
  // schedule's cadence decides how often that snapshot is sent and nothing more.
  const periodFilters =
    def.filters.includes("dateFrom") && def.filters.includes("dateTo")
      ? { dateFrom: range.from.toISOString(), dateTo: range.to.toISOString() }
      : {};

  const result = await customReportsService.runCustomReport(undefined, {
    reportKey: schedule.reportKey,
    // The stored filters are narrowed to what this report still accepts, for the same reason: a
    // report whose filter set shrank after a schedule was saved must keep running, not start failing.
    filters: { ...pickAccepted(def, filters), ...periodFilters },
    limit: customReportsService.REPORT_MAX_ROWS,
    cursor: null,
  });
  return {
    filename: asCsv
      ? customReportFilename(result.report.key, result.generatedAt).replace(/\.xlsx$/, ".csv")
      : customReportFilename(result.report.key, result.generatedAt),
    contentType: asCsv ? CSV_MIME : XLSX_MIME,
    // The BOM matters for CSV opened in Excel — the same one sendCsv prepends for a download.
    content: asCsv ? Buffer.from("﻿" + customReportCsv(result).csv, "utf8") : await buildCustomReportWorkbook(result),
    rowCount: result.rows.length,
    // A truncated attachment that says "5000 record(s)." reads as a complete report. The recipient
    // cannot re-run it with narrower filters unless the email tells them it was cut.
    summary: result.capped
      ? `${result.rows.length} record(s) — this is the maximum a scheduled report carries, so some rows are not included. Narrow the schedule's filters to see everything.`
      : `${result.rows.length} record(s).`,
  };
}

/**
 * Process one due schedule. Returns what happened, for the sweep's tally.
 *
 * Ordering matters and is deliberate: the run row is created and CLAIMED before anything expensive
 * happens, so a second worker arriving mid-generation finds the period taken rather than starting its
 * own copy.
 */
async function processOne(schedule: ReportSchedule, now: Date, companyTz: string): Promise<keyof Omit<SweepResult, "due">> {
  const timeZone = schedule.timeZone || companyTz;
  const cadence = schedule.cadence as ScheduleCadence;
  if (!(SCHEDULE_CADENCES as readonly string[]).includes(cadence)) {
    // A cadence nothing can compute would spin forever. Park the schedule rather than retry it.
    await scheduleRepo.updateSchedule(schedule.id, { enabled: false });
    return "failed";
  }

  const range = completedPeriod(timeZone, cadence, now);

  // 1) Claim the PERIOD via the unique key. Null = somebody else owns it, or it is already delivered.
  const run = await scheduleRepo.createRunIfAbsent({
    scheduleId: schedule.id,
    periodStart: range.from,
    periodEnd: range.to,
    periodLabel: range.label,
  });

  // The row may already exist from a previous failed attempt, which IS retryable — so a duplicate is
  // not automatically a skip. Re-read it and let `claimRun` decide from its state and attempt count.
  const target = run ?? (await scheduleRepo.findRun(schedule.id, range.from));
  if (!target) return "skipped";

  const token = randomUUID();
  if (!(await scheduleRepo.claimRun(target.id, token, CLAIM_LEASE_MS, now))) {
    // Not mine — but WHY decides whether the schedule may move on.
    //
    // A failed claim means exactly one of three things: the period is already delivered, it has burnt
    // its attempts, or another worker is holding a LIVE lease on it right now. (A lapsed lease would
    // have been reclaimed, and a retryable failure would have been claimed, so neither reaches here.)
    //
    // Advancing on the third case is a bug: the holder may still fail, and it deliberately does not
    // advance so the period stays due for its remaining attempts — but if this worker has already
    // moved the clock on, that retry never comes and the period silently loses its attempts. Re-read
    // rather than trust `target`, which was fetched before the claim was attempted.
    const current = (await scheduleRepo.findRun(schedule.id, range.from)) ?? target;
    if (isSettled(current)) await advance(schedule, timeZone, cadence, now);
    return "skipped";
  }

  try {
    const out = await generate(schedule, range);

    // Re-authorised HERE, not trusted from the row. A schedule is a standing instruction, so somebody
    // who has since left, been suspended, or lost the report's permission must stop receiving it on
    // this run — and a recipient who changed address gets it at the new one. Excluded people are
    // counted, never named with a reason: run history is visible to everyone who can see the
    // schedule, and one person's permission state is not another's business.
    const { emails: recipients, excluded } = await scheduleService.resolveDeliverableRecipients(schedule);
    if (recipients.length === 0) {
      throw new Error("No selected recipient is currently authorised to receive this report.");
    }

    // Anyone this run already reached on an earlier attempt is SKIPPED, not re-sent. The unique key
    // stops a period running twice; it cannot help a run that failed partway down its recipient list,
    // and re-mailing the people who already had it is the duplicate that costs trust in the report.
    // Re-read rather than trust `target`, which was fetched before the claim was taken.
    // A DISABLED template is a silent no-op, and that is fatal here.
    //
    // `sendTemplatedEmail` treats a disabled row as "skip": it logs `skipped` and returns normally,
    // which is right for a notification nobody must receive. This is not that. If it returned
    // normally here the run would be recorded delivered to every recipient while nothing was sent —
    // run history green, status badge green, overdue banner silent — and a monthly report would stop
    // arriving with no signal anywhere. Exactly the failure this scheduler exists to make impossible.
    //
    // So the state is checked ONCE per run, before anything is sent, and a disabled template fails
    // the run: the operator sees it on the row, in the banner and in the run's error.
    const template = await emailTemplateRepo.findByKey("report.scheduled");
    if (template && !template.enabled) {
      throw new Error('The "Scheduled Report" email template is disabled — enable it in Settings → Email Templates.');
    }

    const already = new Set((await scheduleRepo.findRun(schedule.id, range.from))?.deliveredTo ?? []);
    const pending = recipients.filter((to) => !already.has(to));

    // The existing email service — DB-driven template, attachment support, its own logging. No second
    // mail path is introduced.
    for (const to of pending) {
      await sendTemplatedEmail(
        "report.scheduled",
        to,
        { reportName: schedule.name, period: range.label, summary: out.summary },
        { attachments: [{ filename: out.filename, content: out.content, contentType: out.contentType }] },
      );
      // Recorded BEFORE the next send, so a throw on the next recipient cannot un-remember this one.
      await scheduleRepo.recordDelivery(target.id, token, to);
    }

    // Everyone this run actually reached, across every attempt, oldest first.
    //
    // Built from `already` rather than re-filtered from the current recipient list on purpose: if
    // somebody was taken off the schedule between attempt 1 and attempt 2, they still received the
    // report on attempt 1. The run row records what HAPPENED, not who is on the list now — and it is
    // the only place that fact exists.
    const delivered = [...already, ...pending];
    await scheduleRepo.completeRun(target.id, token, { deliveredTo: delivered, rowCount: out.rowCount }, new Date());
    audit.record({
      action: "report_schedule.executed",
      targetType: "report_schedule",
      targetId: schedule.id,
      targetLabel: `${schedule.name} — ${range.label}`,
      metadata: { reportKey: schedule.reportKey, period: range.label, recipients: recipients.length, excluded, rows: out.rowCount },
    });
    await advance(schedule, timeZone, cadence, now);
    return "delivered";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await scheduleRepo.failRun(target.id, token, message, new Date());
    audit.record({
      action: "report_schedule.failed",
      targetType: "report_schedule",
      targetId: schedule.id,
      targetLabel: `${schedule.name} — ${range.label}`,
      metadata: { reportKey: schedule.reportKey, period: range.label, error: message, attempt: target.attempts + 1 },
    });
    // NOT advanced: the schedule stays due so the next sweep retries this same period, up to
    // MAX_ATTEMPTS. Advancing on failure would skip the period entirely and nobody would notice.
    return "failed";
  }
}

/**
 * Is this period finished for good?
 *
 * The only two states from which a schedule may move on: delivered, or out of attempts. Anything else
 * is still owed a retry, and advancing past it would throw that retry away.
 */
const isSettled = (run: { status: string; attempts: number }): boolean =>
  run.status === scheduleRepo.RUN_DELIVERED || run.attempts >= scheduleRepo.MAX_ATTEMPTS;

/** Move a schedule to its next period, guarded so two workers cannot both advance it. */
async function advance(schedule: ReportSchedule, timeZone: string, cadence: ScheduleCadence, now: Date): Promise<void> {
  // The fire-time moves WHEN it next runs; it never touches which period that run reports on.
  const next = nextRunAfter(timeZone, cadence, now, {
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    hour: schedule.hour,
    minute: schedule.minute,
  });
  await scheduleRepo.advanceSchedule(schedule.id, schedule.nextRunAt, next, now);
}

/**
 * THE ENTRY POINT. Run every schedule that is due.
 *
 * Safe to call concurrently, from anywhere, as often as you like — the database decides who does what.
 * Never throws: one broken schedule must not stop the others, so failures are recorded per run and
 * tallied rather than propagated.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<SweepResult> {
  const schedules = await scheduleRepo.findDueSchedules(now, SWEEP_BATCH);
  const result: SweepResult = { due: schedules.length, delivered: 0, skipped: 0, failed: 0 };
  if (schedules.length === 0) return result;

  const companyTz = await getCompanyTimezone();
  // Sequential on purpose: a sweep is a background chore, and generating several workbooks at once
  // would spike memory on a small host for no gain in a job that runs once an hour.
  for (const schedule of schedules) {
    try {
      result[await processOne(schedule, now, companyTz)] += 1;
    } catch (e) {
      // A failure OUTSIDE processOne's own handling (a dead database, say). Counted, never thrown.
      console.error(`[report-scheduler] schedule ${schedule.id} failed outside its run:`, e);
      result.failed += 1;
    }
  }
  return result;
}

export { CLAIM_LEASE_MS, SWEEP_BATCH };
