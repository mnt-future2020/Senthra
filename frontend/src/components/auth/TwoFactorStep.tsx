"use client";

import * as React from "react";
import { Loader2, MailCheck } from "lucide-react";

import * as authService from "@/services/auth.service";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { authInputCls } from "@/components/auth/styles";
import type { Principal, TwoFactorPending } from "@/types/auth";

/**
 * The server's remaining-seconds, re-expressed as instants on THIS BROWSER's clock.
 *
 * Anchoring at the moment the server answered is the whole point. The server sends durations
 * precisely so the two clocks never have to agree: everything below is measured as time elapsed
 * here since `atMs`, so a device running minutes fast or slow still counts down the cooldown and
 * the expiry the server is actually enforcing. Comparing a server-sent absolute instant against
 * `Date.now()` instead is what left a slow device with "Resend" locked past the challenge's own
 * expiry — every route to a working code closed at once.
 *
 * Re-anchored on every fresh description of the challenge (mount, refresh, resend), so a page
 * reload resumes the real remainder rather than restarting a fresh 60s.
 */
export function deadlinesFrom(
  pending: Pick<TwoFactorPending, "resendInSeconds" | "expiresInSeconds">,
  atMs: number,
): { resendAtMs: number; expiresAtMs: number } {
  return {
    resendAtMs: atMs + pending.resendInSeconds * 1000,
    expiresAtMs: atMs + pending.expiresInSeconds * 1000,
  };
}

/** Whole seconds from now to a deadline, never negative. Rounded UP so nothing unlocks a tick early. */
export function secondsUntil(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** 605 -> "10:05". Seconds always two digits, so the line doesn't jitter as it counts down. */
export function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  /** The pending challenge as the server last described it. */
  pending: TwoFactorPending;
  /**
   * `Date.now()` at the moment `pending` arrived, captured by whoever received it.
   *
   * It belongs to the caller rather than being read here because the answer is only knowable where
   * the response landed — and because reading the clock during render would make this component
   * impure. Everything below is measured as time elapsed since this instant.
   */
  receivedAtMs: number;
  /** Replaces the local copy after a resend, so the cooldown tracks the new send. */
  onPendingChange: (pending: TwoFactorPending) => void;
  onVerified: (principal: Principal) => void;
  /** Return to the credential form. `reason` is shown there when the server ended the challenge. */
  onBack: (reason?: string) => void;
};

export function TwoFactorStep({
  pending,
  receivedAtMs,
  onPendingChange,
  onVerified,
  onBack,
}: Props) {
  // Completion goes through AuthProvider, never straight to the service: that is where the
  // principal and the sign-out bookkeeping live, and authenticated state belongs in one place.
  const { completeTwoFactor } = useAuth();

  const [code, setCode] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Pure: both inputs are props, so this recomputes exactly when the server re-describes the
  // challenge — a resend, or the login page's probe after a refresh — and never otherwise.
  const deadlines = React.useMemo(
    () => deadlinesFrom(pending, receivedAtMs),
    [pending, receivedAtMs],
  );

  /**
   * `now`, but never earlier than the anchor — elapsed time since the anchor cannot be negative.
   *
   * The ticking `now` and `receivedAtMs` are read from the clock at different moments, so either can
   * be the staler of the two, and `secondsUntil` rounds any leftover fraction UP. Unclamped, both
   * orderings showed a second that was never real: a resend answered between ticks left `now`
   * BEHIND the fresh anchor and rendered "Resend in 61s" for a challenge the server had capped at
   * 60. Clamping makes the countdown start at exactly what the server said and only ever fall.
   */
  const elapsedFrom = Math.max(now, receivedAtMs);

  const remaining = secondsUntil(deadlines.resendAtMs, elapsedFrom);
  const expiresIn = secondsUntil(deadlines.expiresAtMs, elapsedFrom);
  const resendsLeft = pending.resendsRemaining;

  /**
   * 410 Gone = the challenge is finished (too many wrong codes, expired, already used).
   *
   * Nothing on this step can succeed any more, so staying here strands the user: Verify keeps
   * failing and Resend silently does nothing. Go back to the credential form and carry the reason
   * with us, so they read "too many incorrect codes, sign in again" instead of a dead screen.
   */
  const handledAsEnded = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 410) {
      onBack(err.message);
      return true;
    }
    return false;
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      onVerified(await completeTwoFactor(code));
    } catch (err) {
      if (handledAsEnded(err)) return;
      setError(err instanceof Error ? err.message : "Verification failed.");
      // Clear the field so the next attempt starts clean rather than editing a rejected code.
      setCode("");
      setSubmitting(false);
    }
    // Deliberately no `finally`: on success the page navigates away, and re-enabling the button
    // first would flash an active form over a screen that is already leaving.
  };

  const resend = async () => {
    setError(null);
    setResending(true);
    try {
      onPendingChange(await authService.resendTwoFactor());
      setCode("");
    } catch (err) {
      if (handledAsEnded(err)) return;
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  };

  // Best-effort: the user is NOT authenticated, so a network failure must never trap them on this
  // step. A challenge left behind expires on its own, and the next sign-in supersedes it anyway.
  const back = async () => {
    try {
      await authService.cancelTwoFactor();
    } catch {
      // ignored on purpose — see above
    }
    onBack();
  };

  return (
    <>
      <h2 className="text-center text-2xl font-extrabold tracking-tight text-[var(--ink)]">
        Check your email
      </h2>
      <p className="mt-2 text-center text-sm text-[var(--muted)]">
        We sent a 6-digit code to{" "}
        <span className="font-semibold text-[var(--ink)]">{pending.email}</span>.
      </p>

      {error && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]"
        >
          {error}
        </div>
      )}

      <form onSubmit={verify} className="mt-7 space-y-5">
        <div className="space-y-1.5">
          <label
            htmlFor="two-factor-code"
            className="block text-sm font-semibold text-[var(--ink)]"
          >
            Verification code
          </label>
          <input
            id="two-factor-code"
            type="text"
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className={`${authInputCls} text-center text-lg tracking-[0.4em]`}
          />
          {/* The challenge's own lifetime. Shown because without it an expiry is invisible until the
              user submits and is bounced back to the password form with no idea why the code they
              were carefully typing stopped working. Deliberately NOT a live region: announcing a
              ticking number once a second would make the step unusable with a screen reader. */}
          {/* Once it expires there is exactly ONE route, whatever resends are nominally left:
              expiry deletes the whole challenge server-side (findLive prunes an elapsed row), so
              Resend has nothing to attach a new code to and answers 410. Offering "request a new
              one" here sent the user to press a button that could only ever bounce them back to the
              password form — worded as a promise, delivered as a rejection. */}
          <p className="pt-0.5 text-center text-xs text-[var(--muted)]">
            {expiresIn > 0
              ? `Expires in ${formatCountdown(expiresIn)}`
              : "This code has expired. Please sign in again."}
          </p>
        </div>

        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Verifying…" : "Verify"}
        </button>
      </form>

      <div className="mt-6 flex items-center justify-between gap-3 text-sm">
        <button
          type="button"
          onClick={back}
          className="font-semibold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
        >
          Back to sign in
        </button>
        <button
          type="button"
          onClick={resend}
          disabled={remaining > 0 || resending || resendsLeft <= 0}
          className="flex items-center gap-1.5 font-semibold text-[var(--accent)] transition-colors hover:opacity-80 disabled:text-[var(--faint)]"
        >
          {resending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
          {resendsLeft <= 0
            ? "No codes left"
            : remaining > 0
              ? `Resend in ${remaining}s`
              : "Resend code"}
        </button>
      </div>
    </>
  );
}
