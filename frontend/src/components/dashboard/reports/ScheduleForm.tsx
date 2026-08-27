"use client";

import * as React from "react";

import { Select } from "@/components/ui/Select";
import { MultiSelect } from "@/components/ui/MultiSelect";
import * as reportsService from "@/services/reports.service";
import type { SchedulablePayloadState, SchedulableReport, ScheduleRecipient } from "./scheduleTypes";
import { coverageNote, DAY_NAMES, LAST_DAY_OF_MONTH, MAX_DAY_OF_MONTH } from "./scheduleDraft";
import { useProjectOptions, useReportFilterOptions } from "./reportFilterOptions";

// The schedule form. Deliberately a plain modal form rather than a wizard: there are eight fields and
// a modal form is the existing dashboard convention.
//
// Every rule here is a CONVENIENCE copy of the server's. The server validates report access, cadence,
// day, time, timezone, format, recipients and filters, and its message is what the user sees on
// failure — this only saves a round trip on the obvious cases.

const FILTER_LABEL: Record<string, string> = {
  customerId: "Customer",
  projectId: "Project",
  warehouseId: "Warehouse",
  irmItemId: "Item",
  engineerId: "Engineer",
  itemKind: "Stock type",
};

// "Last day" first, because month-end is what a finance report usually wants and burying it at the
// bottom of 31 numbers hides the option most people are looking for.
const MONTH_DAY_OPTIONS = [
  { value: String(LAST_DAY_OF_MONTH), label: "Last day of month" },
  ...Array.from({ length: MAX_DAY_OF_MONTH }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
];

const DAY_OPTIONS = DAY_NAMES.map((d, i) => ({
  value: String(i + 1),
  label: d,
}));

const STOCK_TYPE_OPTIONS = [
  { value: "", label: "All stock" },
  { value: "irm", label: "Company (IRM)" },
  { value: "customer", label: "Customer stock" },
];

const labelCls = "mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]";
const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]";

