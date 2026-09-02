"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, MonitorSmartphone } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as authService from "@/services/auth.service";
import { homeFor } from "@/lib/auth";
import { takeSignedOutNotice, type SignedOutNotice } from "@/lib/signedOutNotice";
import { AuthLayout } from "@/components/auth/AuthLayout";

// Minimal typing for the Google Identity Services global.
type GoogleId = {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (resp: { credential: string }) => void;
      }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
};
declare global {
  interface Window {
    google?: GoogleId;
  }
}

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)]";

// One-tap login shortcuts. Credentials come from NEXT_PUBLIC_QUICK_* env vars and are NEVER
// hardcoded in source — a password in a file is a password in git history, permanently, however
// short-lived the account turns out to be.
//
// A button renders only when BOTH its email and password vars are set, so an unset pair simply
// hides that shortcut and a build with no vars at all shows nothing.
//
// ── Read this before turning it on anywhere but your own machine ──────────────────────────────
// `NEXT_PUBLIC_*` is INLINED INTO THE CLIENT BUNDLE at build time. It is not a secret and cannot
// be made one: anyone who opens the page reads every credential here in devtools.
//
// Note what that means for the switch below — it decides whether the BUTTONS render, and nothing
// more. A build with QUICK_LOGIN unset but the pairs set still ships those passwords (confirmed by
// grepping .next/static after such a build). The only thing that keeps a credential out of a
// bundle is not setting it for that build.
//
// Fine for a throwaway demo whose accounts and data are disposable. Not fine pointed at anything
// you would mind a stranger signing into.
const QUICK_LOGINS: { label: string; email?: string; password?: string }[] = [
  { label: "🔑 Admin", email: process.env.NEXT_PUBLIC_QUICK_ADMIN_EMAIL, password: process.env.NEXT_PUBLIC_QUICK_ADMIN_PASSWORD },
  { label: "👤 Customer", email: process.env.NEXT_PUBLIC_QUICK_CUSTOMER_EMAIL, password: process.env.NEXT_PUBLIC_QUICK_CUSTOMER_PASSWORD },
  { label: "🧑‍🔧 Engineer", email: process.env.NEXT_PUBLIC_QUICK_ENGINEER_EMAIL, password: process.env.NEXT_PUBLIC_QUICK_ENGINEER_PASSWORD },
  { label: "💷 Finance", email: process.env.NEXT_PUBLIC_QUICK_FINANCE_EMAIL, password: process.env.NEXT_PUBLIC_QUICK_FINANCE_PASSWORD },
  { label: "📋 PM", email: process.env.NEXT_PUBLIC_QUICK_PM_EMAIL, password: process.env.NEXT_PUBLIC_QUICK_PM_PASSWORD },
].filter((q) => q.email && q.password);

/**
 * Whether to offer the shortcuts at all.
 *
 * Local dev keeps working with nothing to set, as before. Any OTHER build — the client demo
 * included — has to ask for them explicitly with NEXT_PUBLIC_QUICK_LOGIN=true, so the real
 * production deployment gets them by NOT opting in rather than by remembering to opt out. That
 * ordering is the whole point: a build that forgets this variable shows no shortcuts, even if the
 * credentials are still sitting in its environment.
 */
const QUICK_LOGIN_ENABLED =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_QUICK_LOGIN === "true";

