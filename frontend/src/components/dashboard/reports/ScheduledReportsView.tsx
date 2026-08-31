"use client";

import * as React from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";

import * as reportsService from "@/services/reports.service";
import type { ReportRun, ReportSchedule, SchedulablePayloadState, SchedulableReport } from "./scheduleTypes";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { Notice } from "@/components/ui/Notice";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScheduleForm } from "./ScheduleForm";
import { cadenceLabel, draftFrom, emptyDraft, overdueSchedules, toPayload } from "./scheduleDraft";
import { formatDateTimeIn } from "@/lib/formatDate";
import { CELL_ONE_LINE, tableMinWidth } from "@/components/ui/tableLayout";
import { toolbarPrimaryBtn } from "@/components/ui/styles";

// ── Scheduled Reports ──────────────────────────────────────────────────────────────────────────
//
// Lists what is scheduled, and lets an authorised user create, edit, pause and delete. The report
// dropdown comes from `/reports/schedules/types`, which the SERVER filters by what this user may
// schedule — so a user is never offered a report the save would then refuse, and a finance schedule
// is invisible to someone without the finance right.
//
// Everything shown here is configuration and delivery state. Deliberately no report FIGURES: the list
// says a run delivered 240 rows, never what they totalled — a schedule list is not an authorised
// surface for the report's contents.

const RUN_TONE: Record<ReportRun["status"], string> = {
  delivered: "bg-emerald-500/12 text-emerald-600",
  running: "bg-sky-500/12 text-sky-600",
  pending: "bg-[var(--surface-2)] text-[var(--muted)]",
  failed: "bg-[var(--neg)]/12 text-[var(--neg)]",
};

