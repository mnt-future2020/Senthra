import * as scheduleRepo from "./reportSchedule.repository.js";
import type { ReportRun, ReportSchedule } from "./reportSchedule.repository.js";
import { CUSTOM_REPORT_FILTERS, findReport, type CustomReportFilter } from "./customReports.registry.js";
import { LAST_DAY_OF_MONTH, nextRunAfter, SCHEDULE_CADENCES, type ScheduleCadence } from "./reports.period.js";
import { SCHEDULE_FORMATS } from "./reports.constants.js";
import { isWarehouseScopedUser } from "../../lib/warehouse-access.js";

export { SCHEDULE_FORMATS } from "./reports.constants.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import { badRequest, forbidden, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

// ── Schedule management — the authorisation and validation layer ──────────────────────────────
//
// The scheduler CORE is untouched by anything here: this file decides what may be SAVED, the core
// decides what happens when it fires. Keeping them apart is what lets a schedule be edited while a
// run of it is in flight.
//
// Three rules do the real work:
//
//   1. A schedule may only name a report the SAVING USER can run right now. Finance schedules need
//      `reports.finance.view`; everything else needs `reports.view`. Checked on create AND on update,
//      because a schedule is a standing instruction that outlives the session that made it — and the
//      core runs it unattended, with no actor to check later.
//   2. The saving user must additionally hold `reports.export`, because a scheduled report IS an
//      export — the same builders, the same bytes, mailed out unattended. See requireExport().
//   3. Filters are validated against the SAME registry Custom Reports uses. A schedule stores a report
//      KEY plus a validated filter set, never a query — there is no field in which a database
//      expression could be persisted and later executed.

/** The only report key that is not in the Custom Report registry — Finance has its own canonical layer. */
export const FINANCE_REPORT_KEY = "finance.summary";

/** A schedulable report, as offered to the schedule form. */
export interface SchedulableReport {
  key: string;
  label: string;
  description: string;
  filters: readonly string[];
  /** True when scheduling it requires the finance permission. */
  financial: boolean;
}

const FINANCE_REPORT: SchedulableReport = {
  key: FINANCE_REPORT_KEY,
  label: "Finance Summary",
  description: "Spend, VAT, supplier / project / item breakdowns and PO tracking for the period.",
  // The Finance report is period-driven; the period comes from the cadence, so it takes no filters of
  // its own here. Supplier narrowing exists on the screen and is deliberately not a schedule option
  // yet — nobody has asked for a per-supplier scheduled report.
  filters: [],
  financial: true,
};

const holds = (actor: AuditActor | undefined, permission: string): boolean =>
  (actor?.permissions ?? []).some((p) => p === "*" || p === permission);

const canFinance = (actor?: AuditActor): boolean => holds(actor, "reports.finance.view");
const canReports = (actor?: AuditActor): boolean => holds(actor, "reports.view");

/**
 * May this actor take a report OUT of the system as a file?
 *
 * The same `reports.export` that gates every manual download, and it is deliberately NOT
 * report-specific: one flat right covers CSV and XLSX, finance and operational alike.
 */
const canExport = (actor?: AuditActor): boolean => holds(actor, "reports.export");

/**
 * Refuse an actor who may read a report on screen but may not take the file away.
 *
 * A scheduled report is an EXPORT. It runs the same builders the download routes run
 * (buildFinanceWorkbook / financeSummaryCsv / customReports*), produces the same bytes, and mails
 * them to up to 20 inboxes on a repeating cadence with nobody watching — a standing, unattended
 * download. Letting a view-only actor configure one would make `reports.export` a UI preference:
 * denied the button, granted the same file by asking the scheduler for it every Monday.
 *
 * So the answer is the SAME pair the download routes already ask for — the report's own view right
 * (finance or general, resolved by requireSchedulable) PLUS `reports.export` — and NOT a fourth
 * `reports.schedule` permission, which would be a second answer to a question the catalogue has
 * already answered.
 *
 * Only the acts that CREATE or RESUME an extraction are gated. Reading the schedule list, opening a
 * schedule, reading run history, pausing and deleting extract nothing; blocking the off switch would
 * be a boundary that fails in the unsafe direction.
 */
function requireExport(actor?: AuditActor): void {
  if (!canExport(actor)) {
    throw forbidden("You need permission to export reports before you can schedule one.");
  }
}

/**
 * What this actor may schedule.
 *
 * The single source the form's dropdown is built from, so a user is never offered a report the save
 * would then refuse. A customer principal gets nothing: scheduling is an internal, staff-only
 * capability, and a customer has no staff permission at all.
 */
