import { AuthGuard } from "@/components/auth/AuthGuard";
import { FirstLoginGate } from "@/components/auth/FirstLoginGate";
import { DashboardProvider } from "@/providers/DashboardProvider";
import { DashboardShell } from "@/components/dashboard/shell/DashboardShell";
import { DashboardShellSkeleton } from "@/components/dashboard/shell/DashboardShellSkeleton";

// Shared shell + state for every /dashboard/* route.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Every authenticated principal enters the same shell — the super-admin and any
  // staff user, regardless of permissions. AuthGuard sends unauthenticated visitors
  // to /login (and never flashes the chrome). FirstLoginGate then forces a staff
  // user who hasn't set their password onto the set-password screen first. Per-
  // section access is enforced inside the shell (filtered nav + page guards), and a
  // user with no sections lands on the no-access home.
  return (
    <DashboardProvider>
      <AuthGuard fallback={<DashboardShellSkeleton />}>
        <FirstLoginGate>
          <DashboardShell>{children}</DashboardShell>
        </FirstLoginGate>
      </AuthGuard>
    </DashboardProvider>
  );
}
