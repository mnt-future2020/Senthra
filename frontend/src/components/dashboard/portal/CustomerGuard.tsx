"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";

// Wraps every customer-portal page. Only a customer principal has portal data — a
// staff user / admin who lands on a portal route (no customer context) is sent back
// to their own dashboard landing. Renders nothing until the principal resolves so
// the page never flashes for the wrong audience.
export function CustomerGuard({ children }: { children: React.ReactNode }) {
  const { principal, loading } = useAuth();
  const router = useRouter();
  const isCustomer = principal?.type === "customer";

  React.useEffect(() => {
    if (!loading && principal && !isCustomer) router.replace("/dashboard");
  }, [loading, principal, isCustomer, router]);

  if (!isCustomer) return null;
  return <>{children}</>;
}