export function schedulableReports(actor?: AuditActor): SchedulableReport[] {
  if (actor?.type === "customer") return [];
  const out: SchedulableReport[] = [];
  if (canFinance(actor)) out.push(FINANCE_REPORT);
  if (canReports(actor)) {
    // A warehouse-scoped actor may not SCHEDULE a report they may not RUN. This module's own rule —
    // "a scheduled report IS the report; emailing it to somebody who could not open it would be an
    // authorization bypass wearing a delivery mechanism" — applies to the person setting it up too.
    // Without this, `engineer_stock` (no warehouse dimension, see the registry) stayed reachable by
    // the slower route: refused on screen, delivered by email every week.
    const scoped = isWarehouseScopedUser(actor);
    for (const r of [findReport("stock_movement"), findReport("project_activity"), findReport("engineer_stock")]) {
      if (r && scoped && !r.warehouseScopable) continue;
      // A financial custom report would additionally need the finance right — none exists today, but
      // the check is here so adding one cannot bypass the gate.
      if (r && (!r.financial || canFinance(actor))) {
        out.push({ key: r.key, label: r.label, description: r.description, filters: r.filters, financial: r.financial });
      }
    }
  }
  return out;
}

/**
 * The permission a RECIPIENT must hold to be sent this report.
 *
 * The same right that opens the report on screen. A scheduled report IS the report — emailing it to
 * somebody who could not open it would be an authorization bypass wearing a delivery mechanism.
 */
const recipientPermissionsFor = (def: SchedulableReport): string[] => [
  def.financial ? "reports.finance.view" : "reports.view",
  // `reports.export` as well, because a recipient RECEIVES THE FILE.
  //
  // Creating a schedule already requires it, on this module's own reasoning that "scheduling is
  // running a report PLUS taking the file away". A recipient does the second half without doing the
  // first, so asking less of them than of the person who set it up inverted the split: someone
  // deliberately denied the export right — download buttons hidden, routes answering 403 — was
  // emailed the same workbook every month.
  "reports.export",
];

/**
 * Who may be put on a schedule's recipient list.
 *
 * Server-derived, and the picker's ONLY source. Recipients are chosen from real, active, authorised
 * users rather than typed as free text, so a Finance report cannot be routed to somebody who merely
 * knows an address. The caller must itself be allowed to schedule the report before it learns who
 * could receive it.
 *
 * `reports.export` is required here too. The picker exists only to fill in a form this actor could
 * not save, so gating it costs nothing and stops a view-only user enumerating who holds the finance
 * right — a directory read with no legitimate use behind it.
 */
export async function listRecipientOptions(
  actor: AuditActor | undefined,
  reportKey: string,
): Promise<scheduleRepo.RecipientCandidate[]> {
  const def = requireSchedulable(actor, reportKey);
  requireExport(actor);
  return scheduleRepo.findEligibleRecipients(recipientPermissionsFor(def));
}

/**
 * The report a key names, WITHOUT an actor check.
 *
 * For the unattended scheduler, which has no session to authorise. It resolves the report only to
 * learn which permission its recipients need — the authorisation that matters at send time is each
 * RECIPIENT's, not a caller's.
 */
function findSchedulableReport(reportKey: string): SchedulableReport | undefined {
  if (reportKey === FINANCE_REPORT_KEY) return FINANCE_REPORT;
  const r = findReport(reportKey);
  return r ? { key: r.key, label: r.label, description: r.description, filters: r.filters, financial: r.financial } : undefined;
}

/** Resolve a report key for this actor, or refuse. THE authorization gate for scheduling. */
function requireSchedulable(actor: AuditActor | undefined, reportKey: string): SchedulableReport {
  const found = schedulableReports(actor).find((r) => r.key === reportKey);
  if (!found) {
    // Deliberately the same message whether the report does not exist or the actor may not have it:
    // a distinct "that exists but you can't schedule it" tells an unauthorised user what exists.
    throw forbidden("You can't schedule that report.");
  }
  return found;
}

export interface ScheduleInput {
  name: string;
  reportKey: string;
  cadence: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  hour?: number | null;
  minute?: number | null;
  timeZone?: string | null;
  format?: string;
  recipients: string[];
  filters?: Record<string, string> | null;
  enabled?: boolean;
}

