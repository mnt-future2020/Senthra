"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";
import { canSeeOverview, firstDashboardPath } from "@/lib/auth";
import { OverviewView } from "@/components/dashboard/home/OverviewView";

// The dashboard landing is the staff Overview screen — but only for a staff user who actually has
// Overview content (canSeeOverview). Anyone else is forwarded to their own first section instead of
// being shown the Overview's empty-state: customers → /dashboard/portal, a pure engineer →
// /dashboard/engineer, an Overview-blind admin role (e.g. Users-only) → its first real section.
// firstDashboardPath returns exactly that target (or null → genuinely no access → NoAccessHome).
export default function DashboardIndexPage() {
  const { principal, loading } = useAuth();
  const router = useRouter();

  const showOverview = canSeeOverview(principal);
  // Redirect target for principals who don't belong on the Overview. null when they either DO see the
  // Overview or have no section at all (the latter falls through to OverviewView → NoAccessHome).
  const redirectTo = !showOverview ? firstDashboardPath(principal) : null;

  React.useEffect(() => {
    if (!loading && redirectTo) router.replace(redirectTo);
  }, [loading, redirectTo, router]);

  // While loading, the layout skeleton is already showing; render nothing. Redirecting principals
  // also render nothing until the replace lands. Staff with Overview content — and genuinely
  // no-access users (redirectTo null) — render OverviewView (which shows NoAccessHome for the latter).
  if (loading || redirectTo) return null;
  return <OverviewView />;
}
