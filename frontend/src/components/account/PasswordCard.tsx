"use client";

import * as React from "react";
import { KeyRound, Loader2 } from "lucide-react";

import * as authService from "@/services/auth.service";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { Field } from "@/components/dashboard/settings/ui/Field";
import { Notice } from "@/components/dashboard/settings/ui/Notice";
import { PasswordInput } from "@/components/dashboard/settings/ui/PasswordInput";
import { primaryBtn } from "@/components/dashboard/settings/ui/styles";
import type { Msg } from "@/components/dashboard/settings/types";

// Voluntary password change for a staff user (requires the current password). The
// first-login forced set lives in SetPasswordScreen and omits the current password.
export function PasswordCard() {
  const [currentPw, setCurrentPw] = React.useState("");
  const [newPw, setNewPw] = React.useState("");
  const [confirmPw, setConfirmPw] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!currentPw) return setMsg({ type: "error", text: "Enter your current password." });
    if (newPw.length < 8)
      return setMsg({ type: "error", text: "New password must be at least 8 characters." });
    if (newPw !== confirmPw) return setMsg({ type: "error", text: "Passwords don't match." });

    setSaving(true);
    try {
      await authService.changeUserPassword(newPw, currentPw);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setMsg({ type: "success", text: "Password updated." });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Could not change your password.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={KeyRound}
      title="Password"
      desc="Change the password you sign in with. Your current password confirms the change."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password" hint="Confirms it's really you before the change.">
          <PasswordInput
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Your current password"
            autoComplete="current-password"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" hint="At least 8 characters.">
            <PasswordInput
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Notice msg={msg} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Update password
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}
