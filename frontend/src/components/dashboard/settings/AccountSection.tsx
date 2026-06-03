"use client";

import * as React from "react";
import { Loader2, User } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as authService from "@/services/auth.service";
import { SettingsCard } from "./ui/SettingsCard";
import { Notice } from "./ui/Notice";
import { PasswordInput } from "./ui/PasswordInput";
import { inputCls, labelCls, primaryBtn } from "./ui/styles";
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
      desc="Update the email you use to sign in. Your current password confirms the change."
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Current password</label>
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Required to confirm"
              autoComplete="current-password"
            />
          </div>
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
