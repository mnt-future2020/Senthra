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
        <div className="flex items-center gap-4">
          <BrandMark
            className="h-16 w-16 rounded-2xl text-3xl shadow-lg ring-1 ring-white/20"
            variant="translucent"
          />
          <span className="text-2xl font-extrabold tracking-tight">{brandName}</span>
        </div>

        <div>
          <h1 className="max-w-md text-4xl font-extrabold leading-[1.15] tracking-tight">
            {loginHeadline}
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
            {loginSubtext}
          </p>
        </div>

        {/*
          NO PRIVACY LINK HERE — deliberately.

          The notice at /privacy is a DRAFT: its lawful bases, retention periods, controller identity
          and rights-contact are unresolved placeholders awaiting legal sign-off. Linking to it from
          the public sign-in screen would publish an unapproved document as this product's privacy
          policy, which is worse than having no link at all.

          The route still exists and is reachable directly, so the draft can be reviewed.

          TO RESTORE once the notice is approved — put back:
            <Link href="/privacy" className="transition-colors hover:text-white">Privacy Notice</Link>
          alongside the footer text below, and re-add the next/link import.
        */}
        <div className="flex items-center text-xs text-white/70">
          <span>{footerText}</span>
        </div>
      </div>

      {/* Right content panel */}
      <div className="flex w-full items-center justify-center bg-[var(--surface)] px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile brand */}
          <div className="mb-8 flex items-center justify-center gap-2.5 lg:hidden">
            <BrandMark className="h-12 w-12 rounded-2xl text-xl shadow-sm" />
            <span className="text-xl font-extrabold text-[var(--ink)]">
              {brandName}
            </span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
