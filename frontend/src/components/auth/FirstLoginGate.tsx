"use client";

import * as React from "react";

import { useAuth } from "@/hooks/useAuth";
import { SetPasswordScreen } from "@/components/account/SetPasswordScreen";

// Forces a first-login staff user (mustResetPassword) onto the set-password screen
// before any dashboard chrome renders. Sits just inside AuthGuard, so the principal
// is already resolved here. The admin account never has mustResetPassword, so it
// passes straight through.
export function FirstLoginGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.mustResetPassword) return <SetPasswordScreen />;
  return <>{children}</>;
}
