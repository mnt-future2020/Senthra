"use client";

import * as React from "react";
import { Loader2, ShieldCheck, User } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as authService from "@/services/auth.service";
import { SettingsCard } from "./ui/SettingsCard";
import { Notice } from "./ui/Notice";
import { PasswordInput } from "./ui/PasswordInput";
import { Field } from "./ui/Field";
import { inputCls, primaryBtn } from "./ui/styles";
import type { Msg } from "./types";

export function AccountSection() {
  const { admin, refresh } = useAuth();
  const [email, setEmail] = React.useState(admin?.email ?? "");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (email.trim().toLowerCase() === (admin?.email ?? "")) {
      setMsg({ type: "error", text: "Enter a different email to change it." });
      return;
    }
    if (!currentPassword) {
      setMsg({ type: "error", text: "Enter your current password to confirm." });
      return;
    }
    setSaving(true);
    try {
      await authService.changeEmail(currentPassword, email);
      await refresh();
      setCurrentPassword("");
      setMsg({ type: "success", text: "Email updated successfully." });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Update failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={User}
      title="Account"
      badge={
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-10)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
          <ShieldCheck className="h-3 w-3" />
          Super Admin
        </span>
      }
      desc="This is the Super Admin account — the primary login for the system. Update the email you sign in with; your current password confirms the change."
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Email address"
            hint="The address you sign in with. Security notifications are sent here."
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field
            label="Current password"
            hint="Confirms it's really you before the email is changed."
          >
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Required to confirm"
              autoComplete="current-password"
            />
          </Field>
        </div>
        <Notice msg={msg} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Update email
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}
