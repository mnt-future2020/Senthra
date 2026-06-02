"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";

import { api } from "@/lib/api";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { authInputCls, authPrimaryBtn } from "@/components/auth/authStyles";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api("/auth/forgot-password", {
        method: "POST",
        body: { email },
      });
      // The API always responds generically (no email enumeration), so success
      // here just means the request was accepted.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout>
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)]/10 text-[var(--accent)]">
            <MailCheck className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">
            Check your email
          </h2>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--muted)]">
            If <span className="font-semibold text-[var(--ink)]">{email}</span>{" "}
            is registered, we&apos;ve sent a link to reset your password. It is
            valid for 1 hour.
          </p>
          <Link
            href="/login"
            className="mt-7 inline-flex items-center gap-2 text-sm font-bold text-[var(--accent)] transition-colors hover:opacity-80"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to login
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="text-center text-2xl font-extrabold tracking-tight text-[var(--ink)]">
        Forgot password?
      </h2>
      <p className="mt-2 text-center text-sm text-[var(--muted)]">
        Enter your email and we&apos;ll send you a link to reset your password.
      </p>

      {error && (
        <div className="mt-6 rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-7 space-y-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-semibold text-[var(--ink)]">
            Email
          </label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@company.com"
            className={authInputCls}
          />
        </div>

        <button type="submit" disabled={submitting} className={authPrimaryBtn}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Sending…" : "Send reset link"}
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
