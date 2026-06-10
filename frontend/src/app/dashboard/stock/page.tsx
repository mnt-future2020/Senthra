"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";
import { MyStockView } from "@/components/dashboard/stock/MyStockView";

// The read-only customer "My Stock" section, inside the shared dashboard shell.
// Only a customer principal has stock to show — a staff user / admin who lands here
// (no customer context) is sent back to their own dashboard landing.
export default function StockPage() {
  const { principal, loading } = useAuth();
  const router = useRouter();
  const isCustomer = principal?.type === "customer";

  React.useEffect(() => {
    if (!loading && principal && !isCustomer) router.replace("/dashboard");
  }, [loading, principal, isCustomer, router]);

  if (!isCustomer) return null;
  return <MyStockView />;
}
