"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";
import { BrandMark } from "@/components/branding/BrandMark";
import { AccountPanel } from "@/components/account/AccountPanel";
import { SetPasswordScreen } from "@/components/account/SetPasswordScreen";

// The staff portal — the home for staff users without dashboard access. It does
// two things only:
//   1. First-login forced password set (SetPasswordScreen) for any staff user
//      whose password hasn't been set yet.
//   2. Otherwise, a standalone home: a welcome card + their account panel
//      (profile, password, sessions). Permissioned staff manage their account at
//      /dashboard/account instead — inside the dashboard chrome.
export default function PortalPage() {
  const { user, logout } = useAuth();
  const { brandName } = useBranding();
  const router = useRouter();

  // AuthGuard (requireType="user") guarantees a staff principal before this renders.
  if (!user) return null;

  if (user.mustResetPassword) return <SetPasswordScreen />;

  const signOut = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:px-8">
        <div className="flex items-center gap-3">
          <BrandMark className="h-9 w-9 rounded-xl text-lg shadow-md accent-glow select-none" />
          <span className="text-base font-extrabold tracking-tight">{brandName}</span>
        </div>
        <button
          onClick={signOut}
          className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs">
          <h1 className="text-2xl font-extrabold tracking-tight">Welcome, {user.firstName}.</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            You&apos;re signed in to {brandName}. Your workspace is being set up — the tools for
            your role will appear here as they go live. In the meantime, you can manage your
            account below.
          </p>
        </section>

        <AccountPanel />
      </main>
    </div>
  );
}
