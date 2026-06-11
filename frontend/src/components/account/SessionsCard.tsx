"use client";

import * as React from "react";
import { Loader2, LogOut, Monitor, MonitorSmartphone, Smartphone } from "lucide-react";

import * as authService from "@/services/auth.service";
import type { DeviceSession } from "@/types/auth";
import { Skeleton } from "@/components/ui/Skeleton";
import { AccountCard } from "./AccountCard";

// Best-effort, dependency-free user-agent label (e.g. "Chrome on Windows").
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg/i.test(ua)
    ? "Edge"
    : /OPR|Opera/i.test(ua)
      ? "Opera"
      : /Chrome|CriOS/i.test(ua)
        ? "Chrome"
        : /Firefox|FxiOS/i.test(ua)
          ? "Firefox"
          : /Safari/i.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

// Phone-shaped glyph for mobile user-agents, monitor for everything else.
function isMobile(ua: string | null): boolean {
  return !!ua && /Android|iPhone|iPad|iOS|Mobile/i.test(ua);
}

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function SessionsCard({ style }: { style?: React.CSSProperties }) {
  // Seed from the cache so a revisit shows the last-known devices instantly (no
  // skeleton); the effect below still refetches to revalidate.
  const [sessions, setSessions] = React.useState<DeviceSession[] | null>(
    () => authService.getCachedSessions(),
  );
  const [revoking, setRevoking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setSessions(await authService.getSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  // Initial fetch — setState lands in the promise callback (deferred), never
  // synchronously inside the effect.
  React.useEffect(() => {
    let active = true;
    authService
      .getSessions()
      .then((data) => {
        if (active) setSessions(data);
      })
      .catch(() => {
        if (active) setSessions([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  const revokeOthers = async () => {
    setRevoking(true);
    setError(null);
    try {
      await authService.revokeOtherSessions();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign out the other devices.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <AccountCard
      icon={MonitorSmartphone}
      title="Devices"
      desc="Where you're signed in. Up to 2 devices — a new sign-in drops the oldest."
      style={style}
      action={
        sessions && sessions.length > 0 ? (
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-extrabold tabular-nums text-[var(--muted)]">
            {sessions.length}/2
          </span>
        ) : null
      }
    >
      {sessions === null ? (
        <div className="space-y-2.5">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3"
            >
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-32 rounded" />
                <Skeleton className="h-2.5 w-44 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="py-2 text-xs text-[var(--faint)]">No active devices.</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2.5">
            {sessions.map((s) => {
              const Icon = isMobile(s.userAgent) ? Smartphone : Monitor;
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 transition-colors hover:border-[var(--border-2)]"
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                      s.current
                        ? "bg-[var(--accent-10)] text-[var(--accent)]"
                        : "bg-[var(--surface)] text-[var(--muted)]"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-bold text-[var(--ink)]">
                      <span className="truncate">{deviceLabel(s.userAgent)}</span>
                      {s.current && (
                        <span className="shrink-0 rounded-full bg-[var(--pos)]/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--pos)]">
                          This device
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                      {s.ip || "Unknown IP"} · Active {relativeTime(s.lastUsedAt)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {others > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={revokeOthers}
                disabled={revoking}
                className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)] disabled:opacity-60"
              >
                {revoking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="h-3.5 w-3.5" />
                )}
                Sign out other device{others === 1 ? "" : "s"} ({others})
              </button>
              {error && (
                <p className="text-xs font-semibold text-[var(--neg)]">{error}</p>
              )}
            </div>
          )}
        </div>
      )}
    </AccountCard>
  );
}