export function ScheduledReportsView() {
  const { pushToast } = useDashboard();
  // A scheduled report is an export — the same file the download buttons produce, mailed out on a
  // cadence — so the server requires `reports.export` to create, edit or resume one. Mirrored here so
  // a view-only user sees the schedules that exist without being offered buttons that would 403.
  const { can } = useAuth();
  const canExport = can("reports.export");

  const [types, setTypes] = React.useState<SchedulableReport[] | null>(null);
  // Settings -> Company -> Timezone, fetched with the report list so the form still bootstraps in
  // ONE request. The form shows it read-only; nothing here can change it.
  const [companyTimeZone, setCompanyTimeZone] = React.useState("");
  const [schedules, setSchedules] = React.useState<ReportSchedule[] | null>(null);
  const [editing, setEditing] = React.useState<{
    id: string | null;
    draft: SchedulablePayloadState;
    /** A legacy per-schedule zone carried by an existing row. New schedules never have one. */
    override?: string | null;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirm, setConfirm] = React.useState<ReportSchedule | null>(null);
  const [runsFor, setRunsFor] = React.useState<{ schedule: ReportSchedule; runs: ReportRun[] | null } | null>(null);

  // The zone a schedule is actually interpreted in: the company setting, unless the row carries a
  // legacy override. Every timestamp on that row is rendered in it, so the schedule reads the same
  // way to a viewer in London and a viewer in Chennai.
  const zoneOf = (s: ReportSchedule) => s.timeZone ?? companyTimeZone;

  // The instant the list was fetched. Stamped here rather than read during render: a render can
  // happen at any time, and "past due" must be judged against the data's own moment, not the paint's.
  const [loadedAt, setLoadedAt] = React.useState(0);

  const refresh = React.useCallback(async () => {
    const list = await reportsService.listSchedules();
    setSchedules(list);
    setLoadedAt(Date.now());
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const [meta] = await Promise.all([reportsService.listSchedulableReports(), refresh()]);
        setTypes(meta.reports);
        setCompanyTimeZone(meta.companyTimeZone);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : "Could not load schedules.", "alert");
        setTypes([]);
        setSchedules([]);
      }
    })();
  }, [refresh, pushToast]);

  // `recipients` comes from the form, which reconciles the stored selection against who is eligible
  // now — the draft can still hold a legacy email or somebody who has since lost access.
  const save = async (recipients: string[]) => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = toPayload({ ...editing.draft, recipients });
      if (editing.id) await reportsService.updateSchedule(editing.id, payload);
      else await reportsService.createSchedule(payload);
      pushToast(editing.id ? "Schedule updated." : "Schedule created.", "success");
      setEditing(null);
      await refresh();
    } catch (e) {
      // The server owns validation; its message is the one worth showing.
      pushToast(e instanceof Error ? e.message : "Could not save the schedule.", "alert");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: ReportSchedule) => {
    try {
      await reportsService.setScheduleEnabled(s.id, !s.enabled);
      pushToast(s.enabled ? "Schedule paused." : "Schedule resumed.", "success");
      await refresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the schedule.", "alert");
    }
  };

  const remove = async () => {
    if (!confirm) return;
    try {
      await reportsService.deleteSchedule(confirm.id);
      pushToast("Schedule deleted.", "success");
      setConfirm(null);
      await refresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not delete the schedule.", "alert");
    }
  };

  const openRuns = async (schedule: ReportSchedule) => {
    setRunsFor({ schedule, runs: null });
    try {
      setRunsFor({ schedule, runs: await reportsService.listScheduleRuns(schedule.id) });
    } catch {
      setRunsFor({ schedule, runs: [] });
    }
  };

  if (!types || !schedules) return <Skeleton className="h-64 rounded-xl" />;

  // No schedulable report means no finance and no reports right — the server told us so.
  if (types.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-sm text-[var(--muted)]">
        You don&apos;t have permission to schedule any reports.
      </div>
    );
  }

  const overdue = overdueSchedules(schedules, loadedAt);
  // Schedules whose last run gave up. Distinct from `overdue`: those are not being ATTEMPTED, these
  // are being attempted and failing, and the two need different people to do different things.
  const failing = schedules.filter((s) => s.lastRunExhausted);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* The only way a user can tell the sweep is not being invoked. See overdueSchedules().
          A `warn`, not an error: nothing is broken here and the user can still work.

          The copy deliberately does NOT promise every missed period gets its own report. It used to,
          and that was wrong: `completedPeriod` and `advance` both key off NOW, so a sweep that has
          been down for three months produces ONE report — the period that had just ended when it came
          back — and the rest are simply never generated. Telling an administrator "nothing is lost"
          invites them to fix the scheduler and never look for the missing months. */}
      {overdue.length > 0 ? (
        <Notice
          size="sm"
          msg={{
            type: "warn",
            text: `${overdue.length} schedule${overdue.length === 1 ? " is" : "s are"} past due — reports are not being generated. When the scheduler is running again each one resumes from the period that has just ended; any period missed while it was down is not sent retrospectively, so ask your administrator to check it promptly.`,
          }}
        />
      ) : null}

      {/* Attempted, and failing. Without this the row below reads "Active", "Next run: <future>" and
          the report simply stops arriving — the failure was legible only inside one schedule's own
          run-history modal, which nobody opens unless they already suspect something. */}
      {failing.length > 0 ? (
        <Notice
          size="sm"
          msg={{
            type: "error",
            text: `${failing.length} schedule${failing.length === 1 ? " has" : "s have"} failed every attempt for the latest period and stopped retrying it: ${failing
              .map((s) => s.name)
              .join(", ")}. Open the schedule to see why.`,
          }}
        />
      ) : null}

      {/* The action alone. A strapline used to sit beside it explaining what a scheduled report is —
          the same thing the empty state below says, so on the screen that actually needed the
          explanation it appeared twice, and on every other screen it was a band of prose above a table
          that already answers the question in its Frequency, Next run and Last run columns. The one
          fact it carried that the empty state did not (which period a run covers) has moved down there,
          and the schedule FORM states it per-cadence while you are choosing one, which is where it
          changes a decision. `justify-end` because there is nothing on the left any more. */}
      {canExport ? (
        <div className="flex shrink-0 justify-end">
          <button onClick={() => setEditing({ id: null, draft: emptyDraft(types[0]!) })} className={toolbarPrimaryBtn}>
            <Plus className="h-3.5 w-3.5" /> Create schedule
          </button>
        </div>
      ) : null}

      {schedules.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <CalendarClock className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No scheduled reports yet</p>
          <p className="max-w-sm text-xs text-[var(--muted)]">
            Create one to have a report generated and emailed as an attachment on a weekly or monthly
            cadence. Each run covers the period that has just ended.
          </p>
        </div>
      ) : (
        // `min-h-0 flex-1` + a scrolling body, so the sticky header actually pins.
        //
        // It was a bare `overflow-x-auto` with no height: `overflow-x: auto` computes overflow-y to
        // `auto` too, so the div became a scroll container exactly as tall as its content — and a
        // `sticky top-0` thead inside a container it can never scroll within does nothing at all. The
        // whole page scrolled instead and the header went with it.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="min-h-0 flex-1 overflow-auto">
            {/* Columns declare what they are WORTH instead of one flat number for all of them. At the
                old flat 960px these eight shared ~120px each — below the 150px a `normal` column
                needs — so report names and recipient lists wrapped and every row grew. */}
            <table
              className="w-full text-left text-sm"
              style={{
                minWidth: tableMinWidth(["wide", "normal", "normal", "normal", "narrow", "wide", "normal", "narrow"]),
              }}
            >
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Report</th>
                  <th className="px-4 py-3">Frequency</th>
                  <th className="px-4 py-3">Next run</th>
                  <th className="px-4 py-3">Last run</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Recipients</th>
                  <th className="px-4 py-3">Created by</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => {
                  const type = types.find((t) => t.key === s.reportKey);
                  return (
                    <tr key={s.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]">
                      <td className="px-4 py-3">
                        <button onClick={() => void openRuns(s)} className="text-left">
                          <div className="font-semibold text-[var(--ink)] hover:text-[var(--accent)]">{s.name}</div>
                          <div className="text-[11px] text-[var(--muted)]">
                            {type?.label ?? s.reportKey} · {s.format.toUpperCase()}
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {cadenceLabel(s)}
                        {/* Always stated. "the 1st at 06:00" in no particular zone is not a schedule,
                            and a legacy override must be visibly different from the company setting. */}
                        <div className="text-[10px]">{s.timeZone ?? companyTimeZone}</div>
                      </td>
                      {/* In the SCHEDULE's zone, not the viewer's — a row that says "06:00 Europe/London"
                          and "next run 10:30" beside it is two answers to one question. */}
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {s.enabled ? formatDateTimeIn(s.nextRunAt, zoneOf(s)) : "—"}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {s.lastRunAt ? formatDateTimeIn(s.lastRunAt, zoneOf(s)) : "Never"}
                      </td>
                      <td className="px-4 py-3">
                        {/* "Failing" outranks "Active" on purpose. A schedule that is enabled and
                            burning every attempt IS active in the sense the flag means, and that is
                            exactly why the badge alone was misleading: the row said Active, Next run
                            said a future date, and the report had stopped arriving. */}
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${
                            !s.enabled
                              ? "bg-[var(--surface-2)] text-[var(--muted)]"
                              : s.lastRunExhausted
                                ? "bg-[var(--neg)]/12 text-[var(--neg)]"
                                : "bg-emerald-500/12 text-emerald-600"
                          }`}
                        >
                          {!s.enabled ? "Paused" : s.lastRunExhausted ? "Failing" : "Active"}
                        </span>
                        {s.enabled && s.lastRunExhausted ? (
                          <div className={`mt-1 max-w-[16rem] text-[10px] text-[var(--neg)] ${CELL_ONE_LINE}`} title={s.lastRunError ?? ""}>
                            {s.lastRunError ?? "Every attempt failed."}
                          </div>
                        ) : null}
                      </td>
                      {/* Labels, never the stored ids — the row identifies people, not documents. */}
                      <td className="px-4 py-3 text-[var(--muted)]" title={s.recipientLabels.join(", ")}>
                        {s.recipientLabels.length === 1
                          ? s.recipientLabels[0]
                          : `${s.recipientLabels.length} recipients`}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-[var(--muted)]">{s.createdBy ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {/* Pausing needs no export right (stopping an export is always allowed);
                              resuming restarts one, so it does. Matches setEnabled() server-side. */}
                          {s.enabled || canExport ? (
                          <button
                            onClick={() => void toggle(s)}
                            title={s.enabled ? "Pause" : "Resume"}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                          >
                            {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                          </button>
                          ) : null}
                          {canExport ? (
                          <button
                            onClick={() => setEditing({ id: s.id, draft: draftFrom(s), override: s.timeZone })}
                            title="Edit"
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          ) : null}
                          {/* Delete needs `reports.export`, like create and edit — the server gates it
                              now, so offering the button to a view-only user would only 403. Pause
                              above stays open to everyone: it is the off switch, and it is reversible. */}
                          {canExport ? (
                          <button
                            onClick={() => setConfirm(s)}
                            title="Delete"
                            className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* `scrollBody`: eleven controls do not fit a short viewport, and without it the panel simply
          grew past the screen — the title scrolled off the top and Save sat below the fold. Caps the
          panel to the viewport, pins the title, and scrolls the body. The form pins its own action bar
          at the bottom of that scroll region. */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        scrollBody
        title={editing?.id ? "Edit schedule" : "Create schedule"}
      >
        {editing ? (
          <ScheduleForm
            types={types}
            companyTimeZone={companyTimeZone}
            override={editing.override}
            draft={editing.draft}
            onChange={(draft) => setEditing({ ...editing, draft })}
            onCancel={() => setEditing(null)}
            onSave={(recipients) => void save(recipients)}
            saving={saving}
          />
        ) : null}
      </Modal>

      {/* Run history — delivery state only. Never a figure from the report it produced. */}
      <Modal scrollBody open={Boolean(runsFor)} onClose={() => setRunsFor(null)} title={`Run history — ${runsFor?.schedule.name ?? ""}`}>
        {runsFor ? (
          <p className="mb-3 text-[11px] text-[var(--muted)]">
            Times shown in <span className="font-semibold text-[var(--ink)]">{zoneOf(runsFor.schedule)}</span>, the zone
            this schedule runs in.
          </p>
        ) : null}
        {!runsFor?.runs ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : runsFor.runs.length === 0 ? (
          <p className="py-10 text-center text-sm text-[var(--muted)]">This schedule hasn&apos;t run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="py-2 pr-3">Period</th>
                  <th className="py-2 pr-3">Started</th>
                  <th className="py-2 pr-3">Completed</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempt</th>
                  <th className="py-2">Delivered to</th>
                </tr>
              </thead>
              <tbody>
                {runsFor.runs.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--border)] last:border-0 align-top">
                    <td className="py-2 pr-3 font-semibold text-[var(--ink)]">{r.periodLabel}</td>
                    <td className="py-2 pr-3 text-[var(--muted)]">
                      {r.startedAt ? formatDateTimeIn(r.startedAt, zoneOf(runsFor.schedule)) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-[var(--muted)]">
                      {r.completedAt ? formatDateTimeIn(r.completedAt, zoneOf(runsFor.schedule)) : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase ${RUN_TONE[r.status]}`}>
                        {r.status}
                      </span>
                      {/* The operator needs to know WHY it failed; the reason is a system message, not
                          report content. */}
                      {r.error ? <div className="mt-1 max-w-xs text-[10px] text-[var(--neg)]">{r.error}</div> : null}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-[var(--muted)]">{r.attempts}</td>
                    <td className="py-2 text-[11px] text-[var(--muted)]">
                      {r.deliveredTo.length > 0 ? r.deliveredTo.join(", ") : "—"}
                      {r.rowCount != null ? <div className="text-[10px]">{r.rowCount} row(s)</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Delete schedule"
        confirmLabel="Delete"
        onClose={() => setConfirm(null)}
        onConfirm={() => void remove()}
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{confirm?.name}</strong>? It will stop generating reports. Its
            run history is removed with it.
          </>
        }
      />
    </div>
  );
}
