"use client";

import * as React from "react";
import { Lock } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

// In-dashboard page guard: renders children only if the principal holds ANY of
// the given permissions (the super-admin holds all). Otherwise it shows a neutral
// "no access" panel — so a direct URL to a feature you lack degrades cleanly
// instead of rendering a half-broken page. The API enforces the real rule
// regardless; this is the matching client-side courtesy.
export function PermissionGate({
  anyOf,
  children,
}: {
  anyOf: string[];
  children: React.ReactNode;
}) {
  const { can } = useAuth();

  if (anyOf.some((p) => can(p))) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-[var(--muted)]">
        <Lock className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-bold text-[var(--ink)]">
          You don&apos;t have access to this page
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Ask an administrator if you think you need it.
        </p>
      </div>
    </div>
  );
}
