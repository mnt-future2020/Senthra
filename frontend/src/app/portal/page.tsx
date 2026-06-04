"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2, LogOut, Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";
import { BrandMark } from "@/components/branding/BrandMark";
import * as authService from "@/services/auth.service";

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)]";

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? "text" : "password"} className={`${inputCls} pr-10`} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--faint)] transition-colors hover:text-[var(--ink)]"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

export default function PortalPage() {
  const { user, logout, refresh } = useAuth();
  const { brandName } = useBranding();
  const router = useRouter();

  const [newPw, setNewPw] = React.useState("");
  const [confirmPw, setConfirmPw] = React.useState("");
  const [currentPw, setCurrentPw] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [changing, setChanging] = React.useState(false);

  const signOut = async () => {
    await logout();
    router.replace("/login");
  };

  // AuthGuard guarantees a user principal before this renders; this satisfies TS.
  if (!user) return null;

  const validate = (): string | null => {
    if (newPw.length < 8) return "Password must be at least 8 characters.";
    if (newPw !== confirmPw) return "Passwords don't match.";
    return null;
  };

  // First-login forced set (no current password — the session authorises it).
  const submitFirstLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setError(null);
    setSaving(true);
    try {
      await authService.changeUserPassword(newPw);
      await refresh(); // principal.mustResetPassword is now false → renders the home
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set your password.");
    } finally {
      setSaving(false);
    }
  };

  // Voluntary change from the home (requires the current password).
  const submitChange = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setError(null);
    setSaving(true);
    try {
      await authService.changeUserPassword(newPw, currentPw);
      setDone(true);
      setChanging(false);
      setNewPw("");
      setConfirmPw("");
      setCurrentPw("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your password.");
    } finally {
      setSaving(false);
    }
  };

  // ---- First-login forced password set ----
  if (user.mustResetPassword) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
        <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <BrandMark className="h-11 w-11 rounded-xl text-lg shadow-md accent-glow select-none" />
            <div className="leading-tight">
              <h1 className="text-lg font-extrabold text-[var(--ink)]">
                Welcome to {brandName}
              </h1>
              <p className="text-sm text-[var(--muted)]">
                Hi {user.firstName} — set a password to finish signing in.
              </p>
            </div>
          </div>

          {error && (
            <div className="mt-5 rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
              {error}
            </div>
          )}

          <form onSubmit={submitFirstLogin} className="mt-5 space-y-4">
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
              <label className="block text-sm font-semibold text-[var(--ink)]">Confirm password</label>
              <PasswordInput
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                placeholder="Re-enter your new password"
                autoComplete="new-password"
              />
            </div>
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

  // ---- Staff home ----
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:px-8">
        <div className="flex items-center gap-3">
          <BrandMark className="h-9 w-9 rounded-xl text-lg shadow-md accent-glow select-none" />
          <span className="text-base font-extrabold tracking-tight">{brandName}</span>
        </div>
        <button
          onClick={signOut}
          className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-6 p-4 md:p-8">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs">
          <div className="flex items-center gap-2 text-[var(--accent)]">
            <Sparkles className="h-4 w-4" />
            <span className="text-[11px] font-extrabold uppercase tracking-wider">
              {user.role?.name ?? "No role assigned"}
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight">
            Welcome, {user.firstName}.
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            You&apos;re signed in to {brandName}. Your workspace is being set up — the
            tools for your role will appear here as they go live. We&apos;ll let you know
            when there&apos;s something to do.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]">
            Signed in as <span className="font-mono font-semibold text-[var(--ink)]">{user.email}</span>
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent-10)] text-[var(--accent)]">
                <KeyRound className="h-4.5 w-4.5" />
              </span>
              <div className="leading-tight">
                <h2 className="text-sm font-bold">Password</h2>
                <p className="text-xs text-[var(--muted)]">Change the password you sign in with.</p>
              </div>
            </div>
            {!changing && (
              <button
                onClick={() => {
                  setChanging(true);
                  setDone(false);
                  setError(null);
                }}
                className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold transition-all hover:border-[var(--accent)]"
              >
                Change
              </button>
            )}
          </div>

          {done && (
            <div className="mt-4 rounded-xl border border-[var(--pos)]/30 bg-[var(--pos)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--pos)]">
              Password updated.
            </div>
          )}

          {changing && (
            <form onSubmit={submitChange} className="mt-5 space-y-4">
              {error && (
                <div className="rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
                  {error}
                </div>
              )}
              <div className="space-y-1.5">
                <label className="block text-sm font-semibold">Current password</label>
                <PasswordInput
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder="Your current password"
                  autoComplete="current-password"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold">New password</label>
                  <PasswordInput
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold">Confirm new</label>
                  <PasswordInput
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    placeholder="Re-enter new password"
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Update password
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChanging(false);
                    setError(null);
                    setNewPw("");
                    setConfirmPw("");
                    setCurrentPw("");
                  }}
                  className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:bg-[var(--surface-2)]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
