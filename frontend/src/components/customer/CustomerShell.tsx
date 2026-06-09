"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, Package } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";
import { BrandMark } from "@/components/branding/BrandMark";

// Thin shell for the read-only customer portal. Deliberately minimal — a brand
// header, the signed-in customer's name, and sign-out. No admin nav/chrome ever
// renders here (the dashboard shell is a separate subtree).
export function CustomerShell({ children }: { children: React.ReactNode }) {
  const { customer, logout } = useAuth();
  const { brandName } = useBranding();
  const router = useRouter();

  const handleSignOut = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <BrandMark className="h-9 w-9 rounded-xl text-lg shadow-md accent-glow select-none" />
            <div className="leading-tight">
              <h1 className="text-sm font-extrabold tracking-tight text-[var(--ink)]">
                {brandName}
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--faint)]">
                Customer Portal
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {customer && (
              <div className="hidden text-right leading-tight sm:block">
                <span className="block text-xs font-extrabold text-[var(--ink)]">
                  {customer.name}
                </span>
                <span className="block text-[10px] font-mono text-[var(--faint)]">
                  {customer.customerCode}
                </span>
              </div>
            )}
            <button
              onClick={handleSignOut}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mb-6 flex items-center gap-2.5">
          <Package className="h-5 w-5 text-[var(--accent)]" />
          <h2 className="text-lg font-extrabold tracking-tight text-[var(--ink)]">My Stock</h2>
        </div>
        {children}
      </main>
    </div>
  );
}