/** A single, server-authoritative validation. The frontend's copy is convenience, never the rule. */
async function validate(
  actor: AuditActor | undefined,
  input: ScheduleInput,
): Promise<{
  def: SchedulableReport;
  cadence: ScheduleCadence;
  filters: Record<string, string>;
  recipients: string[];
}> {
  const def = requireSchedulable(actor, input.reportKey);
  // Both write paths land here, so the export right is asked for exactly once — a create and an edit
  // are the same act (defining a recurring extraction) and must not drift apart.
  requireExport(actor);

  const name = input.name?.trim();
  if (!name) throw badRequest("Give the schedule a name.");
  if (name.length > 120) throw badRequest("Keep the name under 120 characters.");

  const cadence = input.cadence as ScheduleCadence;
  if (!(SCHEDULE_CADENCES as readonly string[]).includes(cadence)) {
    throw badRequest("Frequency must be weekly or monthly.");
  }
  if (input.format && !(SCHEDULE_FORMATS as readonly string[]).includes(input.format)) {
    throw badRequest("Format must be xlsx or csv.");
  }

  if (cadence === "weekly" && input.dayOfWeek != null && (input.dayOfWeek < 1 || input.dayOfWeek > 7)) {
    throw badRequest("Day of week must be between 1 (Monday) and 7 (Sunday).");
  }
  // 1-31, or LAST_DAY_OF_MONTH for month-end. A day that does not exist in a given month runs on that
  // month's last day (dayIndexIn in reports.period.ts owns the rule) — so the 29th, 30th and 31st are
  // all selectable and none of them silently skips February.
  if (
    cadence === "monthly" &&
    input.dayOfMonth != null &&
    input.dayOfMonth !== LAST_DAY_OF_MONTH &&
    (input.dayOfMonth < 1 || input.dayOfMonth > 31)
  ) {
    throw badRequest("Day of month must be between 1 and 31, or the last day of the month.");
  }
  if (input.hour != null && (input.hour < 0 || input.hour > 23)) throw badRequest("Hour must be between 0 and 23.");
  if (input.minute != null && (input.minute < 0 || input.minute > 59)) throw badRequest("Minute must be between 0 and 59.");

  // NOTE: `input.timeZone` is deliberately NOT read. Settings -> Company -> Timezone is the single
  // source of truth for scheduling; see resolveTimeZone().

  // Recipients are stored as USER IDS and RE-DERIVED here, never trusted. A crafted request naming a
  // suspended user, a soft-deleted one, or somebody without the report's own permission is rejected:
  // the client's selection is a suggestion, and this is the check.
  //
  // A legacy EMAIL is accepted and normalised to the user's id, so a schedule saved before this
  // became id-based stays editable without a migration.
  const requested = [...new Set((input.recipients ?? []).map((r) => String(r).trim()).filter(Boolean))];
  if (requested.length === 0) throw badRequest("Add at least one recipient.");
  if (requested.length > 20) throw badRequest("A schedule can have at most 20 recipients.");

  const candidates = await scheduleRepo.findEligibleRecipients(recipientPermissionsFor(def));
  const byId = new Map(candidates.map((u) => [u.id, u]));
  const byEmail = new Map(candidates.map((u) => [u.email.toLowerCase(), u]));

  const recipients: string[] = [];
  for (const entry of requested) {
    const user = byId.get(entry) ?? byEmail.get(entry.toLowerCase());
    // ONE message for "no such user", "not active" and "not authorised" alike: telling an
    // unauthorised caller which of the three it was would map the user directory and the permissions.
    if (!user) throw badRequest(`That recipient isn't an active user authorised to receive "${def.label}".`);
    if (!recipients.includes(user.id)) recipients.push(user.id);
  }

  // Filters are checked against the report's OWN declared set, the same way the Custom Report runner
  // checks them — a filter the report cannot honour is rejected, never silently dropped.
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.filters ?? {})) {
    if (v == null || v === "") continue;
    if (!CUSTOM_REPORT_FILTERS.includes(k as CustomReportFilter)) throw badRequest(`Unknown filter "${k}".`);
    if (!def.filters.includes(k)) throw badRequest(`"${def.label}" can't be filtered by ${k}.`);
    // The reporting period comes from the cadence. Storing a fixed date range would make every run
    // report the same period forever.
    if (k === "dateFrom" || k === "dateTo") continue;
    filters[k] = String(v);
  }

  return { def, cadence, filters, recipients };
}

