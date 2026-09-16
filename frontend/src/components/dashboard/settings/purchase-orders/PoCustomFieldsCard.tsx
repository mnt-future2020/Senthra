"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, ListPlus, Loader2, Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import * as poService from "@/services/purchase-order.service";
import type { PoCustomFieldDefinition } from "@/types/purchase-order";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";
import { Notice } from "@/components/ui/Notice";
import { inputCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { useReportDirty } from "@/providers/NavigationGuardProvider";
import { fieldLabelError, moveField, PO_CUSTOM_FIELD_LABEL_MAX, PO_CUSTOM_FIELD_MAX_ACTIVE } from "./poSettings";

// PO custom fields — extra TEXT boxes offered in an "Additional information" section of the PO form.
// Informational only. Each change saves immediately (like a toggle elsewhere in Settings); the only
// unsaved state is a name being typed, which is what the navigation guard watches.

const err = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function PoCustomFieldsCard() {
  const { can } = useAuth();
  const canManage = can("settings.manage");
  const { pushToast } = useDashboard();

  const [fields, setFields] = React.useState<PoCustomFieldDefinition[] | null>(null);
  const [newLabel, setNewLabel] = React.useState("");
  const [newPrint, setNewPrint] = React.useState(true);
  const [editing, setEditing] = React.useState<{ id: string; label: string } | null>(null);
  // What is saving right now: a field id, "new" or "order". One action at a time.
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<Msg>(null);

  const list = fields ?? [];
  const editingOriginal = editing ? list.find((f) => f.id === editing.id)?.label : undefined;
  useReportDirty(
    "po-custom-fields",
    Boolean(newLabel.trim()) || Boolean(editing && editing.label.trim() !== editingOriginal),
  );

  React.useEffect(() => {
    poService.listPoCustomFields().then(setFields, (e: unknown) => {
      setFields([]);
      setMsg({ type: "error", text: err(e, "Could not load the custom fields.") });
    });
  }, []);

  const replace = (f: PoCustomFieldDefinition) => setFields((cur) => (cur ?? []).map((x) => (x.id === f.id ? f : x)));
  const activeCount = list.filter((f) => f.active).length;
  const controlsDisabled = !canManage || busy !== null;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const problem =
      fieldLabelError(newLabel, list) ??
      (activeCount >= PO_CUSTOM_FIELD_MAX_ACTIVE ? `You can have up to ${PO_CUSTOM_FIELD_MAX_ACTIVE} active fields. Deactivate one first.` : null);
    if (problem) {
      setMsg({ type: "error", text: problem });
      return;
    }
    setBusy("new");
    try {
      const created = await poService.createPoCustomField({ label: newLabel.trim(), printOnPdf: newPrint });
      setFields((cur) => [...(cur ?? []), created]);
      setNewLabel("");
      setNewPrint(true);
      pushToast(`Field "${created.label}" added.`);
    } catch (e2) {
      setMsg({ type: "error", text: err(e2, "Could not add the field.") });
    } finally {
      setBusy(null);
    }
  };

  const saveRename = async () => {
    if (!editing) return;
    setMsg(null);
    const label = editing.label.trim();
    if (label === editingOriginal) {
      setEditing(null);
      return;
    }
    const problem = fieldLabelError(label, list, editing.id);
    if (problem) {
      setMsg({ type: "error", text: problem });
      return;
    }
    setBusy(editing.id);
    try {
      replace(await poService.updatePoCustomField(editing.id, { label }));
      setEditing(null);
      pushToast("Field renamed.");
    } catch (e) {
      setMsg({ type: "error", text: err(e, "Could not rename the field.") });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (f: PoCustomFieldDefinition, patch: { active: boolean } | { printOnPdf: boolean }) => {
    setMsg(null);
    setBusy(f.id);
    try {
      const updated = await poService.updatePoCustomField(f.id, patch);
      replace(updated);
      if ("active" in patch) {
        pushToast(
          patch.active
            ? `"${updated.label}" reactivated.`
            : `"${updated.label}" deactivated — orders that already have a value keep it.`,
        );
      }
    } catch (e) {
      setMsg({ type: "error", text: err(e, "Could not update the field.") });
    } finally {
      setBusy(null);
    }
  };

  const move = async (f: PoCustomFieldDefinition, dir: -1 | 1) => {
    const next = moveField(list, f.id, dir);
    if (next === list) return;
    setMsg(null);
    const previous = list;
    setFields(next);
    setBusy("order");
    try {
      setFields(await poService.reorderPoCustomFields(next.map((x) => x.id)));
    } catch (e) {
      setFields(previous);
      setMsg({ type: "error", text: err(e, "Could not reorder the fields.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      icon={ListPlus}
      title="PO custom fields"
      desc="Extra text fields for recording additional information on a purchase order. They appear in an “Additional information” section of the PO form while an order is a draft, and never change totals, approval, receiving or reports."
    >
      <div className="space-y-5">
        {!canManage && <ReadOnlyNotice />}

        {fields === null ? (
          <p className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading fields…
          </p>
        ) : list.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--muted)]">
            No custom fields yet. The PO form shows no additional-information section until you add one.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="PO custom fields">
            {list.map((f, i) => (
              <li
                key={f.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[var(--border)] px-3 py-2.5 ${f.active ? "" : "bg-[var(--surface-2)]/60"}`}
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(f, -1)}
                    disabled={controlsDisabled || i === 0}
                    aria-label={`Move ${f.label} up`}
                    className="rounded p-0.5 text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(f, 1)}
                    disabled={controlsDisabled || i === list.length - 1}
                    aria-label={`Move ${f.label} down`}
                    className="rounded p-0.5 text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="min-w-0 flex-1">
                  {editing?.id === f.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputCls} max-w-[280px]`}
                        value={editing.label}
                        onChange={(e) => setEditing({ id: f.id, label: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveRename();
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                        maxLength={PO_CUSTOM_FIELD_LABEL_MAX}
                        aria-label="Field name"
                        autoFocus
                      />
                      <button type="button" onClick={saveRename} disabled={busy !== null} className={primaryBtn}>
                        Save
                      </button>
                      <button type="button" onClick={() => setEditing(null)} disabled={busy !== null} className={secondaryBtn}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold text-[var(--ink)]">{f.label}</span>
                      {!f.active && (
                        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">
                          Inactive
                        </span>
                      )}
                      {canManage && f.active && (
                        <button
                          type="button"
                          onClick={() => setEditing({ id: f.id, label: f.label })}
                          disabled={controlsDisabled}
                          aria-label={`Rename ${f.label}`}
                          className="text-xs font-bold text-[var(--muted)] underline-offset-2 hover:text-[var(--accent)] hover:underline disabled:opacity-60"
                        >
                          Rename
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                  <Toggle
                    checked={f.printOnPdf}
                    onChange={(v) => toggle(f, { printOnPdf: v })}
                    disabled={controlsDisabled}
                    aria-label={`Print ${f.label} on PDF`}
                  />
                  Print on PDF
                </div>
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                  <Toggle
                    checked={f.active}
                    onChange={(v) => toggle(f, { active: v })}
                    disabled={controlsDisabled}
                    aria-label={`${f.label} active`}
                  />
                  Active
                </div>
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form onSubmit={add} className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
            <input
              className={`${inputCls} max-w-[280px] flex-1`}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={PO_CUSTOM_FIELD_LABEL_MAX}
              placeholder="e.g. Cost centre"
              aria-label="New field name"
            />
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
              <Toggle checked={newPrint} onChange={setNewPrint} disabled={busy !== null} aria-label="Print new field on PDF" />
              Print on PDF
            </div>
            <button type="submit" disabled={busy !== null || !newLabel.trim()} className={primaryBtn}>
              {busy === "new" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add field
            </button>
          </form>
        )}

        <Notice msg={msg} />

        <p className="text-[11px] leading-relaxed text-[var(--faint)]">
          Text fields only, up to {PO_CUSTOM_FIELD_MAX_ACTIVE} active. Values can be entered while an order is a draft
          and lock with it. A deactivated field leaves the form but stays on the orders that already have a value. A
          rename reaches draft orders the next time they are saved; submitted orders keep the name they had.
        </p>
      </div>
    </SettingsCard>
  );
}
