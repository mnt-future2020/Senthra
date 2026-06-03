"use client";

import * as React from "react";

import {
  BrandingContext,
  type BrandingState,
} from "@/providers/BrandingProvider";

export function useBranding(): BrandingState {
  const ctx = React.useContext(BrandingContext);
  if (!ctx) throw new Error("useBranding must be used within a BrandingProvider");
  return ctx;
}
