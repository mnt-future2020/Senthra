"use client";

import * as React from "react";
import { Check, KeyRound, Loader2, X } from "lucide-react";

import * as authService from "@/services/auth.service";
import { AccountCard } from "./AccountCard";
import { Field } from "@/components/dashboard/settings/ui/Field";
import { Notice } from "@/components/dashboard/settings/ui/Notice";
import { PasswordInput } from "@/components/dashboard/settings/ui/PasswordInput";
import { primaryBtn } from "@/components/dashboard/settings/ui/styles";
import type { Msg } from "@/components/dashboard/settings/types";

// 0..4 strength from length + character variety. Indicative only — the server
// enforces the real minimum (8 chars).
function scorePassword(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

const STRENGTH = [
  { label: "Too short", color: "var(--neg)" },
  { label: "Weak", color: "var(--neg)" },
  { label: "Fair", color: "#f59e0b" },
  { label: "Good", color: "var(--accent)" },
  { label: "Strong", color: "var(--pos)" },
];

// Voluntary password change for a staff user (requires the current password). The
// first-login forced set lives in SetPasswordScreen and omits the current password.
export function PasswordCard({ style }: { style?: React.CSSProperties }) {
  const [currentPw, setCurrentPw] = React.useState("");
  const [newPw, setNewPw] = React.useState("");
  const [confirmPw, setConfirmPw] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const score = scorePassword(newPw);
  const strength = STRENGTH[score];
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
  const match = confirmPw.length > 0 && newPw === confirmPw;

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
    <AccountCard
      icon={KeyRound}
      title="Password"
      desc="Change the password you sign in with. Your current password confirms it's really you."
      style={style}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password">
          <PasswordInput
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Your current password"
            autoComplete="current-password"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password">
            <PasswordInput
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="At least 8 characters"
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

        {/* Strength meter — appears as soon as they start typing a new password. */}
        {newPw.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="h-1.5 flex-1 rounded-full transition-all duration-300"
                  style={{ backgroundColor: i < score ? strength.color : "var(--border)" }}
                />
              ))}
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold" style={{ color: strength.color }}>
                {strength.label}
              </p>
              {confirmPw.length > 0 && (
                <p
                  className={`flex items-center gap-1 text-[11px] font-bold ${
                    match ? "text-[var(--pos)]" : "text-[var(--neg)]"
                  }`}
                >
                  {match ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {match ? "Passwords match" : "Doesn't match"}
                </p>
              )}
            </div>
          </div>
        )}

        <Notice msg={msg} />

        <div className="flex justify-end pt-1">
          <button type="submit" disabled={saving || mismatch} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Update password
          </button>
        </div>
      </form>
    </AccountCard>
  );
}
