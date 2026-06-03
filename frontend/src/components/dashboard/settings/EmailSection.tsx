"use client";

import * as React from "react";
import { Loader2, Send } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { SettingsCard } from "./ui/SettingsCard";
import { Notice } from "./ui/Notice";
import { Toggle } from "./ui/Toggle";
import { PasswordInput } from "./ui/PasswordInput";
import { Field } from "./ui/Field";
import { inputCls, primaryBtn } from "./ui/styles";
import type { Msg } from "./types";

// Common providers — selecting one auto-fills host/port/encryption.
const PROVIDERS: Record<
  string,
  { label: string; host: string; port: number | ""; secure: boolean }
> = {
  custom: { label: "Custom", host: "", port: "", secure: false },
  gmail: { label: "Gmail", host: "smtp.gmail.com", port: 587, secure: false },
  outlook: {
    label: "Outlook / Microsoft 365",
    host: "smtp.office365.com",
    port: 587,
    secure: false,
  },
  yahoo: { label: "Yahoo", host: "smtp.mail.yahoo.com", port: 465, secure: true },
  zoho: { label: "Zoho", host: "smtp.zoho.com", port: 465, secure: true },
};

function detectProvider(host: string): string {
  const match = Object.entries(PROVIDERS).find(
    ([key, p]) => key !== "custom" && p.host === host,
  );
  return match ? match[0] : "custom";
}

export function EmailSection() {
  const [enabled, setEnabled] = React.useState(false);
  const [provider, setProvider] = React.useState("custom");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState<string>("");
  const [secure, setSecure] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [passwordSet, setPasswordSet] = React.useState(false);
  const [fromName, setFromName] = React.useState("");
  const [fromEmail, setFromEmail] = React.useState("");

  const [testTo, setTestTo] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const settings = await settingsService.getSettings();
        setEnabled(settings.smtpEnabled);
        setHost(settings.smtpHost);
        setPort(settings.smtpPort != null ? String(settings.smtpPort) : "");
        setSecure(settings.smtpSecure);
        setUsername(settings.smtpUsername);
        setFromName(settings.smtpFromName);
        setFromEmail(settings.smtpFromEmail);
        setPasswordSet(settings.smtpPasswordSet);
        setProvider(detectProvider(settings.smtpHost));
      } catch {
        // ignore — leave the form blank
      }
    })();
  }, []);

  const onProviderChange = (key: string) => {
    setProvider(key);
    const p = PROVIDERS[key];
    if (key !== "custom" && p) {
      setHost(p.host);
      setPort(p.port === "" ? "" : String(p.port));
      setSecure(p.secure);
    }
  };

  // Build the SMTP payload shared by Save + Test.
  const smtpPayload = () => ({
    smtpEnabled: enabled,
    smtpHost: host,
    smtpPort: port,
    smtpSecure: secure,
    smtpUsername: username,
    smtpFromName: fromName,
    smtpFromEmail: fromEmail,
    // Blank = keep the saved password (handled server-side).
    smtpPassword: password,
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      const settings = await settingsService.updateSettings(smtpPayload());
      setPasswordSet(settings.smtpPasswordSet);
      setPassword("");
      setMsg({ type: "success", text: "Email settings saved." });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Save failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setMsg(null);
    if (!testTo.trim()) {
      setMsg({ type: "error", text: "Enter an address to send the test to." });
      return;
    }
    setTesting(true);
    try {
      const res = await settingsService.sendTestEmail({
        ...smtpPayload(),
        to: testTo.trim(),
      });
      setMsg({ type: "success", text: res.message || "Test email sent." });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Test failed.",
      });
    } finally {
      setTesting(false);
    }
  };

  const secBtn = (active: boolean) =>
    `flex-1 rounded-xl border px-3 py-2.5 text-xs font-bold transition-all ${
      active
        ? "border-[var(--accent)] bg-[var(--accent-6)] text-[var(--accent)]"
        : "border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-2)]"
    }`;

  return (
    <SettingsCard
      icon={Send}
      title="Email (SMTP)"
      desc="Configure the SMTP server used to send emails — notifications, alerts and reports. The password is stored securely and never shown again."
    >
      <form onSubmit={save} className="space-y-4">
        {/* Enable */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
          <div className="min-w-0">
            <span className="block text-sm font-bold text-[var(--ink)]">
              Enable email sending
            </span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              {enabled
                ? "Emails will be sent through this SMTP server."
                : "Turn on once your SMTP details are configured."}
            </span>
          </div>
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            aria-label="Enable email sending"
          />
        </div>

        {/* Provider preset */}
        <Field
          label="Provider preset"
          hint="Pick a known provider to auto-fill host, port and encryption."
        >
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value)}
            className={inputCls}
          >
            {Object.entries(PROVIDERS).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Host + Port */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field
              label="SMTP host"
              hint="Your mail server's address, e.g. smtp.gmail.com."
            >
              <input
                type="text"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setProvider(detectProvider(e.target.value));
                }}
                placeholder="smtp.example.com"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Port" hint="587 for STARTTLS, 465 for SSL/TLS.">
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="587"
              className={inputCls}
            />
          </Field>
        </div>

        {/* Encryption */}
        <Field
          label="Encryption"
          hint="Match this to the port — 587 uses STARTTLS, 465 uses SSL/TLS."
        >
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setSecure(false)}
              className={secBtn(!secure)}
            >
              STARTTLS · 587
            </button>
            <button
              type="button"
              onClick={() => setSecure(true)}
              className={secBtn(secure)}
            >
              SSL / TLS · 465
            </button>
          </div>
        </Field>

        {/* Auth */}
        <Field
          label="Username"
          hint="Usually the full email address of the sending account."
        >
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="user@example.com"
            autoComplete="off"
            className={inputCls}
          />
        </Field>
        <Field
          label={<>Password {passwordSet && "(saved — leave blank to keep)"}</>}
          hint="For Gmail or Outlook, use an app password — not your login password."
        >
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={passwordSet ? "•••••••• (saved)" : "SMTP password / app password"}
            autoComplete="off"
          />
        </Field>

        {/* From identity */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="From name"
            hint="The sender name recipients see, e.g. your company."
          >
            <input
              type="text"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Your Company"
              className={inputCls}
            />
          </Field>
          <Field
            label="From email"
            hint="The address emails are sent from. Some providers require it to match the username."
          >
            <input
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="no-reply@example.com"
              className={inputCls}
            />
          </Field>
        </div>

        <Notice msg={msg} />

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save email settings
          </button>
        </div>

        {/* Test email */}
        <div className="border-t border-[var(--border-2)] pt-4">
          <Field
            label="Send a test email"
            hint="Uses the values above (or your saved settings). A blank password falls back to the saved one."
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
              />
              <button
                type="button"
                onClick={sendTest}
                disabled={testing}
                className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5 text-xs font-extrabold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Send test
              </button>
            </div>
          </Field>
        </div>
      </form>
    </SettingsCard>
  );
}
