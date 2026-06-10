"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { homeFor } from "@/lib/auth";

// Gate a protected area. While the session is being verified — or once it's found
// invalid / not allowed here (until the redirect lands) — we render a neutral
// placeholder, NOT the app chrome, so a visitor never sees content they shouldn't.
// Redirects to /login when unauthenticated.
//
//  - No flags: requires any authenticated principal (admin, staff user, or
//    customer) — everyone shares the dashboard shell; the sidebar nav and per-page
//    guards filter what each one can see.
//  - requireType: also require an exact account type; a mismatch is sent to its home.
//  - fallback: what to show while gating. Defaults to a centered spinner; the
//    dashboard passes a shell-shaped skeleton so the verified shell mounts with no
//    layout shift (no bare spinner → skeleton hop).
export function AuthGuard({
  children,
  requireType,
  fallback,
}: {
  children: React.ReactNode;
  requireType?: "admin" | "user" | "customer";
  fallback?: React.ReactNode;
}) {
  const { principal, loading } = useAuth();
  const router = useRouter();

  const typeOk = principal ? (!requireType || principal.type === requireType) : false;

  React.useEffect(() => {
    if (loading) return;
    if (!principal) {
      router.replace("/login");
      return;
    }
    if (!typeOk) {
      router.replace(homeFor(principal));
    }
  }, [loading, principal, typeOk, router]);

  const allowed = principal && typeOk;

  if (loading || !allowed) {
    if (fallback) return <>{fallback}</>;
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
      </div>
    );
  }

  return <>{children}</>;
}
