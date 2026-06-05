"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";
import { firstDashboardPath } from "@/types/auth";
import { NoAccessHome } from "@/components/dashboard/shell/NoAccessHome";

// The dashboard landing. It has no screen of its own — it forwards each principal
// to the first section they can open (Settings, Users, …). A user with no section
// permissions gets the no-access home instead of an endless redirect.
export default function DashboardIndexPage() {
  const { principal, loading } = useAuth();
  const router = useRouter();
  const target = firstDashboardPath(principal);

  React.useEffect(() => {
    if (!loading && target) router.replace(target);
  }, [loading, target, router]);

  // While loading, the layout's skeleton is already showing; render nothing. If a
  // target exists we're redirecting; otherwise show the no-access home.
  if (loading || target) return null;
  return <NoAccessHome />;
}
