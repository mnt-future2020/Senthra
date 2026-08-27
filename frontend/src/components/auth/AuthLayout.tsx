"use client";

import * as React from "react";
import Link from "next/link";

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
          The privacy notice is linked from HERE because this is where personal data is collected.

          A notice nobody can reach is not a notice. The sign-in screen is the point of collection, so
          it is the place a data-protection notice is expected to be reachable from — not a URL you
          have to already know.

          This link was previously removed, correctly at the time: /privacy then rendered policy text
          hardcoded in the page, with placeholder lawful bases and retention periods awaiting legal
          sign-off, so linking to it would have published an unapproved document as this product's
          policy. That is no longer how the page works. It now renders ONLY what somebody holding
          `policy.publish` deliberately published (Settings → Privacy Policy), it ships no policy text
          of its own, and with nothing published it says so rather than falling back to a draft.

          What this link shows is therefore whatever the operator published — which is exactly what a
          privacy link should show. Keeping the published content correct is an operational
          responsibility, not something to solve by hiding the link.
        */}
        {/* `justify-between` — the layout this footer had before the link was pulled: copyright at
            the left edge of the panel, notice at the right. Restored rather than re-invented, so the
            sign-in screen looks the way it was designed to. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-white/70">
          <span>{footerText}</span>
          <Link href="/privacy" className="transition-colors hover:text-white">
            Privacy Notice
          </Link>
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
