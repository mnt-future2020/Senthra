"use client";

import * as React from "react";
import { Cloud, Loader2 } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useAuth } from "@/hooks/useAuth";
import { SettingsCard } from "./ui/SettingsCard";
import { ReadOnlyNotice } from "./ui/ReadOnlyNotice";
import { Notice } from "./ui/Notice";
import { PasswordInput } from "./ui/PasswordInput";
import { Field } from "./ui/Field";
import { inputCls, primaryBtn } from "./ui/styles";
import type { Msg } from "./types";

export function CloudinarySection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");
  const [cloudName, setCloudName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [apiSecret, setApiSecret] = React.useState("");
  const [secretSet, setSecretSet] = React.useState(false);
  const [configured, setConfigured] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await settingsService.getSettings();
        setCloudName(s.cloudinaryCloudName);
        setApiKey(s.cloudinaryApiKey);
        setSecretSet(s.cloudinaryApiSecretSet);
        setConfigured(s.cloudinaryConfigured);
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
      const s = await settingsService.updateSettings({
        cloudinaryCloudName: cloudName,
        cloudinaryApiKey: apiKey,
        cloudinaryApiSecret: apiSecret || undefined,
      });
      setSecretSet(s.cloudinaryApiSecretSet);
      setConfigured(s.cloudinaryConfigured);
      setApiSecret("");
      setMsg({ type: "success", text: "Cloudinary settings saved." });
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
      icon={Cloud}
      title="Cloudinary (image storage)"
      badge={
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${
            configured
              ? "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]"
              : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              configured ? "bg-[var(--pos)]" : "bg-[var(--faint)]"
            }`}
          />
          {configured ? "Connected" : "Not set up"}
        </span>
      }
      desc="Powers logo & favicon uploads in the Branding tab. Find these in your Cloudinary dashboard. The API secret is encrypted and never shown again. A CLOUDINARY_* backend env config is used as a fallback."
    >
      <form onSubmit={save} className="space-y-4">
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-4">
        <Field
          label="Cloud name"
          hint="Found in your Cloudinary dashboard under Product Environment."
        >
          <input
            type="text"
            value={cloudName}
            onChange={(e) => setCloudName(e.target.value)}
            placeholder="your-cloud-name"
            autoComplete="off"
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="API key"
            hint="The public API key from your Cloudinary account settings."
          >
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="123456789012345"
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field
            label={
              <>API secret {secretSet && "(saved — leave blank to keep)"}</>
            }
            hint="Encrypted on the server and never shown again after saving."
          >
            <PasswordInput
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder={secretSet ? "•••••••• (saved)" : "API secret"}
              autoComplete="off"
            />
          </Field>
        </div>

        <Notice msg={msg} />

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Cloudinary settings
          </button>
        </div>
        </fieldset>
      </form>
    </SettingsCard>
  );
}