/**
 * The zone a schedule's day and time are interpreted in.
 *
 * Settings -> Company -> Timezone, resolved at save time and again at every run — never the browser's
 * zone, never the server's, and never a second copy stored per schedule. Changing the company setting
 * therefore moves every schedule that follows it, which is the point of having one setting.
 *
 * `schedule.timeZone` survives only as a per-schedule OVERRIDE for rows created before this became a
 * company-level decision. Nothing writes it any more, and the form cannot produce one; it is still
 * READ so an existing schedule does not silently start firing at a different local time.
 */
async function resolveTimeZone(existing?: { timeZone: string | null }): Promise<string> {
  return existing?.timeZone || (await getCompanyTimezone());
}

export async function createSchedule(actor: AuditActor | undefined, input: ScheduleInput): Promise<ReportSchedule> {
  const { cadence, filters, recipients } = await validate(actor, input);
  // A new schedule NEVER stores a zone of its own — it follows the company setting for life.
  const zone = await resolveTimeZone();
  const fire = { dayOfWeek: input.dayOfWeek, dayOfMonth: input.dayOfMonth, hour: input.hour, minute: input.minute };

  const created = await scheduleRepo.createSchedule({
    name: input.name.trim(),
    reportKey: input.reportKey,
    cadence,
    dayOfWeek: cadence === "weekly" ? (input.dayOfWeek ?? 1) : null,
    dayOfMonth: cadence === "monthly" ? (input.dayOfMonth ?? 1) : null,
    hour: input.hour ?? 6,
    minute: input.minute ?? 0,
    timeZone: null,
    format: input.format ?? "xlsx",
    recipients,
    filters,
    enabled: input.enabled ?? true,
    // Computed from NOW, so a new schedule fires at its next occurrence and never immediately for a
    // period it was not configured to cover.
    nextRunAt: nextRunAfter(zone, cadence, new Date(), fire),
    createdBy: actor?.email ?? null,
    updatedBy: actor?.email ?? null,
  });

  audit.record({
    actor,
    action: "report_schedule.created",
    targetType: "report_schedule",
    targetId: created.id,
    targetLabel: created.name,
    metadata: { reportKey: created.reportKey, cadence, recipients: created.recipients.length, format: created.format },
  });
  return created;
}

export async function updateSchedule(
  actor: AuditActor | undefined,
  id: string,
  input: ScheduleInput,
): Promise<ReportSchedule> {
  const existing = await scheduleRepo.findScheduleById(id);
  if (!existing) throw notFound("Schedule not found.");
  // Re-checked on EVERY edit, against the report being saved AND the one already stored: a user who
  // cannot schedule finance must not be able to edit a finance schedule at all, not even its name.
  requireSchedulable(actor, existing.reportKey);
  const { cadence, filters, recipients } = await validate(actor, input);

  // The stored override is CARRIED, never re-read from the request: editing an old schedule's name
  // must not silently move the hour it fires at, and no edit can introduce a new override.
  const zone = await resolveTimeZone(existing);
  const fire = { dayOfWeek: input.dayOfWeek, dayOfMonth: input.dayOfMonth, hour: input.hour, minute: input.minute };

  /**
   * Did this edit change WHEN the schedule fires?
   *
   * Only a timing change may move `nextRunAt`. Recomputing it on every edit looks harmless and is
   * not: a schedule whose latest period FAILED keeps `nextRunAt` in the past on purpose, so the next
   * sweep retries that period. Recomputing from `new Date()` pushes it into the future and the
   * pending retry is silently dropped — so fixing the recipient list after a failure, which is the
   * single most likely reason anyone edits a failing schedule, is exactly what throws that period's
   * report away.
   */
  const timingChanged =
    cadence !== existing.cadence ||
    (cadence === "weekly" ? (input.dayOfWeek ?? 1) !== existing.dayOfWeek : (input.dayOfMonth ?? 1) !== existing.dayOfMonth) ||
    (input.hour ?? 6) !== existing.hour ||
    (input.minute ?? 0) !== existing.minute;

  const updated = await scheduleRepo.updateSchedule(id, {
    name: input.name.trim(),
    reportKey: input.reportKey,
    cadence,
    dayOfWeek: cadence === "weekly" ? (input.dayOfWeek ?? 1) : null,
    dayOfMonth: cadence === "monthly" ? (input.dayOfMonth ?? 1) : null,
    hour: input.hour ?? 6,
    minute: input.minute ?? 0,
    timeZone: existing.timeZone,
    format: input.format ?? "xlsx",
    recipients,
    filters,
    enabled: input.enabled ?? existing.enabled,
    // Recomputed ONLY when the timing changed — otherwise the edit appears to have been ignored
    // until the following period. Left alone for every other edit (name, recipients, filters,
    // format), which is what preserves a due-or-retrying period. See `timingChanged`.
    nextRunAt: timingChanged ? nextRunAfter(zone, cadence, new Date(), fire) : existing.nextRunAt,
    updatedBy: actor?.email ?? null,
  });

  audit.record({
    actor,
    action: "report_schedule.updated",
    targetType: "report_schedule",
    targetId: id,
    targetLabel: updated.name,
    metadata: { reportKey: updated.reportKey, cadence, recipients: updated.recipients.length },
  });
  return updated;
}