export default function LoginPage() {
  const { principal, loading, login, loginWithGoogle } = useAuth();
  const router = useRouter();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Why the user landed back here, if they didn't arrive under their own steam — set by
  // AuthProvider when the server revokes this device's session (the one-device cap, "sign out
  // other devices", a password change). Read once and consumed, so a refresh clears it.
  const [signedOutNotice, setSignedOutNoticeState] = React.useState<SignedOutNotice | null>(null);

  const [googleEnabled, setGoogleEnabled] = React.useState(false);
  const [googleClientId, setGoogleClientId] = React.useState<string | null>(null);
  const [gsiLoaded, setGsiLoaded] = React.useState(false);
  // Whether the /auth/google/config check has finished. Until it has, we reserve
  // the Google section's space with a skeleton so it doesn't blink/jump in.
  const [googleChecked, setGoogleChecked] = React.useState(false);
  const googleBtnRef = React.useRef<HTMLDivElement>(null);

  // Already logged in → go to the right home for the account type.
  React.useEffect(() => {
    if (!loading && principal) router.replace(homeFor(principal));
  }, [loading, principal, router]);

  // sessionStorage is client-only, so this reads after mount rather than during render (a lazy
  // useState initialiser would run on the server too and hydrate mismatched). The microtask keeps
  // setState out of the effect body, and only a NON-null result is stored: takeSignedOutNotice
  // consumes the value, so under StrictMode's double-invoked effect the second pass finds nothing
  // and must leave the message the first pass found alone.
  React.useEffect(() => {
    void Promise.resolve().then(() => {
      const notice = takeSignedOutNotice();
      if (notice) setSignedOutNoticeState(notice);
    });
  }, []);

  // Dev quick-login: fill the creds + submit (used only by the dev-gated buttons below).
  const quickLogin = (em: string, pw: string) => {
    setEmail(em);
    setPassword(pw);
    setTimeout(() => document.querySelector<HTMLFormElement>("form")?.requestSubmit(), 50);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSignedOutNoticeState(null);
    setSubmitting(true);
    try {
      const next = await login(email, password, remember);
      router.replace(homeFor(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  };

  // 1. Fetch the Google config and make sure the GIS script is loaded.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await authService.getGoogleConfig();
        if (cancelled) return;
        if (cfg.enabled && cfg.clientId) {
          setGoogleClientId(cfg.clientId);
          setGoogleEnabled(true);

          if (window.google?.accounts?.id) {
            setGsiLoaded(true);
          } else {
            const SRC = "https://accounts.google.com/gsi/client";
            const existing = document.querySelector<HTMLScriptElement>(
              `script[src="${SRC}"]`,
            );
            if (existing) {
              existing.addEventListener("load", () => {
                if (!cancelled) setGsiLoaded(true);
              });
            } else {
              const script = document.createElement("script");
              script.src = SRC;
              script.async = true;
              script.defer = true;
              script.onload = () => {
                if (!cancelled) setGsiLoaded(true);
              };
              document.body.appendChild(script);
            }
          }
        }
      } catch {
        // Config endpoint unavailable — just skip the Google button.
      } finally {
        if (!cancelled) setGoogleChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Render the button once it's enabled, the script is ready, AND the
  //    container <div> is mounted. This effect runs after that render.
  React.useEffect(() => {
    if (!googleEnabled || !gsiLoaded || !googleClientId) return;
    if (!window.google?.accounts?.id || !googleBtnRef.current) return;
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async (resp) => {
        setError(null);
        try {
          const next = await loginWithGoogle(resp.credential);
          router.replace(homeFor(next));
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Google sign-in failed.",
          );
        }
      },
    });
    googleBtnRef.current.replaceChildren();
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      theme: "outline",
      size: "large",
      width: 340,
      text: "signin_with",
    });
  }, [googleEnabled, gsiLoaded, googleClientId, loginWithGoogle, router]);

  return (
    <AuthLayout>
      <h2 className="text-center text-2xl font-extrabold tracking-tight text-[var(--ink)]">
        Welcome Back
      </h2>
      <p className="mt-2 text-center text-sm text-[var(--muted)]">
        Enter your email and password to access your account.
      </p>

      {/* Styled as information, not as an error: nothing went wrong and the user did nothing wrong
          — they signed in somewhere else. A red failure banner here reads like a bug. Same
          icon-chip row as the Devices card in Settings, so the two places that talk about devices
          look like the same idea. Dropped the moment they submit, so a real login error is never
          stacked under it. */}
      {signedOutNotice && !error && (
        <div className="mt-6 flex items-start gap-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-10)] text-[var(--accent)]">
            <MonitorSmartphone className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-bold leading-snug text-[var(--ink)]">
              {signedOutNotice.title}
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--muted)]">
              {signedOutNotice.body}
            </p>
          </div>
        </div>
      )}

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
            className={inputCls}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-semibold text-[var(--ink)]">
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className={`${inputCls} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--faint)] transition-colors hover:text-[var(--ink)]"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--muted)]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded accent-[var(--accent)]"
            />
            Remember Me
          </label>
          <Link
            href="/forgot-password"
            className="text-sm font-semibold text-[var(--accent)] transition-colors hover:opacity-80"
          >
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Signing in…" : "Log In"}
        </button>
      </form>

      {/* Quick logins — dev, or a build that opted in with NEXT_PUBLIC_QUICK_LOGIN. Creds come from
          env vars, never source. See the note above QUICK_LOGINS. */}
      {QUICK_LOGIN_ENABLED && QUICK_LOGINS.length > 0 && (
        <div className="mt-6 space-y-2">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--faint)]">
              Quick login
            </span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <div className="flex gap-2">
            {QUICK_LOGINS.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={submitting}
                onClick={() => quickLogin(q.email!, q.password!)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {(!googleChecked || googleEnabled) && (
        <>
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--faint)]">
              Or login with
            </span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <div className="flex min-h-[40px] justify-center">
            {googleEnabled && gsiLoaded ? (
              <div ref={googleBtnRef} />
            ) : (
              <div className="h-[40px] w-full max-w-[340px] animate-pulse rounded-lg bg-[var(--surface-2)]" />
            )}
          </div>
        </>
      )}
    </AuthLayout>
  );
}
