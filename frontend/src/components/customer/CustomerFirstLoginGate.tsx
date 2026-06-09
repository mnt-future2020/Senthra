"use client";

import * as React from "react";

import { useAuth } from "@/hooks/useAuth";
import { SetPasswordScreen } from "@/components/account/SetPasswordScreen";

// Forces a first-login customer (mustResetPassword) onto the set-password screen
// before any portal chrome renders. Mirrors the staff FirstLoginGate; sits just
// inside the portal's AuthGuard, so the customer principal is already resolved.
export function CustomerFirstLoginGate({ children }: { children: React.ReactNode }) {
  const { customer } = useAuth();
  if (customer?.mustResetPassword) return <SetPasswordScreen />;
  return <>{children}</>;
}