/** What a schedule's stored selection resolves to RIGHT NOW. */
export interface DeliverableRecipients {
  /** Current addresses of the selected users who are still authorised. */
  emails: string[];
  /** How many selected recipients no longer qualify. A COUNT, deliberately not who or why. */
  excluded: number;
}

/**
 * Resolve a schedule's recipients at SEND time.
 *
 * Authorisation at save time is not enough: a schedule is a standing instruction, and the people on it
 * change afterwards. Somebody who leaves, is suspended, or has the Finance right taken away must stop
 * receiving the Finance report on the next run — not when somebody remembers to edit the schedule.
 *
 * Everything is read fresh from the eligible set, so the CURRENT email is used: a recipient who
 * changed address keeps receiving it, at the new one, without touching the schedule.
 *
 * Legacy rows stored emails rather than ids; both are matched, so nothing needs migrating.
 *
 * The excluded count is a count on purpose. Run history is visible to everyone who can see the
 * schedule, and "Ravi was dropped because he lost reports.finance.view" would leak one person's
 * permission state to another.
 */
export async function resolveDeliverableRecipients(schedule: {
  reportKey: string;
  recipients: string[];
}): Promise<DeliverableRecipients> {
  const def = findSchedulableReport(schedule.reportKey);
  // A report that no longer exists has no permission to check against, so nobody is deliverable. The
  // scheduler reports this as a failed run rather than sending to an unchecked list.
  if (!def) return { emails: [], excluded: schedule.recipients.length };

  const candidates = await scheduleRepo.findEligibleRecipients(recipientPermissionsFor(def));
  const byId = new Map(candidates.map((u) => [u.id, u]));
  const byEmail = new Map(candidates.map((u) => [u.email.toLowerCase(), u]));

  const emails: string[] = [];
  let excluded = 0;
  for (const entry of schedule.recipients) {
    const user = byId.get(entry) ?? byEmail.get(String(entry).toLowerCase());
    if (!user) {
      excluded += 1;
      continue;
    }
    if (!emails.includes(user.email)) emails.push(user.email);
  }
  return { emails, excluded };
}

/**
 * Enable/disable — its own action because it is the operator's fastest lever when one misbehaves.
 *
 * Deliberately ASYMMETRIC on `reports.export`. Resuming a paused schedule restarts a recurring
 * extraction, so it asks for the same right that creating one does; PAUSING stops files leaving and
 * is left open to anyone who can see the schedule. A gate on the off switch would fail in the unsafe
 * direction — the one moment you least want an authorization check is when a schedule is misfiring.
 */
export async function setEnabled(actor: AuditActor | undefined, id: string, enabled: boolean): Promise<ReportSchedule> {
  const existing = await scheduleRepo.findScheduleById(id);
  if (!existing) throw notFound("Schedule not found.");
  requireSchedulable(actor, existing.reportKey);
  if (enabled) requireExport(actor);

  const updated = await scheduleRepo.updateSchedule(id, { enabled, updatedBy: actor?.email ?? null });
  audit.record({
    actor,
    action: enabled ? "report_schedule.enabled" : "report_schedule.disabled",
    targetType: "report_schedule",
    targetId: id,
    targetLabel: updated.name,
  });
  return updated;
}

export async function deleteSchedule(actor: AuditActor | undefined, id: string): Promise<void> {
  const existing = await scheduleRepo.findScheduleById(id);
  if (!existing) throw notFound("Schedule not found.");
  requireSchedulable(actor, existing.reportKey);
  // `reports.export` — the same right creating one needs, unlike PAUSE.
  //
  // Pause is left open on purpose: it stops files leaving, and the moment you least want an
  // authorization check is when a schedule is misfiring. Delete is not that. It destroys
  // configuration the holder could not have created and takes the run history with it, so a view-only
  // user was able to remove a schedule they had no right to build.
  requireExport(actor);
  await scheduleRepo.deleteSchedule(id);
  audit.record({
    actor,
    action: "report_schedule.deleted",
    targetType: "report_schedule",
    targetId: id,
    targetLabel: existing.name,
    metadata: { reportKey: existing.reportKey },
  });
}

