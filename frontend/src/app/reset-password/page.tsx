"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";

import * as authService from "@/services/auth.service";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { authInputCls, authPrimaryBtn } from "@/components/auth/authStyles";

// Password field with a built-in show/hide toggle.
function PasswordField({
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete: string;
}) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${authInputCls} pr-10`}
      />
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

function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");

  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) return;
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await authService.resetPassword(token, password);
      setDone(true);
      // Send them to login shortly after confirming success.
      setTimeout(() => router.replace("/login"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setSubmitting(false);
    }
  };

  // No token in the URL → the link is malformed.
  if (!token) {
    return (
      <AuthLayout>
        <div className="text-center">
          <h2 className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">
            Invalid reset link
          </h2>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--muted)]">
            This link is missing or malformed. Please request a new password
            reset.
          </p>
          <Link
            href="/forgot-password"
            className="mt-7 inline-flex items-center gap-2 text-sm font-bold text-[var(--accent)] transition-colors hover:opacity-80"
          >
            Request a new link
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout>
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--pos)]/10 text-[var(--pos)]">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">
            Password reset
          </h2>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--muted)]">
            Your password has been updated. Redirecting you to sign in…
          </p>
          <Link
            href="/login"
            className="mt-7 inline-flex items-center gap-2 text-sm font-bold text-[var(--accent)] transition-colors hover:opacity-80"
          >
            Go to login
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="text-center text-2xl font-extrabold tracking-tight text-[var(--ink)]">
        Set a new password
      </h2>
      <p className="mt-2 text-center text-sm text-[var(--muted)]">
        Choose a strong password you don&apos;t use elsewhere. Minimum 8
        characters.
      </p>

      {error && (
        <div className="mt-6 rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-7 space-y-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-semibold text-[var(--ink)]">
            New password
          </label>
          <PasswordField
            value={password}
            onChange={setPassword}
            placeholder="Enter new password"
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-semibold text-[var(--ink)]">
            Confirm new password
          </label>
          <PasswordField
            value={confirm}
            onChange={setConfirm}
            placeholder="Re-enter new password"
            autoComplete="new-password"
          />
        </div>

        <button type="submit" disabled={submitting} className={authPrimaryBtn}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Resetting…" : "Reset password"}
        </button>
      </form>

      <Link
        href="/login"
        className="mt-7 flex items-center justify-center gap-2 text-sm font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to login
      </Link>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <ResetPasswordInner />
    </React.Suspense>
  );
}
