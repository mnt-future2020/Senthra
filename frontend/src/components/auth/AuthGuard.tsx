"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

// Gate a protected area. While the session is verified — or once it's found to be
// invalid / the wrong account type (until the redirect lands) — we render a
// neutral full-screen loader, NOT the app chrome, so a visitor never sees content
// they shouldn't. Redirects to /login when unauthenticated. With `requireType`,
// also enforces the account type, sending the wrong type to its own home.
export function AuthGuard({
  children,
  requireType,
}: {
  children: React.ReactNode;
  requireType?: "admin" | "user";
}) {
  const { principal, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    if (!principal) {
      router.replace("/login");
      return;
    }
    if (requireType && principal.type !== requireType) {
      router.replace(principal.type === "admin" ? "/dashboard" : "/portal");
    }
  }, [loading, principal, requireType, router]);

  const allowed = principal && (!requireType || principal.type === requireType);
  if (loading || !allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
      </div>
    );
  }

  return <>{children}</>;
}
