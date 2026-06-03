"use client";

import * as React from "react";

import { AuthContext, type AuthState } from "@/providers/AuthProvider";

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
