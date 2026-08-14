"use client";

import * as React from "react";
import { Loader2, Plug } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Notice } from "@/components/ui/Notice";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";
import { Field } from "@/components/ui/Field";
import { inputCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export function IntegrationsSection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");
  const [googleEnabled, setGoogleEnabled] = React.useState(false);
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [secretSet, setSecretSet] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // ERRORS ONLY. A failure has to stay on screen until it is fixed; the success is a moment and
  // goes to a toast. Keeping both here left the receipt under the form while the user typed new
  // changes into it — a "saved" that had stopped being true, and this card has no dirty bar to
  // contradict it.
  const [msg, setMsg] = React.useState<Msg>(null);
  const { pushToast } = useDashboard();

  React.useEffect(() => {
    (async () => {
      try {
        const settings = await settingsService.getSettings();
        setGoogleEnabled(settings.googleEnabled);
        setClientId(settings.googleClientId);
        setSecretSet(settings.googleClientSecretSet);
      } catch {
        // ignore
      }
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      const settings = await settingsService.updateSettings({
        googleEnabled,
        googleClientId: clientId,
        googleClientSecret: clientSecret || undefined,
      });
      setSecretSet(settings.googleClientSecretSet);
      setClientSecret("");
      pushToast("Google settings saved.");
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Save failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={Plug}
      title="Google Sign-In"
      desc="Let users sign in with Google. Credentials come from the Google Cloud Console."
    >
      <form onSubmit={save} className="space-y-4">
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
          <div className="min-w-0">
            <span className="block text-sm font-bold text-[var(--ink)]">
              Enable Google Sign-In
            </span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              {googleEnabled
                ? "Users with a matching account can sign in with Google."
                : "Turn on to allow Google sign-in."}
            </span>
          </div>
          <Toggle
            checked={googleEnabled}
            onChange={setGoogleEnabled}
            aria-label="Enable Google Sign-In"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Client ID"
            hint="Cloud Console → APIs & Services → Credentials."
          >
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxxx.apps.googleusercontent.com"
              className={inputCls}
            />
          </Field>
          <Field
            label="Client secret"
            hint={
              secretSet
                ? "Saved — leave blank to keep. Stored encrypted, never shown again."
                : "Stored encrypted, never shown again."
            }
          >
            <PasswordInput
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={secretSet ? "•••••••• (saved)" : "Client secret"}
              autoComplete="off"
            />
          </Field>
        </div>
        <Notice msg={msg} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Google settings
          </button>
        </div>
        </fieldset>
      </form>
    </SettingsCard>
  );
}
