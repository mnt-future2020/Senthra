"use client";

import * as React from "react";
import { Loader2, Lock } from "lucide-react";

import * as authService from "@/services/auth.service";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { Notice } from "@/components/ui/Notice";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Field } from "@/components/ui/Field";
import { primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export function SecuritySection() {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!currentPassword) {
      setMsg({ type: "error", text: "Enter your current password." });
      return;
    }
    if (newPassword.length < 8) {
      setMsg({ type: "error", text: "New password must be at least 8 characters." });
      return;
    }
    if (newPassword !== confirm) {
      setMsg({ type: "error", text: "New passwords do not match." });
      return;
    }
    setSaving(true);
    try {
      await authService.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setMsg({ type: "success", text: "Password updated successfully." });
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
      icon={Lock}
      title="Password"
      desc="Set a strong password you don't reuse — at least 8 characters."
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Current password"
            hint="Confirms it's you."
          >
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
          </Field>
          <Field
            label="New password"
            hint="8+ characters with letters, numbers & symbols."
          >
            <PasswordInput
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              autoComplete="new-password"
            />
          </Field>
          <Field
            label="Confirm new password"
            hint="Re-type to confirm."
          >
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
