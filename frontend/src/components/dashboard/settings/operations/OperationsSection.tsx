"use client";

import * as React from "react";
import { ArrowRightLeft, Clock, Loader2 } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useAuth } from "@/hooks/useAuth";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Notice } from "@/components/ui/Notice";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";
import { NumberInput } from "@/components/ui/NumberInput";
import { inputCls, labelCls, hintCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

// Mirrors the server bounds (settings.service.ts MIN/MAX_OVERDUE_AFTER_DAYS). Held here too so the
// field can refuse a bad value before a round-trip — the server is still the one that enforces it.
const MIN_OVERDUE_DAYS = 1;
const MAX_OVERDUE_DAYS = 365;
const DEFAULT_OVERDUE_DAYS = 14;

export function OperationsSection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");

  const [requireSignature, setRequireSignature] = React.useState(false);
  // String, like every other numeric field here: a number state becomes NaN the moment the box is
  // cleared mid-edit.
  const [overdueDays, setOverdueDays] = React.useState(String(DEFAULT_OVERDUE_DAYS));
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const settings = await settingsService.getSettings();
        setRequireSignature(settings.engineerTransferRequireSignature ?? false);
        setOverdueDays(String(settings.overdueAfterDays ?? DEFAULT_OVERDUE_DAYS));
      } catch {
        // ignore — keep defaults
      }
    })();
  }, []);

  const overdueNum = Number(overdueDays);
  const overdueValid =
    overdueDays.trim() !== "" && Number.isInteger(overdueNum) && overdueNum >= MIN_OVERDUE_DAYS && overdueNum <= MAX_OVERDUE_DAYS;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!overdueValid) {
      setMsg({ type: "error", text: `Overdue after must be a whole number between ${MIN_OVERDUE_DAYS} and ${MAX_OVERDUE_DAYS} days.` });
      return;
    }
    setSaving(true);
    try {
      await settingsService.updateSettings({
        engineerTransferRequireSignature: requireSignature,
        overdueAfterDays: overdueNum,
      });
      setMsg({ type: "success", text: "Operations settings saved." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  return (
    // One form across both cards, so the single Save at the bottom commits the whole section in one
    // patch — a per-card Save would let someone change a field in one card, hit the other card's
    // button, and watch their edit vanish without a word.
    <form onSubmit={save} className="space-y-5">
    <SettingsCard
      icon={Clock}
      title="Goods Management"
      desc="When stock still held by an engineer should start counting as overdue."
    >
      <fieldset disabled={!canManage} className="min-w-0 space-y-2">
        {!canManage && <ReadOnlyNotice />}
        <label className={labelCls} htmlFor="overdue-after-days">
          Overdue after
        </label>
        <div className="flex items-center gap-2">
          <NumberInput
            id="overdue-after-days"
            value={overdueDays}
            onChange={(e) => setOverdueDays(e.target.value)}
            min={MIN_OVERDUE_DAYS}
            max={MAX_OVERDUE_DAYS}
            step={1}
            className={`${inputCls} max-w-32`}
            aria-invalid={!overdueValid}
          />
          <span className="text-sm font-semibold text-[var(--muted)]">days</span>
        </div>
        <p className={hintCls}>
          Drives the Goods Management → Overdue list and the Inventory Hub&rsquo;s &ldquo;overdue&rdquo; figure, so both
          move together. This is the only place it is set — warehouse staff see the same window you choose here.
          A same-week install job suits about a fortnight; month-long projects will want more.
        </p>
      </fieldset>
    </SettingsCard>

    <SettingsCard
      icon={ArrowRightLeft}
      title="Engineer Transfers"
      desc="Controls for the engineer-to-engineer stock transfer workflow."
    >
      <div className="space-y-4">
        {/* Each card carries its own notice: a read-only user scrolling to this one would otherwise
            meet greyed controls with the explanation stranded in the card above. */}
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
            <div className="min-w-0">
              <span className="block text-sm font-bold text-[var(--ink)]">
                Require receiver signature
              </span>
              <span className="mt-0.5 block text-xs text-[var(--muted)]">
                {requireSignature
                  ? "The recipient must sign on their device to acknowledge each completed transfer."
                  : "Turn on to require a drawn signature from the recipient before a transfer is acknowledged."}
              </span>
            </div>
            <Toggle
              checked={requireSignature}
              onChange={setRequireSignature}
              aria-label="Require receiver signature on engineer transfers"
            />
          </div>
          <Notice msg={msg} />
          <div className="flex justify-end">
            {/* One Save for the whole section — both cards post in a single patch, so there's no way
                to save one and silently lose the other. */}
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </fieldset>
      </div>
    </SettingsCard>
    </form>
  );
}
