"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

// Gate the dashboard. While the session is verified — or once it's found to be
// invalid (until the redirect lands) — we render a neutral full-screen loader,
// NOT the dashboard shell, so an unauthenticated visitor never sees the app
// chrome or nav. Redirects to /login when the session is invalid.
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { admin, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !admin) router.replace("/login");
  }, [loading, admin, router]);

  if (loading || !admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
      </div>
    );
  }

  return <>{children}</>;
}
