import * as React from "react";

// Shared split-screen shell for the auth pages (login / forgot / reset):
// a branded gradient panel on the left and the form content on the right.
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Left brand panel (desktop only) */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-gradient-to-br from-[var(--accent)] to-indigo-700 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-lg font-black backdrop-blur">
            S
          </div>
          <span className="text-xl font-extrabold tracking-tight">Senthra</span>
        </div>

        <div>
          <h1 className="max-w-md text-4xl font-extrabold leading-[1.15] tracking-tight">
            Effortlessly manage your business and operations.
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
            Sign in to access your admin dashboard and run everything from one
            place.
          </p>
        </div>

        <div className="flex items-center justify-between text-xs text-white/70">
          <span>© 2026 Senthra. All rights reserved.</span>
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
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-indigo-600 font-black text-white">
              S
            </div>
            <span className="text-lg font-extrabold text-[var(--ink)]">
              Senthra
            </span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
