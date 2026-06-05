"use client";

import { ShieldCheck } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";

// The dashboard landing for an authenticated user who holds no section permissions
// yet. Renders inside the shell (sidebar + topbar present, but the nav is empty),
// so the experience degrades cleanly instead of bouncing them out of the app.
export function NoAccessHome() {
  const { user } = useAuth();
  const { brandName } = useBranding();
  const name = user?.firstName ?? "there";

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-10)] text-[var(--accent)]">
        <ShieldCheck className="h-6 w-6" />
      </span>
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-extrabold text-[var(--ink)]">You&apos;re all set, {name}</h1>
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          Your {brandName} account is active, but you haven&apos;t been granted access to any
          modules yet. Your administrator will assign your permissions — the tools for your
          role will appear here as soon as they do.
        </p>
        <p className="text-xs text-[var(--muted)]">
          You can update your password and manage your signed-in devices any time from{" "}
          <span className="font-semibold text-[var(--ink)]">My account</span> in the menu.
        </p>
      </div>
    </div>
  );
}