/**
 * Schedules this actor may manage.
 *
 * Filtered by the SAME rule that governs creating one, so a user without the finance right never sees
 * a finance schedule's configuration — its recipients, its filters or even that it exists.
 */
/**
 * A schedule as the LIST screen needs it.
 *
 * `recipients` stays exactly what is stored — user ids, which the edit form selects against.
 * `recipientLabels` is the same list made readable, in the same order, because a column showing raw
 * ObjectIds is not a recipient list. Both are needed: one identifies, the other communicates.
 */
export type ReportScheduleView = ReportSchedule & {
  recipientLabels: string[];
  /**
   * The last run's outcome, so the LIST can say a schedule is failing.
   *
   * `null` where a schedule has never run. Deliberately the STATUS and the operator's error string
   * only — never a figure from the report it produced, which is the same rule the run-history modal
   * follows.
   */
  lastRunStatus: string | null;
  lastRunError: string | null;
  /**
   * True when the most recent run has burnt every attempt. THE signal the list was missing: at that
   * point the scheduler gives up on the period and moves on, so the row goes back to showing a future
   * "Next run" and an Active badge while the report is, in fact, no longer arriving.
   */
  lastRunExhausted: boolean;
};

/** Missing means the user was deleted outright. Named rather than blank so the row still reads. */
const UNKNOWN_RECIPIENT = "Unknown user";

export async function listSchedules(actor?: AuditActor): Promise<ReportScheduleView[]> {
  const allowed = new Set(schedulableReports(actor).map((r) => r.key));
  const schedules = (await scheduleRepo.listSchedules()).filter((s) => allowed.has(s.reportKey));
  if (schedules.length === 0) return [];

  // ONE lookup for every schedule on the page rather than one per row — the same for both.
  const [profiles, latest] = await Promise.all([
    scheduleRepo.findRecipientProfiles(schedules.flatMap((s) => s.recipients)),
    scheduleRepo.findLatestRuns(schedules.map((s) => s.id)),
  ]);
  const byKey = new Map<string, string>();
  for (const u of profiles) {
    byKey.set(u.id, u.email);
    byKey.set(u.email.toLowerCase(), u.email);
  }
  return schedules.map((s) => {
    const run = latest.get(s.id) ?? null;
    return {
      ...s,
      recipientLabels: s.recipients.map((r) => byKey.get(r) ?? byKey.get(r.toLowerCase()) ?? UNKNOWN_RECIPIENT),
      lastRunStatus: run?.status ?? null,
      lastRunError: run?.error ?? null,
      lastRunExhausted: Boolean(run && run.status !== scheduleRepo.RUN_DELIVERED && run.attempts >= scheduleRepo.MAX_ATTEMPTS),
    };
  });
}

export async function getSchedule(actor: AuditActor | undefined, id: string): Promise<ReportSchedule> {
  const s = await scheduleRepo.findScheduleById(id);
  if (!s) throw notFound("Schedule not found.");
  requireSchedulable(actor, s.reportKey);
  return s;
}

/**
 * Recent runs of one schedule.
 *
 * Gated by the same rule as the schedule itself, so run history for a finance schedule is unreachable
 * without the finance right. The rows carry status, timing and attempt counts — never a figure from
 * the report they produced.
 */
/**
 * What a run looks like to a human: which period, when it ran, whether it landed, and why not.
 *
 * Explicitly NOT the whole row. `claimToken` / `claimExpiresAt` are the scheduler's internal lease —
 * the proof of ownership a worker holds while it is sending — and they have no business crossing an
 * HTTP boundary. Listing the fields rather than deleting two is what keeps a column added to the
 * model later from silently appearing in the API.
 */
export interface ReportRunView {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
  status: string;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  deliveredTo: string[];
  error: string | null;
  rowCount: number | null;
}

const toRunView = (r: ReportRun): ReportRunView => ({
  id: r.id,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  periodLabel: r.periodLabel,
  status: r.status,
  attempts: r.attempts,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  deliveredTo: r.deliveredTo,
  error: r.error,
  rowCount: r.rowCount,
});

export async function listRuns(actor: AuditActor | undefined, id: string): Promise<ReportRunView[]> {
  // Same gate as the schedule itself: a user who may not see the schedule may not see its history.
  await getSchedule(actor, id);
  return (await scheduleRepo.listRuns(id)).map(toRunView);
}
