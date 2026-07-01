"use client";

import * as React from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useAuth } from "@/hooks/useAuth";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Notice } from "@/components/ui/Notice";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";
import { primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export function OperationsSection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");

  const [requireSignature, setRequireSignature] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const settings = await settingsService.getSettings();
        setRequireSignature(settings.engineerTransferRequireSignature ?? false);
      } catch {
        // ignore — keep defaults
      }
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      await settingsService.updateSettings({ engineerTransferRequireSignature: requireSignature });
      setMsg({ type: "success", text: "Operations settings saved." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={ArrowRightLeft}
      title="Engineer Transfers"
      desc="Controls for the engineer-to-engineer stock transfer workflow."
    >
      <form onSubmit={save} className="space-y-4">
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
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </fieldset>
      </form>
    </SettingsCard>
  );
}
