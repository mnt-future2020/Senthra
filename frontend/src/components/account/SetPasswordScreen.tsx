"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";
import { BrandMark } from "@/components/branding/BrandMark";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Notice } from "@/components/ui/Notice";
import * as authService from "@/services/auth.service";
import { homeFor } from "@/lib/auth";
import type { Msg } from "@/components/ui/types";

// First-login forced password set. There's no current password — the active
// session authorises the change. On success the principal is refreshed and the
// user continues into the dashboard (their first section, or the no-access home).
export function SetPasswordScreen() {
  const { user, logout, refresh } = useAuth();
  const { brandName } = useBranding();
  const router = useRouter();

  const [newPw, setNewPw] = React.useState("");
  const [confirmPw, setConfirmPw] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const signOut = async () => {
    await logout();
    router.replace("/login");
  };

  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (newPw.length < 8)
      return setMsg({ type: "error", text: "Password must be at least 8 characters." });
    if (newPw !== confirmPw) return setMsg({ type: "error", text: "Passwords don't match." });

    setSaving(true);
    try {
      const updated = await authService.changeUserPassword(newPw);
      await refresh();
      router.replace(homeFor(updated));
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Could not set your password.",
      });
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <BrandMark className="h-11 w-11 rounded-xl text-lg shadow-md accent-glow select-none" />
          <div className="leading-tight">
            <h1 className="text-lg font-extrabold text-[var(--ink)]">Welcome to {brandName}</h1>
            <p className="text-sm text-[var(--muted)]">
              Hi {user.firstName} — set a password to finish signing in.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-[var(--ink)]">New password</label>
            <PasswordInput
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-[var(--ink)]">
              Confirm password
            </label>
            <PasswordInput
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="Re-enter your new password"
              autoComplete="new-password"
            />
          </div>
          <Notice msg={msg} />
          <button
            type="submit"
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Set password & continue"}
          </button>
        </form>

        <button
          onClick={signOut}
          className="mt-4 w-full text-center text-xs font-semibold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
