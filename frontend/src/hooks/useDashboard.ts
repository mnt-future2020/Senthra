"use client";

import * as React from "react";

import {
  DashboardContext,
  type DashboardContextValue,
} from "@/providers/DashboardProvider";

export function useDashboard(): DashboardContextValue {
  const ctx = React.useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within a DashboardProvider");
  }
  return ctx;
}
