"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as authService from "@/services/auth.service";

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

export default function LoginPage() {
  const { admin, loading, login, loginWithGoogle } = useAuth();
  const router = useRouter();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [googleEnabled, setGoogleEnabled] = React.useState(false);
  const [googleClientId, setGoogleClientId] = React.useState<string | null>(null);
  const [gsiLoaded, setGsiLoaded] = React.useState(false);
  // Whether the /auth/google/config check has finished. Until it has, we reserve
  // the Google section's space with a skeleton so it doesn't blink/jump in.
  const [googleChecked, setGoogleChecked] = React.useState(false);
  const googleBtnRef = React.useRef<HTMLDivElement>(null);

  // Already logged in → go to the dashboard.
  React.useEffect(() => {
    if (!loading && admin) router.replace("/dashboard");
  }, [loading, admin, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password, remember);
      router.replace("/dashboard");
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
          await loginWithGoogle(resp.credential);
          router.replace("/dashboard");
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
    <div className="flex min-h-screen">
      {/* Left brand panel (desktop only) */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-gradient-to-br from-[var(--accent)] to-indigo-700 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-lg font-black backdrop-blur">
            S
          </div>
          <span className="text-xl font-extrabold tracking-tight">Senthra</span>
        </div>

        <div>
          <h1 className="max-w-md text-4xl font-extrabold leading-[1.15] tracking-tight">
            Effortlessly manage your business and operations.
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
            Sign in to access your admin dashboard and run everything from one
            place.
          </p>
        </div>

        <div className="flex items-center justify-between text-xs text-white/70">
          <span>© 2026 Senthra. All rights reserved.</span>
          <a href="#" className="transition-colors hover:text-white">
            Privacy Policy
          </a>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex w-full items-center justify-center bg-[var(--surface)] px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile brand */}
          <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-indigo-600 font-black text-white">
              S
            </div>
            <span className="text-lg font-extrabold text-[var(--ink)]">
              Senthra
            </span>
          </div>

          <h2 className="text-center text-2xl font-extrabold tracking-tight text-[var(--ink)]">
            Welcome Back
          </h2>
          <p className="mt-2 text-center text-sm text-[var(--muted)]">
            Enter your email and password to access your account.
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
        </div>
      </div>
    </div>
  );
}
