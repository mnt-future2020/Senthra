"use client";

import * as React from "react";
import { Loader2, Plug } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { SettingsCard } from "./ui/SettingsCard";
import { Notice } from "./ui/Notice";
import { PasswordInput } from "./ui/PasswordInput";
import { Toggle } from "./ui/Toggle";
import { inputCls, labelCls, primaryBtn } from "./ui/styles";
import type { Msg } from "./types";

export function IntegrationsSection() {
  const [googleEnabled, setGoogleEnabled] = React.useState(false);
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [secretSet, setSecretSet] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

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
      setMsg({ type: "success", text: "Google settings saved." });
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
      desc="Configure Google OAuth so you can sign in with Google. Credentials come from the Google Cloud Console; the secret is stored securely and never shown again."
    >
      <form onSubmit={save} className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
          <div className="min-w-0">
            <span className="block text-sm font-bold text-[var(--ink)]">
              Enable Google Sign-In
            </span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              {googleEnabled
                ? "Admins can sign in with the configured Google account."
                : "Turn on to allow signing in with Google."}
            </span>
          </div>
          <Toggle
            checked={googleEnabled}
            onChange={setGoogleEnabled}
            aria-label="Enable Google Sign-In"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxxx.apps.googleusercontent.com"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>
              Client secret {secretSet && "(saved — leave blank to keep)"}
            </label>
            <PasswordInput
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={secretSet ? "•••••••• (saved)" : "Client secret"}
              autoComplete="off"
            />
          </div>
        </div>
        <Notice msg={msg} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Google settings
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}
