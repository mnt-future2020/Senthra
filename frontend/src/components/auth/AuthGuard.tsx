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
//  - No flags: requires an authenticated admin or staff user — the shared dashboard
//    shell. A customer is NOT allowed here (they have their own /customer portal)
//    and is bounced to their home, so the admin chrome never renders for them.
//  - requireType: also require an exact account type; a mismatch is sent to its home.
//    (The /customer portal passes requireType="customer".)
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

  // Allowed iff: signed in AND (matches requireType, when set) AND (when no
  // requireType — the shared dashboard — the principal is not a customer).
  const typeOk = principal
    ? requireType
      ? principal.type === requireType
      : principal.type !== "customer"
    : false;

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
