import { AuthGuard } from "@/components/auth/AuthGuard";
import { FirstLoginGate } from "@/components/auth/FirstLoginGate";
import { AttentionProvider } from "@/providers/AttentionProvider";
import { DashboardProvider } from "@/providers/DashboardProvider";
import { FileDragProvider } from "@/providers/FileDragProvider";
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
      {/* Outside AuthGuard so the guard is armed for the whole authenticated area from the first
          paint, including the skeleton: a file dropped on a page that is still loading would
          otherwise navigate the tab away exactly as it used to. It renders nothing and listens on
          the window, so it costs one effect for the session. */}
      <FileDragProvider>
        <AuthGuard fallback={<DashboardShellSkeleton />}>
          <FirstLoginGate>
            {/* Inside AuthGuard so it never fetches before there's a principal, and outside the shell
              so the sidebar, the Overview strip and every module tab share ONE /attention call. */}
            <AttentionProvider>
              <DashboardShell>{children}</DashboardShell>
            </AttentionProvider>
          </FirstLoginGate>
        </AuthGuard>
      </FileDragProvider>
    </DashboardProvider>
  );
}
