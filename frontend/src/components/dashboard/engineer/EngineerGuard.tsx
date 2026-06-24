"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";

// Wraps every Engineer Portal page. Unlike the customer portal (gated by principal TYPE), the engineer
// is a STAFF user — so the gate is a permission. A staff user who lacks it (or an admin previewing a
// portal route they don't hold) is sent back to their own dashboard landing. Renders nothing until the
// principal resolves so the page never flashes for the wrong audience.
export function EngineerGuard({
  perm = "engineer.dashboard.view",
  children,
}: {
  perm?: string;
  children: React.ReactNode;
}) {
  const { can, principal, loading } = useAuth();
  const router = useRouter();
  // Mirror the Sidebar gate: the engineer portal is for STAFF users (principal.type === "user")
  // who hold the permission. The super-admin (type "admin") is intentionally excluded even though
  // its "*" satisfies `can(perm)` — otherwise it could reach these routes by URL with no engineer
  // nav to navigate within them.
  const allowed = principal?.type === "user" && can(perm);

  React.useEffect(() => {
    if (!loading && principal && !allowed) router.replace("/dashboard");
  }, [loading, principal, allowed, router]);

  if (!allowed) return null;
  return <>{children}</>;
}