export function ScheduleForm({
  types,
  companyTimeZone,
  override,
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  types: SchedulableReport[];
  companyTimeZone: string;
  /** A legacy per-schedule timezone, if this schedule has one. Nothing can create a new one. */
  override?: string | null;
  draft: SchedulablePayloadState;
  onChange: (d: SchedulablePayloadState) => void;
  onCancel: () => void;
  /** Receives the RECONCILED recipient ids — see `selected` below. */
  onSave: (recipients: string[]) => void;
  saving: boolean;
}) {
  const active = types.find((t) => t.key === draft.reportKey);

  // Who may receive THIS report, asked of the server each time the report changes. The same set the
  // save re-derives, so the picker can never offer somebody the save would then refuse.
  //
  // Keyed by the report it was fetched for, and "loading" is DERIVED from that key rather than held
  // in its own flag: it makes showing the previous report's users impossible, and keeps the effect
  // free of a synchronous setState.
  const [loaded, setLoaded] = React.useState<{ key: string; people: ScheduleRecipient[] } | null>(null);
  const loadingRecipients = loaded?.key !== draft.reportKey;
  const people = React.useMemo(() => (loadingRecipients ? [] : loaded.people), [loadingRecipients, loaded]);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      let found: ScheduleRecipient[] = [];
      try {
        found = await reportsService.listScheduleRecipients(draft.reportKey);
      } catch {
        // An empty list reads as "nobody is authorised", which the control says out loud. The save
        // still refuses anything unauthorised, so a failed lookup cannot become a security hole.
      }
      if (!live) return;
      setLoaded({ key: draft.reportKey, people: found });
    })();
    return () => {
      live = false;
    };
  }, [draft.reportKey]);

  // A recipient is a USER, so the option's value is the user id — the schedule records who was chosen,
  // and every run resolves that person's CURRENT email, status and permission.
  const recipientOptions = React.useMemo(
    () => people.map((p) => ({ value: p.id, label: `${p.name} — ${p.email}` })),
    [people],
  );

  // Reconcile what is stored against who is eligible NOW, as a pure derivation rather than an effect.
  // Two things get fixed here: a schedule saved before recipients became id-based stores EMAILS, and
  // a person who has since left or lost the permission is no longer selectable. Dropping them is the
  // honest outcome — the server would refuse them anyway — so the form says so rather than silently
  // saving a shorter list.
  const selected = React.useMemo(() => {
    const idByEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.id]));
    const ids = new Set(people.map((p) => p.id));
    return draft.recipients.map((r) => idByEmail.get(r.toLowerCase()) ?? r).filter((r) => ids.has(r));
  }, [draft.recipients, people]);
  const dropped = loadingRecipients ? 0 : draft.recipients.length - selected.length;

  // A schedule's period comes from its cadence, so a fixed date range is never offered — storing one
  // would pin every future run to the same period forever.
  const filters = (active?.filters ?? []).filter((f) => f !== "dateFrom" && f !== "dateTo");
  const set = (patch: Partial<SchedulablePayloadState>) => onChange({ ...draft, ...patch });

  // The SAME lists the Custom Reports screen builds its pickers from. A schedule's filters are that
  // screen's filters, saved — so they have to be chosen the same way and from the same source.
  const lists = useReportFilterOptions();
  const projects = useProjectOptions(draft.filters.customerId || undefined);

  const optionsFor = (f: string) =>
    f === "customerId" ? lists.customers
    : f === "warehouseId" ? lists.warehouses
    : f === "irmItemId" ? lists.items
    : f === "engineerId" ? lists.engineers
    : f === "projectId" ? projects
    : [];

  /** What the empty option says — including the one case where the control cannot be used yet. */
  const placeholderFor = (f: string, hasCustomer: boolean) =>
    f === "customerId" ? "Any customer"
    : f === "warehouseId" ? "Any warehouse"
    : f === "irmItemId" ? "Any item"
    : f === "engineerId" ? "Any engineer"
    : f === "projectId" ? (hasCustomer ? "Any project" : "Pick a customer first")
    : "Any";

  return (
    <div className="space-y-3">
      <label className="block">
        <span className={labelCls}>Name</span>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Monthly IRM report"
          className={inputCls}
        />
      </label>

      <label className="block">
        <span className={labelCls}>Report</span>
        <Select
          size="sm"
          value={draft.reportKey}
          // Switching report clears the filters the new one cannot honour AND the recipients, whose
          // eligibility is decided by the new report's own permission.
          onChange={(v) => set({ reportKey: v, filters: {}, recipients: [] })}
          options={types.map((t) => ({ value: t.key, label: t.label }))}
          ariaLabel="Report"
        />
        {active ? <span className="mt-1 block text-[11px] text-[var(--muted)]">{active.description}</span> : null}
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Frequency</span>
          <Select
            size="sm"
            value={draft.cadence}
            onChange={(v) => set({ cadence: v as "weekly" | "monthly" })}
            options={[
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ]}
            ariaLabel="Frequency"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Day</span>
          {draft.cadence === "weekly" ? (
            <Select
              size="sm"
              value={draft.dayOfWeek}
              onChange={(v) => set({ dayOfWeek: v })}
              options={DAY_OPTIONS}
              ariaLabel="Day of week"
            />
          ) : (
            <Select
              size="sm"
              value={draft.dayOfMonth}
              onChange={(v) => set({ dayOfMonth: v })}
              options={MONTH_DAY_OPTIONS}
              ariaLabel="Day of month"
            />
          )}
          {draft.cadence === "monthly" && Number(draft.dayOfMonth) > 28 ? (
            <span className="mt-1 block text-[11px] text-[var(--muted)]">
              Runs on the last day of any month that is shorter.
            </span>
          ) : null}
        </label>
      </div>

      {/* WHICH PERIOD a run covers, stated on the screen where it is chosen.
          A schedule reports the last COMPLETE period before it fires, which is the correct rule and a
          genuinely surprising one on the option this form recommends first: "last day of month" fires
          on 31 January and reports December. Left unsaid, a month-end finance schedule quietly
          delivers the wrong month forever. See scheduleDraft.coverageNote. */}
      {(() => {
        const { covers, warn } = coverageNote(draft);
        return (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="text-[11px] text-[var(--muted)]">{covers}</p>
            {warn ? <p className="mt-1 text-[11px] font-semibold text-amber-600">{warn}</p> : null}
          </div>
        );
      })()}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Time</span>
          <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Format</span>
          <Select
            size="sm"
            value={draft.format}
            onChange={(v) => set({ format: v as "xlsx" | "csv" })}
            options={[
              { value: "xlsx", label: "Excel (.xlsx)" },
              { value: "csv", label: "CSV" },
            ]}
            ariaLabel="Format"
          />
        </label>
      </div>

      {/* Read-only. Settings -> Company -> Timezone is the one place a timezone is configured; asking
          for it again here would be a second source of truth for the same fact. An older schedule may
          still carry its own override, and this says so rather than showing a company zone it does
          not actually follow. */}
      <div>
        <span className={labelCls}>Timezone</span>
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]">
          {override ? (
            <>
              <span className="font-semibold text-[var(--ink)]">{override}</span> — set on this schedule
            </>
          ) : (
            <>
              Company timezone — <span className="font-semibold text-[var(--ink)]">{companyTimeZone}</span>
            </>
          )}
        </p>
      </div>

      {/* A <div> with a SIBLING label, never a wrapping <label> — this is what made the recipient
          picker unselectable.
          
          MultiSelect renders its option list INLINE, so inside a <label> every option is a label
          descendant. Clicking one makes the browser forward the activation to the label's control —
          MultiSelect's own search input — so `toggle` ran for the real click and again for the
          forwarded one: selected, then immediately deselected, and nothing ever stuck.
          
          The <Select>s above survive the same wrapper only because their popup is portalled out of
          the label. UserForm, the only other MultiSelect in the app, already uses this shape. */}
      <div className="block">
        <span className={labelCls}>Recipients</span>
        <MultiSelect
          values={selected}
          onChange={(recipients) => set({ recipients })}
          options={recipientOptions}
          placeholder={loadingRecipients ? "Loading…" : "Select authorised users…"}
          searchPlaceholder="Search users…"
          disabled={loadingRecipients}
          ariaLabel="Recipients"
          emptyText="No user is authorised to receive this report."
        />
        <span className="mt-1 block text-[11px] text-[var(--muted)]">
          Only active users who may view this report. The server checks the list again on save, and
          again on every run.
        </span>
        {dropped > 0 ? (
          <span className="mt-1 block text-[11px] text-[var(--neg)]">
            {dropped} previously selected recipient{dropped === 1 ? " is" : "s are"} no longer an active
            authorised user and will be removed when you save.
          </span>
        ) : null}
      </div>

      {/* Only the filters THIS report declares. Anything else is rejected by the server.

          PICKERS, not typed ids — the same fix and the same option lists the Custom Reports screen
          uses. These shipped as text boxes placeheld "Optional", which asked an administrator to know
          and type a Mongo ObjectId; anything else saved cleanly and then produced a filter that
          matched nothing, on a schedule that emails people every month with nobody watching. A
          silently-wrong scheduled report is worse than a screen that errors, because nothing on it
          ever says the filter did not apply.

          `stacked` so each control gets the modal's full width — a two-column grid put "London
          Fulfillment Centre" in a 150px box. */}
      {filters.length > 0 ? (
        <div className="flex flex-col gap-3">
          {filters.map((f) => (
            <label key={f} className="block">
              <span className={labelCls}>{FILTER_LABEL[f] ?? f}</span>
              {f === "itemKind" ? (
                <Select
                  size="sm"
                  value={draft.filters[f] ?? ""}
                  onChange={(v) => set({ filters: { ...draft.filters, [f]: v } })}
                  options={STOCK_TYPE_OPTIONS}
                  ariaLabel={FILTER_LABEL[f] ?? f}
                />
              ) : (
                <Select
                  size="sm"
                  disabled={f === "projectId" && !draft.filters.customerId}
                  value={draft.filters[f] ?? ""}
                  onChange={(v) => {
                    // Changing the customer invalidates a project chosen under the previous one.
                    const next = { ...draft.filters, [f]: v };
                    if (f === "customerId") delete next.projectId;
                    set({ filters: next });
                  }}
                  options={[{ value: "", label: placeholderFor(f, Boolean(draft.filters.customerId)) }, ...optionsFor(f)]}
                  ariaLabel={FILTER_LABEL[f] ?? f}
                />
              )}
            </label>
          ))}
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-xs font-semibold text-[var(--ink)]">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Active
      </label>

      {/* PINNED to the bottom of the scrolling body.
          
          This form is eleven controls tall and overflowed the viewport: the modal grew past the
          screen, its title scrolled away off the top, and Save sat below the fold — so the way to
          submit was to scroll a dialog that did not look scrollable. The Modal's `scrollBody` pins the
          header and caps the panel; `sticky` here keeps the actions in view for the same reason,
          without moving them out of the component that owns `selected` and the disabled rule.
          
          `-mx-5` cancels the modal body's horizontal `p-5` so the bar spans the full panel width and
          its top border reads as a divider rather than a floating line.
          
          There is deliberately NO `-mb-5` to match it. A sticky element still occupies its place in
          the flow, and pulling it 20px past the end of the content shortens the scroll range by
          exactly that much — so at the bottom of the scroll the bar came to rest ON TOP of the last
          control instead of below it, and the "Active" checkbox sat half-hidden behind it with no way
          to scroll it clear. The body's own bottom padding is what gives the last control somewhere to
          land. */}
      <div className="sticky bottom-0 -mx-5 mt-1 flex justify-end gap-2 border-t border-[var(--border-2)] bg-[var(--surface)] px-5 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(selected)}
          disabled={saving || !draft.name.trim() || selected.length === 0}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>

    </div>
  );
}
