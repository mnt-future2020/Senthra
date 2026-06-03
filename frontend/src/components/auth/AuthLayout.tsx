"use client";

import * as React from "react";

import { useBranding } from "@/hooks/useBranding";
import { BrandMark } from "@/components/branding/BrandMark";

// Shared split-screen shell for the auth pages (login / forgot / reset):
// a branded gradient panel on the left and the form content on the right.
export function AuthLayout({ children }: { children: React.ReactNode }) {
  const { brandName, footerText, loginHeadline, loginSubtext } = useBranding();

  return (
    <div className="flex min-h-screen">
      {/* Left brand panel (desktop only) */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-gradient-to-br from-[var(--accent)] to-indigo-700 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark
            className="h-10 w-10 rounded-xl text-lg"
            variant="translucent"
          />
          <span className="text-xl font-extrabold tracking-tight">{brandName}</span>
        </div>

        <div>
          <h1 className="max-w-md text-4xl font-extrabold leading-[1.15] tracking-tight">
            {loginHeadline}
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
            {loginSubtext}
          </p>
        </div>

        <div className="flex items-center justify-between text-xs text-white/70">
          <span>{footerText}</span>
          <a href="#" className="transition-colors hover:text-white">
            Privacy Policy
          </a>
        </div>
      </div>

      {/* Right content panel */}
      <div className="flex w-full items-center justify-center bg-[var(--surface)] px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile brand */}
          <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <BrandMark className="h-9 w-9 rounded-xl" />
            <span className="text-lg font-extrabold text-[var(--ink)]">
              {brandName}
            </span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
