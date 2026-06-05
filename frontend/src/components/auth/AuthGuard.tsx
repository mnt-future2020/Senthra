"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { canAccessDashboard, homeFor } from "@/types/auth";

// Gate a protected area. While the session is verified — or once it's found to be
// invalid / not allowed here (until the redirect lands) — we render a neutral
// full-screen loader, NOT the app chrome, so a visitor never sees content they
// shouldn't. Redirects to /login when unauthenticated.
//
//  - requireType: exact account type (used by the staff portal).
//  - requireDashboard: admin OR a staff user with any dashboard permission
//    (permission-less staff are sent to /portal).
export function AuthGuard({
  children,
  requireType,
  requireDashboard,
}: {
  children: React.ReactNode;
  requireType?: "admin" | "user";
  requireDashboard?: boolean;
}) {
  const { principal, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    if (!principal) {
      router.replace("/login");
      return;
    }
    if (requireDashboard && !canAccessDashboard(principal)) {
      router.replace("/portal");
      return;
    }
    if (requireType && principal.type !== requireType) {
      router.replace(homeFor(principal));
    }
  }, [loading, principal, requireType, requireDashboard, router]);

  const allowed =
    principal &&
    (!requireType || principal.type === requireType) &&
    (!requireDashboard || canAccessDashboard(principal));

  if (loading || !allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
      </div>
    );
  }

  return <>{children}</>;
}
